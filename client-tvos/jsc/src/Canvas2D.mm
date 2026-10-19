// 2D canvases on CoreGraphics: each canvas is a premultiplied RGBA bitmap context whose CTM is
// flipped so y points down, like the canvas. The canvas transform is kept separately and applied
// as paths are built (as the canvas spec does), so fills and clips run in pixel space; strokes,
// gradients, text and images concatenate it for their own drawing.
#import "Canvas2D.h"
#import "generated/ops.h"
#import <Accelerate/Accelerate.h>
#include <algorithm>
#include <array>
#include <cmath>

#define FL(i) (*(const float *)&w[i])

struct Paint {
  int kind = 0;  // ops.ts PAINT: 1 linear, 2 radial, 3 conic, 4 pattern
  float a[6] = {};
  std::vector<std::pair<float, std::array<CGFloat, 4>>> stops;
  CGGradientRef gradient = nullptr;
  int sourceKind = 0, sourceId = 0, repeat = 0;
  ~Paint() { if (gradient) CGGradientRelease(gradient); }
  CGGradientRef cg() {
    if (gradient) return gradient;
    auto sorted = stops;
    std::stable_sort(sorted.begin(), sorted.end(), [](auto &x, auto &y) { return x.first < y.first; });
    std::vector<CGFloat> comps, locs;
    for (auto &s : sorted) { locs.push_back(std::clamp(s.first, 0.f, 1.f)); comps.insert(comps.end(), s.second.begin(), s.second.end()); }
    if (locs.empty()) { locs = { 0 }; comps = { 0, 0, 0, 0 }; }
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    gradient = CGGradientCreateWithColorComponents(cs, comps.data(), locs.data(), locs.size());
    CGColorSpaceRelease(cs);
    return gradient;
  }
};

struct CanvasState {
  CGFloat fill[4] = { 0, 0, 0, 1 }, stroke[4] = { 0, 0, 0, 1 };
  // Gradients and patterns, sent by value with the style (runtime/canvas2d.ts), owned by the state.
  std::shared_ptr<Paint> fillPaint, strokePaint;
  CGFloat lineWidth = 1, miter = 10, dashOffset = 0;
  int cap = 0, join = 0;
  std::vector<CGFloat> dash;
  CGFloat alpha = 1;
  int composite = 0;
  CGFloat shadowBlur = 0, shadowColor[4] = { 0, 0, 0, 0 }, shadowX = 0, shadowY = 0;
  int font = -1, align = 0, baseline = 0;
  CGFloat letterSpacing = 0;
  bool smoothing = true;
  CGAffineTransform m = CGAffineTransformIdentity;
};

struct CanvasSurface {
  int width = 0, height = 0;
  size_t stride = 0;
  uint8_t *data = nullptr;
  CGContextRef ctx = nullptr;
  CanvasState s;
  std::vector<CanvasState> stack;
  CGMutablePathRef path = CGPathCreateMutable();
  CGMutablePathRef scratch = CGPathCreateMutable();
  CGImageRef snapshot = nullptr;  // drawImage / pattern source, until the next change

  ~CanvasSurface() { release(); CGPathRelease(path); CGPathRelease(scratch); }
  void release() {
    if (snapshot) CGImageRelease(snapshot);
    snapshot = nullptr;
    if (ctx) CGContextRelease(ctx);
    ctx = nullptr;
    free(data);
    data = nullptr;
  }
  void allocate(int w, int h) {
    release();
    width = std::max(0, w); height = std::max(0, h);
    stride = (size_t)std::max(1, width) * 4;
    data = (uint8_t *)calloc(stride * std::max(1, height), 1);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    ctx = CGBitmapContextCreate(data, std::max(1, width), std::max(1, height), 8, stride, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(cs);
    CGContextTranslateCTM(ctx, 0, std::max(1, height));
    CGContextScaleCTM(ctx, 1, -1);
    CGContextSaveGState(ctx);  // the base state, under every canvas save()
    s = CanvasState();
    stack.clear();
    CGPathRelease(path);
    path = CGPathCreateMutable();
  }
  void changed() { if (snapshot) { CGImageRelease(snapshot); snapshot = nullptr; } }
  CGImageRef image() {
    if (!snapshot && ctx) snapshot = CGBitmapContextCreateImage(ctx);
    return snapshot;
  }
};

CGImageRef DecodedImage::cgImage() {
  if (image || pixels.empty()) return image;
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CFDataRef data = CFDataCreate(nullptr, pixels.data(), pixels.size());
  CGDataProviderRef provider = CGDataProviderCreateWithCFData(data);
  image = CGImageCreate(width, height, 8, 32, (size_t)width * 4, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big, provider, nullptr, true, kCGRenderingIntentDefault);
  CGDataProviderRelease(provider);
  CFRelease(data);
  CGColorSpaceRelease(cs);
  return image;
}

static const CGBlendMode kBlend[] = {
  kCGBlendModeNormal, kCGBlendModeSourceIn, kCGBlendModeSourceOut, kCGBlendModeSourceAtop, kCGBlendModeDestinationOver,
  kCGBlendModeDestinationIn, kCGBlendModeDestinationOut, kCGBlendModeDestinationAtop, kCGBlendModePlusLighter, kCGBlendModeCopy,
  kCGBlendModeXOR, kCGBlendModeMultiply, kCGBlendModeScreen, kCGBlendModeOverlay, kCGBlendModeDarken, kCGBlendModeLighten,
  kCGBlendModeColorDodge, kCGBlendModeColorBurn, kCGBlendModeHardLight, kCGBlendModeSoftLight, kCGBlendModeDifference,
  kCGBlendModeExclusion, kCGBlendModeHue, kCGBlendModeSaturation, kCGBlendModeColor, kCGBlendModeLuminosity,
};

Canvas2D::Canvas2D() {}
Canvas2D::~Canvas2D() {
  for (auto &[k, v] : surfaces_) delete v;
}

bool Canvas2D::bitmap(int canvas, CanvasBitmap *out) {
  auto it = surfaces_.find(canvas);
  if (it == surfaces_.end() || !it->second->data) return false;
  CanvasSurface *c = it->second;
  out->width = c->width; out->height = c->height; out->stride = c->stride; out->data = c->data;
  return true;
}

void Canvas2D::getImageData(int canvas, int x, int y, int w, int h, uint8_t *out) {
  memset(out, 0, (size_t)w * h * 4);
  auto it = surfaces_.find(canvas);
  if (it == surfaces_.end()) return;
  CanvasSurface *c = it->second;
  for (int r = 0; r < h; r++) {
    int sy = y + r;
    if (sy < 0 || sy >= c->height) continue;
    for (int col = 0; col < w; col++) {
      int sx = x + col;
      if (sx < 0 || sx >= c->width) continue;
      const uint8_t *p = c->data + sy * c->stride + sx * 4;
      uint8_t *d = out + ((size_t)r * w + col) * 4;
      uint8_t a = p[3];
      if (a == 0) { d[0] = d[1] = d[2] = d[3] = 0; continue; }
      d[0] = (uint8_t)std::min(255, (p[0] * 255 + a / 2) / a);
      d[1] = (uint8_t)std::min(255, (p[1] * 255 + a / 2) / a);
      d[2] = (uint8_t)std::min(255, (p[2] * 255 + a / 2) / a);
      d[3] = a;
    }
  }
}

namespace {

/** Alpha, compositing and shadow for the next drawing operation. */
void Prepare(CGContextRef ctx, const CanvasState &s) {
  CGContextSetAlpha(ctx, s.alpha);
  CGContextSetBlendMode(ctx, kBlend[std::clamp(s.composite, 0, 25)]);
  CGContextSetInterpolationQuality(ctx, s.smoothing ? kCGInterpolationDefault : kCGInterpolationNone);
  if (s.shadowColor[3] > 0 && (s.shadowBlur > 0 || s.shadowX != 0 || s.shadowY != 0)) {
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGColorRef color = CGColorCreate(cs, s.shadowColor);
    // Shadow offsets are in the context's base space, where y points up.
    CGContextSetShadowWithColor(ctx, CGSizeMake(s.shadowX, -s.shadowY), s.shadowBlur, color);
    CGColorRelease(color);
    CGColorSpaceRelease(cs);
  } else {
    CGContextSetShadowWithColor(ctx, CGSizeZero, 0, nullptr);
  }
}
bool HasShadow(const CanvasState &s) { return s.shadowColor[3] > 0 && (s.shadowBlur > 0 || s.shadowX != 0 || s.shadowY != 0); }

/** A transparency layer (so a gradient or pattern fill casts one shadow) just big enough for
 *  `bounds` (in the current user space, `scale` device pixels per unit) and its shadow. A layer
 *  over the whole canvas costs a full-canvas composite per shape. */
void BeginShadowLayer(CGContextRef ctx, const CanvasState &s, CGRect bounds, CGFloat scale) {
  CGFloat margin = (s.shadowBlur * 2 + fabs(s.shadowX) + fabs(s.shadowY) + 2) / std::max<CGFloat>(scale, 1e-3);
  CGContextBeginTransparencyLayerWithRect(ctx, CGRectInset(bounds, -margin, -margin), nullptr);
}
CGFloat Scale(const CGAffineTransform &m) { return sqrt(fabs(m.a * m.d - m.b * m.c)); }

void DrawGradient(CGContextRef ctx, Paint *p) {
  const CGGradientDrawingOptions ext = kCGGradientDrawsBeforeStartLocation | kCGGradientDrawsAfterEndLocation;
  if (p->kind == 1) CGContextDrawLinearGradient(ctx, p->cg(), CGPointMake(p->a[0], p->a[1]), CGPointMake(p->a[2], p->a[3]), ext);
  else if (p->kind == 2) CGContextDrawRadialGradient(ctx, p->cg(), CGPointMake(p->a[0], p->a[1]), p->a[2], CGPointMake(p->a[3], p->a[4]), p->a[5], ext);
  else if (p->kind == 3) CGContextDrawConicGradient(ctx, p->cg(), CGPointMake(p->a[1], p->a[2]), p->a[0]);
}

/** Canvas arc: the sweep is clamped to one turn; CoreGraphics's clockwise flag is the canvas's
 *  anticlockwise flag, since angles grow clockwise with y down. */
void AddArc(CGMutablePathRef path, const CGAffineTransform *t, CGFloat x, CGFloat y, CGFloat r, CGFloat a0, CGFloat a1, bool ccw) {
  const CGFloat tau = 2 * M_PI;
  if (!ccw && a1 - a0 >= tau) a1 = a0 + tau;
  else if (ccw && a0 - a1 >= tau) a1 = a0 - tau;
  else {
    // Keep the sweep's direction within one turn, as the canvas does.
    CGFloat d = a1 - a0;
    if (!ccw && d < 0) { d = fmod(d, tau) + tau; a1 = a0 + (d >= tau ? d - tau : d); }
    if (ccw && d > 0) { d = fmod(d, tau) - tau; a1 = a0 + (d <= -tau ? d + tau : d); }
  }
  CGPathAddArc(path, t, x, y, r, a0, a1, ccw);
}

/** A line's glyph outlines, in a y-down space with the origin on the baseline at its start. */
CGPathRef LinePath(CTLineRef line) {
  CGMutablePathRef path = CGPathCreateMutable();
  CFArrayRef runs = CTLineGetGlyphRuns(line);
  for (CFIndex r = 0; r < CFArrayGetCount(runs); r++) {
    CTRunRef run = (CTRunRef)CFArrayGetValueAtIndex(runs, r);
    CTFontRef font = (CTFontRef)CFDictionaryGetValue(CTRunGetAttributes(run), kCTFontAttributeName);
    CFIndex n = CTRunGetGlyphCount(run);
    std::vector<CGGlyph> glyphs(n);
    std::vector<CGPoint> positions(n);
    CTRunGetGlyphs(run, CFRangeMake(0, n), glyphs.data());
    CTRunGetPositions(run, CFRangeMake(0, n), positions.data());
    for (CFIndex i = 0; i < n; i++) {
      CGAffineTransform t = CGAffineTransformMake(1, 0, 0, -1, positions[i].x, -positions[i].y);
      CGPathRef glyph = CTFontCreatePathForGlyph(font, glyphs[i], &t);
      if (glyph) { CGPathAddPath(path, nullptr, glyph); CGPathRelease(glyph); }
    }
  }
  return path;
}

/** C_FILL_PAINT / C_STROKE_PAINT: kind, 6 floats, source kind, source id, repetition, stop count,
 *  then offset, r, g, b, a per stop. */
std::shared_ptr<Paint> ReadPaint(const int32_t *w) {
  auto p = std::make_shared<Paint>();
  p->kind = w[1];
  for (int i = 0; i < 6; i++) p->a[i] = FL(2 + i);
  p->sourceKind = w[8]; p->sourceId = w[9]; p->repeat = w[10];
  for (int i = 0; i < w[11]; i++) {
    const int32_t *q = w + 12 + i * 5;
    p->stops.push_back({ *(const float *)&q[0], { *(const float *)&q[1], *(const float *)&q[2], *(const float *)&q[3], *(const float *)&q[4] } });
  }
  return p;
}

}  // namespace

void Canvas2D::run(int op, const int32_t *w, int words) {
  (void)words;
  if (op == OP_C_CREATE) {
    auto *c = new CanvasSurface();
    c->allocate(w[2], w[3]);
    delete surfaces_[w[1]];
    surfaces_[w[1]] = c;
    return;
  }
  if (op == OP_C_SELECT) {
    selected_ = w[1];
    auto it = surfaces_.find(selected_);
    current_ = it == surfaces_.end() ? nullptr : it->second;
    return;
  }
  if (op == OP_C_DESTROY) {
    auto it = surfaces_.find(w[1]);
    if (it != surfaces_.end()) { if (current_ == it->second) current_ = nullptr; delete it->second; surfaces_.erase(it); }
    return;
  }

  CanvasSurface *c = current_;
  if (!c || !c->ctx) return;
  CGContextRef ctx = c->ctx;
  CanvasState &s = c->s;
  CGMutablePathRef path = pathTarget_ ? c->scratch : c->path;
  const CGAffineTransform *m = &s.m;

  switch (op) {
    case OP_C_RESIZE: c->allocate(w[1], w[2]); break;
    case OP_C_SAVE: c->stack.push_back(s); CGContextSaveGState(ctx); break;
    case OP_C_RESTORE:
      if (!c->stack.empty()) { s = c->stack.back(); c->stack.pop_back(); CGContextRestoreGState(ctx); }
      break;
    case OP_C_SET_TRANSFORM: s.m = CGAffineTransformMake(FL(1), FL(2), FL(3), FL(4), FL(5), FL(6)); break;
    case OP_C_TRANSFORM: s.m = CGAffineTransformConcat(CGAffineTransformMake(FL(1), FL(2), FL(3), FL(4), FL(5), FL(6)), s.m); break;
    case OP_C_FILL_COLOR: s.fillPaint = nullptr; for (int i = 0; i < 4; i++) s.fill[i] = FL(1 + i); break;
    case OP_C_FILL_PAINT: s.fillPaint = ReadPaint(w); break;
    case OP_C_STROKE_COLOR: s.strokePaint = nullptr; for (int i = 0; i < 4; i++) s.stroke[i] = FL(1 + i); break;
    case OP_C_STROKE_PAINT: s.strokePaint = ReadPaint(w); break;
    case OP_C_LINE_WIDTH: s.lineWidth = FL(1); break;
    case OP_C_LINE_CAP: s.cap = w[1]; break;
    case OP_C_LINE_JOIN: s.join = w[1]; break;
    case OP_C_MITER_LIMIT: s.miter = FL(1); break;
    case OP_C_LINE_DASH: s.dash.clear(); for (int i = 0; i < w[1]; i++) s.dash.push_back(FL(2 + i)); break;
    case OP_C_LINE_DASH_OFFSET: s.dashOffset = FL(1); break;
    case OP_C_GLOBAL_ALPHA: s.alpha = FL(1); break;
    case OP_C_COMPOSITE: s.composite = w[1]; break;
    case OP_C_SHADOW_BLUR: s.shadowBlur = FL(1); break;
    case OP_C_SHADOW_COLOR: for (int i = 0; i < 4; i++) s.shadowColor[i] = FL(1 + i); break;
    case OP_C_SHADOW_OFFSET: s.shadowX = FL(1); s.shadowY = FL(2); break;
    case OP_C_FONT: s.font = w[1]; break;
    case OP_C_TEXT_ALIGN: s.align = w[1]; break;
    case OP_C_TEXT_BASELINE: s.baseline = w[1]; break;
    case OP_C_LETTER_SPACING: s.letterSpacing = FL(1); break;
    case OP_C_SMOOTHING: s.smoothing = w[1]; break;
    case OP_C_FILTER: break;

    case OP_C_PATH_SELECT: pathTarget_ = w[1]; break;
    case OP_C_BEGIN_PATH:
      if (pathTarget_) { CGPathRelease(c->scratch); c->scratch = CGPathCreateMutable(); }
      else { CGPathRelease(c->path); c->path = CGPathCreateMutable(); }
      break;
    case OP_C_MOVE_TO: CGPathMoveToPoint(path, m, FL(1), FL(2)); break;
    case OP_C_LINE_TO:
      if (CGPathIsEmpty(path)) CGPathMoveToPoint(path, m, FL(1), FL(2));
      else CGPathAddLineToPoint(path, m, FL(1), FL(2));
      break;
    case OP_C_BEZIER_TO:
      if (CGPathIsEmpty(path)) CGPathMoveToPoint(path, m, FL(1), FL(2));
      CGPathAddCurveToPoint(path, m, FL(1), FL(2), FL(3), FL(4), FL(5), FL(6));
      break;
    case OP_C_QUAD_TO:
      if (CGPathIsEmpty(path)) CGPathMoveToPoint(path, m, FL(1), FL(2));
      CGPathAddQuadCurveToPoint(path, m, FL(1), FL(2), FL(3), FL(4));
      break;
    case OP_C_ARC: AddArc(path, m, FL(1), FL(2), FL(3), FL(4), FL(5), FL(6) != 0); break;
    case OP_C_ELLIPSE: {
      CGAffineTransform t = CGAffineTransformScale(CGAffineTransformRotate(CGAffineTransformTranslate(s.m, FL(1), FL(2)), FL(5)), std::max(FL(3), 1e-6f), std::max(FL(4), 1e-6f));
      AddArc(path, &t, 0, 0, 1, FL(6), FL(7), FL(8) != 0);
      break;
    }
    case OP_C_ARC_TO: {
      // In user space: the current point, mapped back through the transform.
      CGFloat x1 = FL(1), y1 = FL(2), x2 = FL(3), y2 = FL(4), r = FL(5);
      if (CGPathIsEmpty(path)) { CGPathMoveToPoint(path, m, x1, y1); break; }
      CGPoint p0 = CGPointApplyAffineTransform(CGPathGetCurrentPoint(path), CGAffineTransformInvert(s.m));
      CGFloat ax = p0.x - x1, ay = p0.y - y1, bx = x2 - x1, by = y2 - y1;
      CGFloat la = hypot(ax, ay), lb = hypot(bx, by);
      CGFloat cross = ax * by - ay * bx;
      if (la < 1e-9 || lb < 1e-9 || fabs(cross) < 1e-9 || r == 0) { CGPathAddLineToPoint(path, m, x1, y1); break; }
      CGFloat cosT = (ax * bx + ay * by) / (la * lb), theta = acos(std::clamp(cosT, (CGFloat)-1, (CGFloat)1));
      CGFloat d = r / tan(theta / 2);
      CGPoint t1 = CGPointMake(x1 + ax / la * d, y1 + ay / la * d), t2 = CGPointMake(x1 + bx / lb * d, y1 + by / lb * d);
      // The centre is r from both tangent points, on the inside of the corner.
      CGFloat nx = -ay / la, ny = ax / la;
      if (nx * bx + ny * by < 0) { nx = -nx; ny = -ny; }
      CGFloat cx = t1.x + nx * r, cy = t1.y + ny * r;
      CGFloat a0 = atan2(t1.y - cy, t1.x - cx), a1 = atan2(t2.y - cy, t2.x - cx);
      CGPathAddLineToPoint(path, m, t1.x, t1.y);
      CGPathAddArc(path, m, cx, cy, r, a0, a1, cross > 0);
      break;
    }
    case OP_C_RECT: CGPathAddRect(path, m, CGRectMake(FL(1), FL(2), FL(3), FL(4))); break;
    case OP_C_ROUND_RECT: {
      CGFloat x = FL(1), y = FL(2), W = FL(3), H = FL(4);
      CGFloat r[8];
      for (int i = 0; i < 8; i++) r[i] = std::max(0.f, FL(5 + i));
      // Scale the radii down so adjacent corners fit, as the spec does.
      CGFloat f = 1, aw = fabs(W), ah = fabs(H);
      if (r[0] + r[2] > 0) f = std::min(f, aw / (r[0] + r[2]));
      if (r[6] + r[4] > 0) f = std::min(f, aw / (r[6] + r[4]));
      if (r[1] + r[7] > 0) f = std::min(f, ah / (r[1] + r[7]));
      if (r[3] + r[5] > 0) f = std::min(f, ah / (r[3] + r[5]));
      for (CGFloat &v : r) v *= f;
      const CGFloat k = 0.5522847498;
      CGPathMoveToPoint(path, m, x + r[0], y);
      CGPathAddLineToPoint(path, m, x + W - r[2], y);
      CGPathAddCurveToPoint(path, m, x + W - r[2] + r[2] * k, y, x + W, y + r[3] - r[3] * k, x + W, y + r[3]);
      CGPathAddLineToPoint(path, m, x + W, y + H - r[5]);
      CGPathAddCurveToPoint(path, m, x + W, y + H - r[5] + r[5] * k, x + W - r[4] + r[4] * k, y + H, x + W - r[4], y + H);
      CGPathAddLineToPoint(path, m, x + r[6], y + H);
      CGPathAddCurveToPoint(path, m, x + r[6] - r[6] * k, y + H, x, y + H - r[7] + r[7] * k, x, y + H - r[7]);
      CGPathAddLineToPoint(path, m, x, y + r[1]);
      CGPathAddCurveToPoint(path, m, x, y + r[1] - r[1] * k, x + r[0] - r[0] * k, y, x + r[0], y);
      CGPathCloseSubpath(path);
      CGPathMoveToPoint(path, m, x, y);
      break;
    }
    case OP_C_CLOSE_PATH: if (!CGPathIsEmpty(path)) CGPathCloseSubpath(path); break;

    case OP_C_FILL: case OP_C_FILL_RECT: {
      CGPathRef p;
      CGMutablePathRef rect = nullptr;
      bool evenOdd = false;
      if (op == OP_C_FILL_RECT) {
        rect = CGPathCreateMutable();
        CGPathAddRect(rect, m, CGRectMake(FL(1), FL(2), FL(3), FL(4)));
        p = rect;
      } else {
        evenOdd = w[1] == 1;
        p = w[2] ? c->scratch : c->path;
      }
      c->changed();
      CGContextSaveGState(ctx);
      Prepare(ctx, s);
      Paint *paint = s.fillPaint.get();
      if (!paint) {
        CGContextSetRGBFillColor(ctx, s.fill[0], s.fill[1], s.fill[2], s.fill[3]);
        CGContextAddPath(ctx, p);
        if (evenOdd) CGContextEOFillPath(ctx); else CGContextFillPath(ctx);
      } else {
        bool layer = HasShadow(s);
        if (layer) BeginShadowLayer(ctx, s, CGPathGetBoundingBox(p), 1);
        CGContextSaveGState(ctx);
        CGContextAddPath(ctx, p);
        if (evenOdd) CGContextEOClip(ctx); else CGContextClip(ctx);
        CGContextConcatCTM(ctx, s.m);
        if (paint->kind == 4) {
          CGImageRef img = nullptr;
          if (paint->sourceKind == 3) { auto it = surfaces_.find(paint->sourceId); if (it != surfaces_.end()) img = it->second->image(); }
          else if (auto d = gPayloads.image(paint->sourceId)) img = d->cgImage();
          if (img) {
            CGContextTranslateCTM(ctx, 0, CGImageGetHeight(img));
            CGContextScaleCTM(ctx, 1, -1);
            CGContextDrawTiledImage(ctx, CGRectMake(0, 0, CGImageGetWidth(img), CGImageGetHeight(img)), img);
          }
        } else DrawGradient(ctx, paint);
        CGContextRestoreGState(ctx);
        if (layer) CGContextEndTransparencyLayer(ctx);
      }
      CGContextRestoreGState(ctx);
      if (rect) CGPathRelease(rect);
      break;
    }
    case OP_C_STROKE: case OP_C_STROKE_RECT: {
      CGMutablePathRef owned = nullptr;
      CGPathRef p;
      if (op == OP_C_STROKE_RECT) {
        owned = CGPathCreateMutable();
        CGPathAddRect(owned, m, CGRectMake(FL(1), FL(2), FL(3), FL(4)));
        p = owned;
      } else p = w[1] ? c->scratch : c->path;
      CGAffineTransform inv = CGAffineTransformInvert(s.m);
      CGPathRef user = CGPathCreateCopyByTransformingPath(p, &inv);
      if (!user) { if (owned) CGPathRelease(owned); break; }
      c->changed();
      CGContextSaveGState(ctx);
      Prepare(ctx, s);
      CGContextConcatCTM(ctx, s.m);
      CGContextSetLineWidth(ctx, s.lineWidth);
      CGContextSetLineCap(ctx, (CGLineCap)s.cap);
      CGContextSetLineJoin(ctx, (CGLineJoin)s.join);
      CGContextSetMiterLimit(ctx, s.miter);
      CGContextSetLineDash(ctx, s.dashOffset, s.dash.empty() ? nullptr : s.dash.data(), s.dash.size());
      Paint *paint = s.strokePaint.get();
      CGContextAddPath(ctx, user);
      if (!paint) {
        CGContextSetRGBStrokeColor(ctx, s.stroke[0], s.stroke[1], s.stroke[2], s.stroke[3]);
        CGContextStrokePath(ctx);
      } else {
        bool layer = HasShadow(s);
        if (layer) BeginShadowLayer(ctx, s, CGRectInset(CGPathGetBoundingBox(user), -s.lineWidth, -s.lineWidth), Scale(s.m));
        CGContextReplacePathWithStrokedPath(ctx);
        CGContextClip(ctx);
        if (paint->kind != 4) DrawGradient(ctx, paint);
        if (layer) CGContextEndTransparencyLayer(ctx);
      }
      CGContextRestoreGState(ctx);
      CGPathRelease(user);
      if (owned) CGPathRelease(owned);
      break;
    }
    case OP_C_CLIP: {
      CGContextAddPath(ctx, w[2] ? c->scratch : c->path);
      if (w[1] == 1) CGContextEOClip(ctx); else CGContextClip(ctx);
      break;
    }
    case OP_C_CLEAR_RECT: {
      c->changed();
      CGContextSaveGState(ctx);
      CGContextSetShadowWithColor(ctx, CGSizeZero, 0, nullptr);
      CGContextConcatCTM(ctx, s.m);
      CGContextClearRect(ctx, CGRectMake(FL(1), FL(2), FL(3), FL(4)));
      CGContextRestoreGState(ctx);
      break;
    }
    case OP_C_FILL_TEXT: case OP_C_STROKE_TEXT: {
      std::string utf8 = gPayloads.takeString(w[1]);
      NSString *text = [[NSString alloc] initWithBytes:utf8.data() length:utf8.size() encoding:NSUTF8StringEncoding] ?: @"";
      CTFontRef font = FontRef(s.font);
      NSMutableDictionary *attrs = [NSMutableDictionary dictionaryWithObject:(__bridge id)font forKey:(id)kCTFontAttributeName];
      attrs[(id)kCTForegroundColorFromContextAttributeName] = @YES;
      if (s.letterSpacing != 0) attrs[(id)kCTKernAttributeName] = @(s.letterSpacing);
      NSAttributedString *as = [[NSAttributedString alloc] initWithString:text attributes:attrs];
      CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)as);
      CGFloat ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font);
      CGFloat width = CTLineGetTypographicBounds(line, nullptr, nullptr, nullptr);
      CGFloat x = FL(2), y = FL(3), maxWidth = FL(4);
      CGFloat sx = maxWidth >= 0 && width > maxWidth && width > 0 ? maxWidth / width : 1;
      CGFloat dx = 0, dy = 0;
      switch (s.align) { case 1: case 3: dx = -width * sx; break; case 4: dx = -width * sx / 2; break; }  // end/right, center
      switch (s.baseline) {
        case 1: dy = ascent; break;                       // top
        case 2: dy = ascent * 0.8; break;                 // hanging
        case 3: dy = (ascent - descent) / 2; break;       // middle
        case 4: case 5: dy = -descent; break;             // ideographic, bottom
      }
      c->changed();
      CGContextSaveGState(ctx);
      Prepare(ctx, s);
      CGContextConcatCTM(ctx, s.m);
      CGContextTranslateCTM(ctx, x + dx, y + dy);
      CGContextScaleCTM(ctx, sx, 1);
      CGContextSetTextMatrix(ctx, CGAffineTransformMakeScale(1, -1));
      CGContextSetTextPosition(ctx, 0, 0);
      bool stroke = op == OP_C_STROKE_TEXT;
      Paint *paint = stroke ? s.strokePaint.get() : s.fillPaint.get();
      if (stroke) {
        CGContextSetLineWidth(ctx, s.lineWidth);
        CGContextSetLineJoin(ctx, (CGLineJoin)s.join);
        CGContextSetRGBStrokeColor(ctx, s.stroke[0], s.stroke[1], s.stroke[2], s.stroke[3]);
      } else {
        CGContextSetRGBFillColor(ctx, s.fill[0], s.fill[1], s.fill[2], s.fill[3]);
      }
      if (!paint) {
        CGContextSetTextDrawingMode(ctx, stroke ? kCGTextStroke : kCGTextFill);
        CTLineDraw(line, ctx);
      } else {
        bool layer = HasShadow(s);
        CGPathRef outline = LinePath(line);
        if (layer) BeginShadowLayer(ctx, s, CGRectInset(CGPathGetBoundingBox(outline), -s.lineWidth, -s.lineWidth), Scale(s.m) * sqrt(sx));
        CGContextSaveGState(ctx);
        // Clip to the glyph outlines (kCGTextClip doesn't clip through CTLineDraw).
        CGContextAddPath(ctx, outline);
        CGPathRelease(outline);
        if (stroke) CGContextReplacePathWithStrokedPath(ctx);
        CGContextClip(ctx);
        // Gradients are in the canvas's user space, before this text's own offset.
        CGContextScaleCTM(ctx, 1 / sx, 1);
        CGContextTranslateCTM(ctx, -(x + dx), -(y + dy));
        if (paint->kind != 4) DrawGradient(ctx, paint);
        CGContextRestoreGState(ctx);
        if (layer) CGContextEndTransparencyLayer(ctx);
      }
      CGContextSetTextDrawingMode(ctx, kCGTextFill);
      CGContextRestoreGState(ctx);
      CFRelease(line);
      break;
    }
    case OP_C_DRAW_IMAGE: {
      CGImageRef img = nullptr;
      std::shared_ptr<DecodedImage> keep;
      if (w[1] == 3) {
        auto it = surfaces_.find(w[2]);
        if (it != surfaces_.end()) img = it->second->image();
      } else if ((keep = gPayloads.image(w[2]))) img = keep->cgImage();
      if (!img) break;
      CGFloat sx = FL(3), sy = FL(4), sw = FL(5), sh = FL(6), dx = FL(7), dy = FL(8), dw = FL(9), dh = FL(10);
      CGImageRef sub = nullptr;
      if (sx != 0 || sy != 0 || sw != CGImageGetWidth(img) || sh != CGImageGetHeight(img)) {
        sub = CGImageCreateWithImageInRect(img, CGRectMake(sx, sy, sw, sh));
        if (!sub) break;
      }
      c->changed();
      CGContextSaveGState(ctx);
      Prepare(ctx, s);
      CGContextConcatCTM(ctx, s.m);
      CGContextTranslateCTM(ctx, dx, dy + dh);
      CGContextScaleCTM(ctx, 1, -1);
      CGContextDrawImage(ctx, CGRectMake(0, 0, dw, dh), sub ? sub : img);
      CGContextRestoreGState(ctx);
      if (sub) CGImageRelease(sub);
      break;
    }
    case OP_C_PUT_IMAGE_DATA: {
      int iw = w[1], ih = w[2], dx = w[3], dy = w[4], sx = w[5], sy = w[6], sw = w[7], sh = w[8];
      const int32_t *p = w + 9;
      std::vector<uint8_t> holder;
      const uint8_t *src = nullptr;
      if (p[0] == 1) src = (const uint8_t *)(p + 3);
      else if (p[0] == 2) { holder = gPayloads.takeBlock(p[1]); src = holder.data(); }
      if (!src) break;
      c->changed();
      for (int r = std::max(0, sy); r < std::min(ih, sy + sh); r++) {
        int ty = dy + r;
        if (ty < 0 || ty >= c->height) continue;
        for (int col = std::max(0, sx); col < std::min(iw, sx + sw); col++) {
          int tx = dx + col;
          if (tx < 0 || tx >= c->width) continue;
          const uint8_t *q = src + ((size_t)r * iw + col) * 4;
          uint8_t *d = c->data + ty * c->stride + tx * 4;
          unsigned a = q[3];
          d[0] = (uint8_t)((q[0] * a + 127) / 255); d[1] = (uint8_t)((q[1] * a + 127) / 255); d[2] = (uint8_t)((q[2] * a + 127) / 255); d[3] = (uint8_t)a;
        }
      }
      break;
    }
    default:
      HostLog(2, [NSString stringWithFormat:@"unknown canvas op %d", op]);
  }
}
