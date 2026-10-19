// The WebGL 2 half of the command executor: OpenGL ES 3.0 calls for the GL commands in
// ../runtime/ops.ts. WebGL's default framebuffer is an FBO here (multisampled when antialiased),
// resolved into the layer's renderbuffer and presented on PRESENT.
#import "Executor.h"
#import "Canvas2D.h"
#import "generated/ops.h"
#import <Accelerate/Accelerate.h>
#include <cmath>

#define FL(i) (*(const float *)&w[i])
#define CHECK(name) do { if (checkErrors_) { GLenum e = glGetError(); if (e) HostLog(2, [NSString stringWithFormat:@"GL error 0x%x after %s", e, name]); } } while (0)

// WebGL-only enums.
enum { UNPACK_FLIP_Y_WEBGL = 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241, UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243,
       WEBGL_DEPTH_STENCIL = 0x84F9, WEBGL_COLOR = 0x1800, WEBGL_DEPTH = 0x1801, WEBGL_STENCIL = 0x1802 };
// Payload kinds (ops.ts PAYLOAD) and TEX_IMAGE variants (ops.ts TEX).
enum { P_NONE = 0, P_INLINE = 1, P_BLOCK = 2, P_CANVAS = 3, P_IMAGE = 4, P_PBO = 5 };
enum { T_IMAGE2D, T_SUB2D, T_IMAGE3D, T_SUB3D, T_COMP2D, T_COMPSUB2D, T_COMP3D, T_COMPSUB3D };
enum { K_BUFFER = 1, K_TEXTURE, K_PROGRAM, K_SHADER, K_VAO, K_FRAMEBUFFER, K_RENDERBUFFER, K_SAMPLER, K_QUERY };
// Query kinds (native.ts Q).
enum { Q_PARAM = 1, Q_ERROR, Q_SHADER, Q_SHADER_LOG, Q_PROGRAM, Q_READ_PIXELS, Q_BUFFER_SUB_DATA, Q_IMAGE_DATA,
       Q_FB_STATUS, Q_IS_ENABLED, Q_FINISH, Q_INTERNALFORMAT, Q_TEX_PARAM, Q_GL_INFO, Q_FRAME_STATS };

static int Components(GLenum format) {
  switch (format) {
    case GL_RED: case GL_RED_INTEGER: case GL_ALPHA: case GL_LUMINANCE: case GL_DEPTH_COMPONENT: return 1;
    case GL_RG: case GL_RG_INTEGER: case GL_LUMINANCE_ALPHA: case GL_DEPTH_STENCIL: return 2;
    case GL_RGB: case GL_RGB_INTEGER: return 3;
    default: return 4;
  }
}
static int BytesPerPixel(GLenum format, GLenum type) {
  switch (type) {
    case GL_UNSIGNED_BYTE: case GL_BYTE: return Components(format);
    case GL_UNSIGNED_SHORT: case GL_SHORT: case GL_HALF_FLOAT: case 0x8D61 /* HALF_FLOAT_OES */: return 2 * Components(format);
    case GL_UNSIGNED_INT: case GL_INT: case GL_FLOAT: return 4 * Components(format);
    case GL_UNSIGNED_SHORT_5_6_5: case GL_UNSIGNED_SHORT_4_4_4_4: case GL_UNSIGNED_SHORT_5_5_5_1: return 2;
    case GL_FLOAT_32_UNSIGNED_INT_24_8_REV: return 8;
    default: return 4;
  }
}

Executor::Executor(DisplayTarget *display, bool gpuTiming, bool checkErrors)
    : display_(display), gpuTiming_(gpuTiming), checkErrors_(checkErrors), canvas_(new Canvas2D()) {
  names_.resize(1024);
}
Executor::~Executor() { delete canvas_; }

void Executor::makeCurrent() {
  if (!context_) {
    context_ = [[EAGLContext alloc] initWithAPI:kEAGLRenderingAPIOpenGLES3];
    if (!context_) HostLog(2, @"OpenGL ES 3 is unavailable");
  }
  if ([EAGLContext currentContext] != context_) [EAGLContext setCurrentContext:context_];
}

void Executor::setName(int jsId, GLuint glName) {
  if (jsId <= 0) return;
  if ((size_t)jsId >= names_.size()) names_.resize(std::max<size_t>(jsId + 1, names_.size() * 2));
  names_[jsId] = glName;
}

bool Executor::canvasBitmap(int canvas, CanvasBitmap *out) { return canvas_->bitmap(canvas, out); }

void Executor::run(const int32_t *w, int count) {
  double t0 = NowMs();
  int i = 0;
  while (i < count) {
    uint32_t head = (uint32_t)w[i];
    int op = head & 0xffff, words = head >> 16;
    if (words <= 0 || i + words > count) {
      HostLog(2, [NSString stringWithFormat:@"command stream corrupt at %d of %d (op %d, %d words)", i, count, op, words]);
      break;
    }
    if (op >= 200) canvas_->run(op, w + i, words);
    else runGL(op, w + i, words);
    if (checkErrors_ && op < 200) {
      GLenum e = glGetError();
      if (e) HostLog(2, [NSString stringWithFormat:@"GL error 0x%x after %s", e, op < (int)(sizeof(kOpNames) / sizeof(*kOpNames)) ? kOpNames[op] : "?"]);
    }
    i += words;
  }
  frameExecMs_ += NowMs() - t0;
  frameWords_ += count;
}

void Executor::endFrame(uint64_t frame) {
  double gpuMs = -1;
  if (gpuTiming_) {
    double t = NowMs();
    glFinish();
    gpuMs = NowMs() - t;
  }
  gFrameStats.executed(frame, frameExecMs_, gpuMs, frameWords_);
  frameExecMs_ = 0;
  frameWords_ = 0;
}

const uint8_t *Executor::payload(const int32_t *p, std::vector<uint8_t> &holder, size_t *length) {
  int kind = p[0];
  *length = (size_t)p[2];
  if (kind == P_INLINE) return (const uint8_t *)(p + 3);
  if (kind == P_BLOCK) { holder = gPayloads.takeBlock(p[1]); *length = holder.size(); return holder.data(); }
  return nullptr;
}

// ---------------------------------------------------------------------------------------------
// Default framebuffer and presenting

void Executor::resizeDefault(int w, int h, bool antialias, bool depth, bool stencil, bool alpha) {
  (void)alpha;
  if (w == width_ && h == height_ && displayFBO_) return;
  width_ = w; height_ = h; hasDepth_ = depth; hasStencil_ = stencil;
  DisplayTarget *display = display_;
  dispatch_sync(dispatch_get_main_queue(), ^{ [display layoutForCanvasWidth:w height:h]; });
  GLuint del[] = { displayRB_, displayDepthRB_, msaaColorRB_, msaaDepthRB_ };
  glDeleteRenderbuffers(4, del);
  GLuint fbs[] = { displayFBO_, msaaFBO_ };
  glDeleteFramebuffers(2, fbs);
  displayRB_ = displayDepthRB_ = msaaColorRB_ = msaaDepthRB_ = displayFBO_ = msaaFBO_ = 0;

  glGenFramebuffers(1, &displayFBO_);
  glBindFramebuffer(GL_FRAMEBUFFER, displayFBO_);
  glGenRenderbuffers(1, &displayRB_);
  glBindRenderbuffer(GL_RENDERBUFFER, displayRB_);
  if (![context_ renderbufferStorage:GL_RENDERBUFFER fromDrawable:display_.layer]) HostLog(2, @"renderbufferStorage:fromDrawable: failed");
  GLint rw = 0, rh = 0;
  glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH, &rw);
  glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_HEIGHT, &rh);
  if (rw != w || rh != h) HostLog(1, [NSString stringWithFormat:@"display renderbuffer is %dx%d for a %dx%d canvas", rw, rh, w, h]);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, displayRB_);
  GLenum depthFormat = stencil ? GL_DEPTH24_STENCIL8 : GL_DEPTH_COMPONENT24;
  GLenum depthAttachment = stencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT;
  if (antialias) {
    GLint maxSamples = 4;
    glGetIntegerv(GL_MAX_SAMPLES, &maxSamples);
    GLint samples = std::min(4, maxSamples);
    glGenFramebuffers(1, &msaaFBO_);
    glBindFramebuffer(GL_FRAMEBUFFER, msaaFBO_);
    glGenRenderbuffers(1, &msaaColorRB_);
    glBindRenderbuffer(GL_RENDERBUFFER, msaaColorRB_);
    glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, GL_RGBA8, rw, rh);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, msaaColorRB_);
    if (depth || stencil) {
      glGenRenderbuffers(1, &msaaDepthRB_);
      glBindRenderbuffer(GL_RENDERBUFFER, msaaDepthRB_);
      glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, depthFormat, rw, rh);
      glFramebufferRenderbuffer(GL_FRAMEBUFFER, depthAttachment, GL_RENDERBUFFER, msaaDepthRB_);
    }
    defaultFBO_ = msaaFBO_;
  } else {
    if (depth || stencil) {
      glGenRenderbuffers(1, &displayDepthRB_);
      glBindRenderbuffer(GL_RENDERBUFFER, displayDepthRB_);
      glRenderbufferStorage(GL_RENDERBUFFER, depthFormat, rw, rh);
      glFramebufferRenderbuffer(GL_FRAMEBUFFER, depthAttachment, GL_RENDERBUFFER, displayDepthRB_);
    }
    defaultFBO_ = displayFBO_;
  }
  GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  if (status != GL_FRAMEBUFFER_COMPLETE) HostLog(2, [NSString stringWithFormat:@"default framebuffer incomplete: 0x%x", status]);
  HostLog(0, [NSString stringWithFormat:@"default framebuffer %dx%d%s", rw, rh, antialias ? " 4x MSAA" : ""]);
  glClearColor(0, 0, 0, 0);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer(drawFB_));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer(readFB_));
  glBindRenderbuffer(GL_RENDERBUFFER, name(renderbuffer_));
  if (firstResize_) {
    // WebGL starts with the viewport and scissor box at the canvas's size.
    firstResize_ = false;
    glViewport(0, 0, w, h);
    glScissor(0, 0, w, h);
    glEnable(GL_PRIMITIVE_RESTART_FIXED_INDEX);  // always on in WebGL 2
  }
}

void Executor::present() {
  if (!displayFBO_) return;
  if (scissorTest_) glDisable(GL_SCISSOR_TEST);
  if (msaaFBO_) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, msaaFBO_);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, displayFBO_);
    glBlitFramebuffer(0, 0, width_, height_, 0, 0, width_, height_, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    const GLenum discard[] = { GL_COLOR_ATTACHMENT0, GL_DEPTH_ATTACHMENT, GL_STENCIL_ATTACHMENT };
    glInvalidateFramebuffer(GL_READ_FRAMEBUFFER, 3, discard);
  } else if (displayDepthRB_) {
    glBindFramebuffer(GL_FRAMEBUFFER, displayFBO_);
    const GLenum discard[] = { GL_DEPTH_ATTACHMENT, GL_STENCIL_ATTACHMENT };
    glInvalidateFramebuffer(GL_FRAMEBUFFER, 2, discard);
  }
  glBindRenderbuffer(GL_RENDERBUFFER, displayRB_);
  [context_ presentRenderbuffer:GL_RENDERBUFFER];
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer(drawFB_));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer(readFB_));
  glBindRenderbuffer(GL_RENDERBUFFER, name(renderbuffer_));
  if (scissorTest_) glEnable(GL_SCISSOR_TEST);
}

// ---------------------------------------------------------------------------------------------
// Texture uploads

static void FlipRows(uint8_t *data, size_t rowBytes, int rows, int images) {
  std::vector<uint8_t> tmp(rowBytes);
  for (int img = 0; img < images; img++) {
    uint8_t *base = data + (size_t)img * rowBytes * rows;
    for (int y = 0; y < rows / 2; y++) {
      uint8_t *a = base + (size_t)y * rowBytes, *b = base + (size_t)(rows - 1 - y) * rowBytes;
      memcpy(tmp.data(), a, rowBytes); memcpy(a, b, rowBytes); memcpy(b, tmp.data(), rowBytes);
    }
  }
}

/** Converts tightly packed premultiplied RGBA8 into what a WebGL upload asked for. */
static bool ConvertRGBA(std::vector<uint8_t> &px, int w, int h, GLenum format, GLenum type, bool premultiplied) {
  size_t n = (size_t)w * h;
  if (!premultiplied) {
    vImage_Buffer b = { px.data(), (vImagePixelCount)h, (vImagePixelCount)w, (size_t)w * 4 };
    vImageUnpremultiplyData_RGBA8888(&b, &b, kvImageNoFlags);
  }
  if (type == GL_UNSIGNED_BYTE && format == GL_RGBA) return true;
  if (type == GL_UNSIGNED_BYTE) {
    int c = Components(format);
    std::vector<uint8_t> out(n * c);
    for (size_t i = 0; i < n; i++) {
      const uint8_t *s = &px[i * 4];
      uint8_t *d = &out[i * c];
      switch (format) {
        case GL_RGB: d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; break;
        case GL_RG: d[0] = s[0]; d[1] = s[1]; break;
        case GL_RED: case GL_LUMINANCE: d[0] = s[0]; break;
        case GL_ALPHA: d[0] = s[3]; break;
        case GL_LUMINANCE_ALPHA: d[0] = s[0]; d[1] = s[3]; break;
        default: return false;
      }
    }
    px.swap(out);
    return true;
  }
  if ((type == GL_FLOAT || type == GL_HALF_FLOAT) && (format == GL_RGBA || format == GL_RGB)) {
    int c = Components(format);
    std::vector<uint8_t> out(n * c * (type == GL_FLOAT ? 4 : 2));
    for (size_t i = 0; i < n; i++) for (int k = 0; k < c; k++) {
      float v = px[i * 4 + k] / 255.0f;
      if (type == GL_FLOAT) ((float *)out.data())[i * c + k] = v;
      else ((__fp16 *)out.data())[i * c + k] = (__fp16)v;
    }
    px.swap(out);
    return true;
  }
  return false;
}

void Executor::texImage(const int32_t *w) {
  int variant = w[1];
  GLenum target = w[2]; GLint level = w[3]; GLint ifmt = w[4];
  GLint x = w[5], y = w[6], z = w[7]; GLsizei width = w[8], height = w[9], depth = w[10];
  GLint border = w[11]; GLenum format = w[12], type = w[13];
  const int32_t *p = w + 14;
  int kind = p[0];
  std::vector<uint8_t> holder;
  const void *data = nullptr;
  size_t length = 0;
  bool restoreUnpack = false;

  if (kind == P_CANVAS || kind == P_IMAGE) {
    // A canvas or decoded image: copy its pixels tightly packed, then convert.
    int sw = 0, sh = 0;
    if (kind == P_CANVAS) {
      CanvasBitmap bmp;
      if (!canvas_->bitmap(p[1], &bmp)) { HostLog(1, @"texImage: unknown canvas"); return; }
      sw = bmp.width; sh = bmp.height;
      holder.resize((size_t)sw * sh * 4);
      for (int r = 0; r < sh; r++) memcpy(&holder[(size_t)r * sw * 4], bmp.data + (size_t)r * bmp.stride, (size_t)sw * 4);
    } else {
      auto img = gPayloads.image(p[1]);
      if (!img) { HostLog(1, @"texImage: unknown image"); return; }
      sw = img->width; sh = img->height;
      holder = img->pixels;
    }
    width = sw; height = sh; depth = 1;
    if (!ConvertRGBA(holder, sw, sh, format, type, premultiply_)) {
      HostLog(1, [NSString stringWithFormat:@"texImage: can't upload an image as format 0x%x type 0x%x", format, type]);
      return;
    }
    if (flipY_) FlipRows(holder.data(), holder.size() / sh, sh, 1);
    data = holder.data();
    restoreUnpack = true;
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
    if (boundPixelUnpack_) glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
  } else if (kind == P_PBO) {
    data = (const void *)(intptr_t)p[1];
  } else if (kind == P_INLINE || kind == P_BLOCK) {
    data = payload(p, holder, &length);
    bool compressed = variant >= T_COMP2D;
    if (!compressed && (flipY_ || (premultiply_ && format == GL_RGBA && type == GL_UNSIGNED_BYTE))) {
      if (kind == P_INLINE) { holder.assign((const uint8_t *)data, (const uint8_t *)data + length); data = holder.data(); }
      size_t row = (size_t)(unpackRowLength_ ? unpackRowLength_ : width) * BytesPerPixel(format, type);
      row = (row + unpackAlignment_ - 1) / unpackAlignment_ * unpackAlignment_;
      if (premultiply_ && format == GL_RGBA && type == GL_UNSIGNED_BYTE) {
        for (int r = 0; r < height * depth; r++) {
          vImage_Buffer b = { holder.data() + row * r, 1, (vImagePixelCount)width, row };
          if (row * (r + 1) <= holder.size()) vImagePremultiplyData_RGBA8888(&b, &b, kvImageNoFlags);
        }
      }
      if (flipY_ && row * height * depth <= holder.size()) FlipRows(holder.data(), row, height, depth);
    }
  }

  switch (variant) {
    case T_IMAGE2D: glTexImage2D(target, level, ifmt, width, height, border, format, type, data); break;
    case T_SUB2D: glTexSubImage2D(target, level, x, y, width, height, format, type, data); break;
    case T_IMAGE3D: glTexImage3D(target, level, ifmt, width, height, depth, border, format, type, data); break;
    case T_SUB3D: glTexSubImage3D(target, level, x, y, z, width, height, depth, format, type, data); break;
    case T_COMP2D: glCompressedTexImage2D(target, level, ifmt, width, height, border, (GLsizei)length, data); break;
    case T_COMPSUB2D: glCompressedTexSubImage2D(target, level, x, y, width, height, format, (GLsizei)length, data); break;
    case T_COMP3D: glCompressedTexImage3D(target, level, ifmt, width, height, depth, border, (GLsizei)length, data); break;
    case T_COMPSUB3D: glCompressedTexSubImage3D(target, level, x, y, z, width, height, depth, format, (GLsizei)length, data); break;
  }
  if (restoreUnpack) {
    glPixelStorei(GL_UNPACK_ALIGNMENT, unpackAlignment_);
    glPixelStorei(GL_UNPACK_ROW_LENGTH, unpackRowLength_);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS, unpackSkipPixels_);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, unpackSkipRows_);
    if (boundPixelUnpack_) glBindBuffer(GL_PIXEL_UNPACK_BUFFER, name(boundPixelUnpack_));
  }
}

// ---------------------------------------------------------------------------------------------
// GL commands

static GLenum DefaultAttachment(GLenum a) {
  switch (a) {
    case WEBGL_COLOR: case GL_BACK: return GL_COLOR_ATTACHMENT0;
    case WEBGL_DEPTH: return GL_DEPTH_ATTACHMENT;
    case WEBGL_STENCIL: return GL_STENCIL_ATTACHMENT;
    default: return a;
  }
}

void Executor::runGL(int op, const int32_t *w, int words) {
  switch (op) {
    case OP_NOP: break;
    case OP_PRESENT: present(); break;
    case OP_RESIZE_DEFAULT_FB: resizeDefault(w[1], w[2], w[3], w[4], w[5], w[6]); break;
    case OP_FREE_PAYLOAD: break;

    case OP_ACTIVE_TEXTURE: glActiveTexture(w[1]); break;
    case OP_BLEND_COLOR: glBlendColor(FL(1), FL(2), FL(3), FL(4)); break;
    case OP_BLEND_EQUATION: glBlendEquation(w[1]); break;
    case OP_BLEND_EQUATION_SEPARATE: glBlendEquationSeparate(w[1], w[2]); break;
    case OP_BLEND_FUNC: glBlendFunc(w[1], w[2]); break;
    case OP_BLEND_FUNC_SEPARATE: glBlendFuncSeparate(w[1], w[2], w[3], w[4]); break;
    case OP_CLEAR: glClear(w[1]); break;
    case OP_CLEAR_COLOR: glClearColor(FL(1), FL(2), FL(3), FL(4)); break;
    case OP_CLEAR_DEPTH: glClearDepthf(FL(1)); break;
    case OP_CLEAR_STENCIL: glClearStencil(w[1]); break;
    case OP_COLOR_MASK: glColorMask(w[1], w[2], w[3], w[4]); break;
    case OP_CULL_FACE: glCullFace(w[1]); break;
    case OP_DEPTH_FUNC: glDepthFunc(w[1]); break;
    case OP_DEPTH_MASK: glDepthMask(w[1]); break;
    case OP_DEPTH_RANGE: glDepthRangef(FL(1), FL(2)); break;
    case OP_DISABLE: if (w[1] == GL_SCISSOR_TEST) scissorTest_ = false; glDisable(w[1]); break;
    case OP_ENABLE: if (w[1] == GL_SCISSOR_TEST) scissorTest_ = true; glEnable(w[1]); break;
    case OP_FRONT_FACE: glFrontFace(w[1]); break;
    case OP_HINT: glHint(w[1], w[2]); break;
    case OP_LINE_WIDTH: glLineWidth(FL(1)); break;
    case OP_PIXEL_STOREI:
      switch (w[1]) {
        case UNPACK_FLIP_Y_WEBGL: flipY_ = w[2]; break;
        case UNPACK_PREMULTIPLY_ALPHA_WEBGL: premultiply_ = w[2]; break;
        case UNPACK_COLORSPACE_CONVERSION_WEBGL: break;
        default:
          if (w[1] == GL_UNPACK_ALIGNMENT) unpackAlignment_ = w[2];
          else if (w[1] == GL_UNPACK_ROW_LENGTH) unpackRowLength_ = w[2];
          else if (w[1] == GL_UNPACK_IMAGE_HEIGHT) unpackImageHeight_ = w[2];
          else if (w[1] == GL_UNPACK_SKIP_PIXELS) unpackSkipPixels_ = w[2];
          else if (w[1] == GL_UNPACK_SKIP_ROWS) unpackSkipRows_ = w[2];
          else if (w[1] == GL_UNPACK_SKIP_IMAGES) unpackSkipImages_ = w[2];
          glPixelStorei(w[1], w[2]);
      }
      break;
    case OP_POLYGON_OFFSET: glPolygonOffset(FL(1), FL(2)); break;
    case OP_SAMPLE_COVERAGE: glSampleCoverage(FL(1), w[2]); break;
    case OP_SCISSOR: glScissor(w[1], w[2], w[3], w[4]); break;
    case OP_STENCIL_FUNC_SEPARATE: glStencilFuncSeparate(w[1], w[2], w[3], w[4]); break;
    case OP_STENCIL_MASK_SEPARATE: glStencilMaskSeparate(w[1], w[2]); break;
    case OP_STENCIL_OP_SEPARATE: glStencilOpSeparate(w[1], w[2], w[3], w[4]); break;
    case OP_VIEWPORT: glViewport(w[1], w[2], w[3], w[4]); break;
    case OP_FLUSH: glFlush(); break;

    case OP_CREATE: {
      GLuint n = 0;
      switch (w[1]) {
        case K_BUFFER: glGenBuffers(1, &n); break;
        case K_TEXTURE: glGenTextures(1, &n); break;
        case K_PROGRAM: n = glCreateProgram(); break;
        case K_SHADER: n = glCreateShader(w[3]); shaderTypes_[w[2]] = w[3]; break;
        case K_VAO: glGenVertexArrays(1, &n); break;
        case K_FRAMEBUFFER: glGenFramebuffers(1, &n); break;
        case K_RENDERBUFFER: glGenRenderbuffers(1, &n); break;
        case K_SAMPLER: glGenSamplers(1, &n); break;
        case K_QUERY: glGenQueries(1, &n); break;
      }
      setName(w[2], n);
      break;
    }
    case OP_DELETE: {
      GLuint n = name(w[2]);
      if (!n) break;
      switch (w[1]) {
        case K_BUFFER: glDeleteBuffers(1, &n); break;
        case K_TEXTURE: glDeleteTextures(1, &n); break;
        case K_PROGRAM: glDeleteProgram(n); break;
        case K_SHADER: glDeleteShader(n); break;
        case K_VAO: glDeleteVertexArrays(1, &n); break;
        case K_FRAMEBUFFER:
          glDeleteFramebuffers(1, &n);
          if (drawFB_ == w[2]) drawFB_ = 0;
          if (readFB_ == w[2]) readFB_ = 0;
          break;
        case K_RENDERBUFFER: glDeleteRenderbuffers(1, &n); if (renderbuffer_ == w[2]) renderbuffer_ = 0; break;
        case K_SAMPLER: glDeleteSamplers(1, &n); break;
        case K_QUERY: glDeleteQueries(1, &n); break;
      }
      setName(w[2], 0);
      break;
    }
    case OP_BIND_BUFFER:
      if (w[1] == GL_PIXEL_UNPACK_BUFFER) boundPixelUnpack_ = w[2];
      glBindBuffer(w[1], name(w[2]));
      break;
    case OP_BIND_BUFFER_BASE: glBindBufferBase(w[1], w[2], name(w[3])); break;
    case OP_BIND_BUFFER_RANGE: glBindBufferRange(w[1], w[2], name(w[3]), w[4], w[5]); break;
    case OP_BIND_FRAMEBUFFER:
      if (w[1] == GL_FRAMEBUFFER || w[1] == GL_DRAW_FRAMEBUFFER) drawFB_ = w[2];
      if (w[1] == GL_FRAMEBUFFER || w[1] == GL_READ_FRAMEBUFFER) readFB_ = w[2];
      glBindFramebuffer(w[1], framebuffer(w[2]));
      break;
    case OP_BIND_RENDERBUFFER: renderbuffer_ = w[2]; glBindRenderbuffer(w[1], name(w[2])); break;
    case OP_BIND_SAMPLER: glBindSampler(w[1], name(w[2])); break;
    case OP_BIND_TEXTURE: glBindTexture(w[1], name(w[2])); break;
    case OP_BIND_VERTEX_ARRAY: glBindVertexArray(name(w[1])); break;

    case OP_BUFFER_DATA: {
      std::vector<uint8_t> holder;
      size_t length;
      const uint8_t *data = payload(w + 3, holder, &length);
      glBufferData(w[1], length, data, w[2]);
      break;
    }
    case OP_BUFFER_SUB_DATA: {
      std::vector<uint8_t> holder;
      size_t length;
      const uint8_t *data = payload(w + 3, holder, &length);
      glBufferSubData(w[1], w[2], length, data);
      break;
    }
    case OP_COPY_BUFFER_SUB_DATA: glCopyBufferSubData(w[1], w[2], w[3], w[4], w[5]); break;

    case OP_SHADER_SOURCE: {
      std::string src = gPayloads.takeString(w[2]);
      const char *s = src.c_str();
      GLint len = (GLint)src.size();
      glShaderSource(name(w[1]), 1, &s, &len);
      break;
    }
    case OP_COMPILE_SHADER: glCompileShader(name(w[1])); break;
    case OP_ATTACH_SHADER: glAttachShader(name(w[1]), name(w[2])); break;
    case OP_DETACH_SHADER: glDetachShader(name(w[1]), name(w[2])); break;
    case OP_LINK_PROGRAM: glLinkProgram(name(w[1])); break;
    case OP_USE_PROGRAM: glUseProgram(name(w[1])); break;
    case OP_BIND_ATTRIB_LOCATION: {
      std::string s = gPayloads.takeString(w[3]);
      glBindAttribLocation(name(w[1]), w[2], s.c_str());
      break;
    }
    case OP_UNIFORM_BLOCK_BINDING: glUniformBlockBinding(name(w[1]), w[2], w[3]); break;

    case OP_UNIFORM_1F: glUniform1f(w[1], FL(2)); break;
    case OP_UNIFORM_2F: glUniform2f(w[1], FL(2), FL(3)); break;
    case OP_UNIFORM_3F: glUniform3f(w[1], FL(2), FL(3), FL(4)); break;
    case OP_UNIFORM_4F: glUniform4f(w[1], FL(2), FL(3), FL(4), FL(5)); break;
    case OP_UNIFORM_1I: glUniform1i(w[1], w[2]); break;
    case OP_UNIFORM_2I: glUniform2i(w[1], w[2], w[3]); break;
    case OP_UNIFORM_3I: glUniform3i(w[1], w[2], w[3], w[4]); break;
    case OP_UNIFORM_4I: glUniform4i(w[1], w[2], w[3], w[4], w[5]); break;
    case OP_UNIFORM_1UI: glUniform1ui(w[1], w[2]); break;
    case OP_UNIFORM_2UI: glUniform2ui(w[1], w[2], w[3]); break;
    case OP_UNIFORM_3UI: glUniform3ui(w[1], w[2], w[3], w[4]); break;
    case OP_UNIFORM_4UI: glUniform4ui(w[1], w[2], w[3], w[4], w[5]); break;
    case OP_UNIFORM_FV: case OP_UNIFORM_IV: case OP_UNIFORM_UIV: {
      GLint loc = w[1], comps = w[2], n = w[3] / std::max(1, w[2]);
      const float *f = (const float *)(w + 4);
      const GLint *iv = (const GLint *)(w + 4);
      if (op == OP_UNIFORM_FV) {
        if (comps == 1) glUniform1fv(loc, n, f); else if (comps == 2) glUniform2fv(loc, n, f);
        else if (comps == 3) glUniform3fv(loc, n, f); else glUniform4fv(loc, n, f);
      } else if (op == OP_UNIFORM_IV) {
        if (comps == 1) glUniform1iv(loc, n, iv); else if (comps == 2) glUniform2iv(loc, n, iv);
        else if (comps == 3) glUniform3iv(loc, n, iv); else glUniform4iv(loc, n, iv);
      } else {
        const GLuint *uv = (const GLuint *)(w + 4);
        if (comps == 1) glUniform1uiv(loc, n, uv); else if (comps == 2) glUniform2uiv(loc, n, uv);
        else if (comps == 3) glUniform3uiv(loc, n, uv); else glUniform4uiv(loc, n, uv);
      }
      break;
    }
    case OP_UNIFORM_MATRIX4: glUniformMatrix4fv(w[1], 1, GL_FALSE, (const float *)(w + 2)); break;
    case OP_UNIFORM_MATRIX3: glUniformMatrix3fv(w[1], 1, GL_FALSE, (const float *)(w + 2)); break;
    case OP_UNIFORM_MATRIX_FV: {
      GLint loc = w[1], cols = w[2], rows = w[3]; GLboolean t = w[4];
      GLsizei n = w[5] / std::max(1, cols * rows);
      const float *f = (const float *)(w + 6);
      if (cols == 2 && rows == 2) glUniformMatrix2fv(loc, n, t, f);
      else if (cols == 3 && rows == 3) glUniformMatrix3fv(loc, n, t, f);
      else if (cols == 4 && rows == 4) glUniformMatrix4fv(loc, n, t, f);
      else if (cols == 2 && rows == 3) glUniformMatrix2x3fv(loc, n, t, f);
      else if (cols == 2 && rows == 4) glUniformMatrix2x4fv(loc, n, t, f);
      else if (cols == 3 && rows == 2) glUniformMatrix3x2fv(loc, n, t, f);
      else if (cols == 3 && rows == 4) glUniformMatrix3x4fv(loc, n, t, f);
      else if (cols == 4 && rows == 2) glUniformMatrix4x2fv(loc, n, t, f);
      else if (cols == 4 && rows == 3) glUniformMatrix4x3fv(loc, n, t, f);
      break;
    }

    case OP_ENABLE_VERTEX_ATTRIB_ARRAY: glEnableVertexAttribArray(w[1]); break;
    case OP_DISABLE_VERTEX_ATTRIB_ARRAY: glDisableVertexAttribArray(w[1]); break;
    case OP_VERTEX_ATTRIB_POINTER: glVertexAttribPointer(w[1], w[2], w[3], w[4], w[5], (const void *)(intptr_t)w[6]); break;
    case OP_VERTEX_ATTRIB_IPOINTER: glVertexAttribIPointer(w[1], w[2], w[3], w[4], (const void *)(intptr_t)w[5]); break;
    case OP_VERTEX_ATTRIB_DIVISOR: glVertexAttribDivisor(w[1], w[2]); break;
    case OP_VERTEX_ATTRIB_4F: glVertexAttrib4f(w[1], FL(2), FL(3), FL(4), FL(5)); break;
    case OP_VERTEX_ATTRIB_I4:
      if (w[6]) glVertexAttribI4ui(w[1], w[2], w[3], w[4], w[5]); else glVertexAttribI4i(w[1], w[2], w[3], w[4], w[5]);
      break;
    case OP_DRAW_ARRAYS: glDrawArrays(w[1], w[2], w[3]); break;
    case OP_DRAW_ELEMENTS: glDrawElements(w[1], w[2], w[3], (const void *)(intptr_t)w[4]); break;
    case OP_DRAW_ARRAYS_INSTANCED: glDrawArraysInstanced(w[1], w[2], w[3], w[4]); break;
    case OP_DRAW_ELEMENTS_INSTANCED: glDrawElementsInstanced(w[1], w[2], w[3], (const void *)(intptr_t)w[4], w[5]); break;
    case OP_DRAW_RANGE_ELEMENTS: glDrawRangeElements(w[1], w[2], w[3], w[4], w[5], (const void *)(intptr_t)w[6]); break;
    case OP_DRAW_BUFFERS: {
      GLenum bufs[16];
      int n = std::min(16, (int)w[1]);
      for (int i = 0; i < n; i++) bufs[i] = drawFB_ ? (GLenum)w[2 + i] : (w[2 + i] == GL_BACK ? GL_COLOR_ATTACHMENT0 : (GLenum)w[2 + i]);
      glDrawBuffers(n, bufs);
      break;
    }

    case OP_TEX_PARAMETERI: glTexParameteri(w[1], w[2], w[3]); break;
    case OP_TEX_PARAMETERF: glTexParameterf(w[1], w[2], FL(3)); break;
    case OP_SAMPLER_PARAMETERI: glSamplerParameteri(name(w[1]), w[2], w[3]); break;
    case OP_SAMPLER_PARAMETERF: glSamplerParameterf(name(w[1]), w[2], FL(3)); break;
    case OP_GENERATE_MIPMAP: glGenerateMipmap(w[1]); break;
    case OP_TEX_STORAGE_2D: glTexStorage2D(w[1], w[2], w[3], w[4], w[5]); break;
    case OP_TEX_STORAGE_3D: glTexStorage3D(w[1], w[2], w[3], w[4], w[5], w[6]); break;
    case OP_TEX_IMAGE: texImage(w); break;
    case OP_COPY_TEX_IMAGE_2D: glCopyTexImage2D(w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8]); break;
    case OP_COPY_TEX_SUB_IMAGE:
      if (w[5] < 0) glCopyTexSubImage2D(w[1], w[2], w[3], w[4], w[6], w[7], w[8], w[9]);
      else glCopyTexSubImage3D(w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], w[9]);
      break;

    case OP_FRAMEBUFFER_RENDERBUFFER: glFramebufferRenderbuffer(w[1], w[2], w[3], name(w[4])); break;
    case OP_FRAMEBUFFER_TEXTURE_2D: glFramebufferTexture2D(w[1], w[2], w[3], name(w[4]), w[5]); break;
    case OP_FRAMEBUFFER_TEXTURE_LAYER: glFramebufferTextureLayer(w[1], w[2], name(w[3]), w[4], w[5]); break;
    case OP_RENDERBUFFER_STORAGE: {
      GLenum fmt = w[3] == WEBGL_DEPTH_STENCIL ? GL_DEPTH24_STENCIL8 : (GLenum)w[3];
      if (w[2] > 0) glRenderbufferStorageMultisample(w[1], w[2], fmt, w[4], w[5]);
      else glRenderbufferStorage(w[1], fmt, w[4], w[5]);
      break;
    }
    case OP_BLIT_FRAMEBUFFER: glBlitFramebuffer(w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], w[9], w[10]); break;
    case OP_INVALIDATE_FRAMEBUFFER: {
      GLenum target = w[1];
      bool isDefault = (target == GL_READ_FRAMEBUFFER ? readFB_ : drawFB_) == 0;
      GLenum atts[16];
      int n = std::min(16, (int)w[2]);
      for (int i = 0; i < n; i++) atts[i] = isDefault ? DefaultAttachment(w[3 + i]) : (GLenum)w[3 + i];
      glInvalidateFramebuffer(target, n, atts);
      break;
    }
    case OP_READ_BUFFER: glReadBuffer(readFB_ ? (GLenum)w[1] : (w[1] == GL_BACK ? GL_COLOR_ATTACHMENT0 : (GLenum)w[1])); break;
    case OP_CLEAR_BUFFERFV: glClearBufferfv(w[1], w[2], (const float *)(w + 3)); break;
    case OP_CLEAR_BUFFERIV: glClearBufferiv(w[1], w[2], (const GLint *)(w + 3)); break;
    case OP_CLEAR_BUFFERUIV: glClearBufferuiv(w[1], w[2], (const GLuint *)(w + 3)); break;
    case OP_CLEAR_BUFFERFI: glClearBufferfi(w[1], w[2], FL(3), w[4]); break;
    case OP_BEGIN_QUERY: glBeginQuery(w[1], name(w[2])); break;
    case OP_END_QUERY: glEndQuery(w[1]); break;
    default:
      HostLog(2, [NSString stringWithFormat:@"unknown GL op %d (%d words)", op, words]);
  }
}

// ---------------------------------------------------------------------------------------------
// Queries

static NSString *JSON(id object) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : @"null";
}

NSString *Executor::programInfo(GLuint program) {
  GLint link = 0, validate = 0, shaders = 0, count = 0, maxLen = 0, logLen = 0;
  glGetProgramiv(program, GL_LINK_STATUS, &link);
  glGetProgramiv(program, GL_VALIDATE_STATUS, &validate);
  glGetProgramiv(program, GL_ATTACHED_SHADERS, &shaders);
  glGetProgramiv(program, GL_INFO_LOG_LENGTH, &logLen);
  std::string log(std::max(1, logLen), '\0');
  glGetProgramInfoLog(program, logLen, nullptr, log.data());
  NSMutableArray *uniforms = [NSMutableArray array], *attribs = [NSMutableArray array], *blocks = [NSMutableArray array];
  if (link) {
    glGetProgramiv(program, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maxLen);
    std::vector<char> nameBuf(std::max(1, maxLen) + 1);
    glGetProgramiv(program, GL_ACTIVE_UNIFORMS, &count);
    for (GLint i = 0; i < count; i++) {
      GLint size = 0; GLenum type = 0; GLsizei len = 0;
      glGetActiveUniform(program, i, (GLsizei)nameBuf.size(), &len, &size, &type, nameBuf.data());
      NSString *uname = [NSString stringWithUTF8String:nameBuf.data()];
      GLint loc = glGetUniformLocation(program, nameBuf.data());
      [uniforms addObject:@{ @"name": uname, @"size": @(size), @"type": @(type), @"loc": @(loc) }];
    }
    glGetProgramiv(program, GL_ACTIVE_ATTRIBUTE_MAX_LENGTH, &maxLen);
    nameBuf.resize(std::max(1, maxLen) + 1);
    glGetProgramiv(program, GL_ACTIVE_ATTRIBUTES, &count);
    for (GLint i = 0; i < count; i++) {
      GLint size = 0; GLenum type = 0; GLsizei len = 0;
      glGetActiveAttrib(program, i, (GLsizei)nameBuf.size(), &len, &size, &type, nameBuf.data());
      GLint loc = glGetAttribLocation(program, nameBuf.data());
      [attribs addObject:@{ @"name": [NSString stringWithUTF8String:nameBuf.data()], @"size": @(size), @"type": @(type), @"loc": @(loc) }];
    }
    glGetProgramiv(program, GL_ACTIVE_UNIFORM_BLOCKS, &count);
    for (GLint i = 0; i < count; i++) {
      char buf[256]; GLsizei len = 0;
      glGetActiveUniformBlockName(program, i, sizeof buf, &len, buf);
      [blocks addObject:@{ @"name": [NSString stringWithUTF8String:buf], @"index": @(i) }];
    }
  }
  return JSON(@{ @"link": @(link != 0), @"validate": @(validate != 0), @"shaders": @(shaders),
                 @"log": [NSString stringWithUTF8String:log.c_str()] ?: @"",
                 @"uniforms": uniforms, @"attribs": attribs, @"blocks": blocks });
}

id Executor::getParameter(GLenum pname) {
  switch (pname) {
    case GL_VIEWPORT: case GL_SCISSOR_BOX: {
      GLint v[4] = {}; glGetIntegerv(pname, v);
      return @[ @(v[0]), @(v[1]), @(v[2]), @(v[3]) ];
    }
    case GL_MAX_VIEWPORT_DIMS: { GLint v[2] = {}; glGetIntegerv(pname, v); return @[ @(v[0]), @(v[1]) ]; }
    case GL_COLOR_CLEAR_VALUE: case GL_BLEND_COLOR: {
      GLfloat v[4] = {}; glGetFloatv(pname, v);
      return @[ @(v[0]), @(v[1]), @(v[2]), @(v[3]) ];
    }
    case GL_DEPTH_RANGE: case GL_ALIASED_LINE_WIDTH_RANGE: case GL_ALIASED_POINT_SIZE_RANGE: {
      GLfloat v[2] = {}; glGetFloatv(pname, v);
      return @[ @(v[0]), @(v[1]) ];
    }
    case GL_COLOR_WRITEMASK: {
      GLboolean v[4] = {}; glGetBooleanv(pname, v);
      return @[ @(v[0]), @(v[1]), @(v[2]), @(v[3]) ];
    }
    case GL_DEPTH_CLEAR_VALUE: case GL_LINE_WIDTH: case GL_POLYGON_OFFSET_FACTOR: case GL_POLYGON_OFFSET_UNITS:
    case GL_SAMPLE_COVERAGE_VALUE: case GL_MAX_TEXTURE_LOD_BIAS: case 0x84FF /* MAX_TEXTURE_MAX_ANISOTROPY_EXT */: {
      GLfloat v = 0; glGetFloatv(pname, &v); return @(v);
    }
    case GL_MAX_ELEMENT_INDEX: case GL_MAX_SERVER_WAIT_TIMEOUT: case GL_MAX_UNIFORM_BLOCK_SIZE:
    case GL_MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: case GL_MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: {
      GLint64 v = 0; glGetInteger64v(pname, &v); return @((double)v);
    }
    default: { GLint v = 0; glGetIntegerv(pname, &v); return @(v); }
  }
}

NSString *Executor::glInfo() {
  NSMutableArray *exts = [NSMutableArray array];
  GLint n = 0;
  glGetIntegerv(GL_NUM_EXTENSIONS, &n);
  for (GLint i = 0; i < n; i++) [exts addObject:[NSString stringWithUTF8String:(const char *)glGetStringi(GL_EXTENSIONS, i)]];
  const GLenum limits[] = {
    GL_MAX_TEXTURE_SIZE, GL_MAX_CUBE_MAP_TEXTURE_SIZE, GL_MAX_RENDERBUFFER_SIZE, GL_MAX_TEXTURE_IMAGE_UNITS,
    GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS, GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS, GL_MAX_VERTEX_ATTRIBS, GL_MAX_VERTEX_UNIFORM_VECTORS,
    GL_MAX_FRAGMENT_UNIFORM_VECTORS, GL_MAX_VARYING_VECTORS, GL_MAX_SAMPLES, GL_MAX_3D_TEXTURE_SIZE, GL_MAX_ARRAY_TEXTURE_LAYERS,
    GL_MAX_DRAW_BUFFERS, GL_MAX_COLOR_ATTACHMENTS, GL_MAX_UNIFORM_BUFFER_BINDINGS, GL_MAX_UNIFORM_BLOCK_SIZE,
    GL_MAX_VERTEX_UNIFORM_BLOCKS, GL_MAX_FRAGMENT_UNIFORM_BLOCKS, GL_MAX_COMBINED_UNIFORM_BLOCKS, GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT,
    GL_MAX_VERTEX_UNIFORM_COMPONENTS, GL_MAX_FRAGMENT_UNIFORM_COMPONENTS, GL_MAX_VARYING_COMPONENTS, GL_MAX_TEXTURE_LOD_BIAS,
    GL_MAX_ELEMENT_INDEX, GL_MAX_ELEMENTS_VERTICES, GL_MAX_ELEMENTS_INDICES, GL_MAX_VIEWPORT_DIMS, GL_ALIASED_LINE_WIDTH_RANGE,
    GL_ALIASED_POINT_SIZE_RANGE, GL_MAX_VERTEX_OUTPUT_COMPONENTS, GL_MAX_FRAGMENT_INPUT_COMPONENTS, GL_MIN_PROGRAM_TEXEL_OFFSET,
    GL_MAX_PROGRAM_TEXEL_OFFSET, GL_SUBPIXEL_BITS, GL_MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, GL_MAX_SERVER_WAIT_TIMEOUT,
    GL_RED_BITS, GL_GREEN_BITS, GL_BLUE_BITS, GL_ALPHA_BITS, GL_DEPTH_BITS, GL_STENCIL_BITS,
  };
  NSMutableDictionary *params = [NSMutableDictionary dictionary];
  for (GLenum p : limits) params[[NSString stringWithFormat:@"%u", p]] = getParameter(p);
  if ([exts containsObject:@"GL_EXT_texture_filter_anisotropic"]) params[@"34047"] = getParameter(0x84FF);
  params[@"32937"] = @(4);  // SAMPLES of the default framebuffer
  params[@"32936"] = @(1);  // SAMPLE_BUFFERS
  NSMutableDictionary *precision = [NSMutableDictionary dictionary];
  for (GLenum shader : { GL_VERTEX_SHADER, GL_FRAGMENT_SHADER })
    for (GLenum prec : { GL_LOW_FLOAT, GL_MEDIUM_FLOAT, GL_HIGH_FLOAT, GL_LOW_INT, GL_MEDIUM_INT, GL_HIGH_INT }) {
      GLint range[2] = {}, p = 0;
      glGetShaderPrecisionFormat(shader, prec, range, &p);
      precision[[NSString stringWithFormat:@"%u,%u", shader, prec]] = @[ @(range[0]), @(range[1]), @(p) ];
    }
  NSString *renderer = [NSString stringWithUTF8String:(const char *)glGetString(GL_RENDERER)];
  NSString *vendor = [NSString stringWithUTF8String:(const char *)glGetString(GL_VENDOR)];
  NSString *version = [NSString stringWithUTF8String:(const char *)glGetString(GL_VERSION)];
  HostLog(0, [NSString stringWithFormat:@"GL: %@ / %@ / %@; %lu extensions: %@", vendor, renderer, version, (unsigned long)exts.count, [exts componentsJoinedByString:@" "]]);
  return JSON(@{ @"version": version, @"renderer": renderer, @"vendor": vendor,
                 @"glsl": [NSString stringWithUTF8String:(const char *)glGetString(GL_SHADING_LANGUAGE_VERSION)],
                 @"extensions": exts, @"params": params, @"precision": precision });
}

id Executor::query(int kind, const double *a, void *out, size_t outLength) {
  switch (kind) {
    case Q_PARAM: return getParameter((GLenum)a[0]);
    case Q_ERROR: return @(glGetError());
    case Q_SHADER: {
      GLuint s = name((int)a[0]);
      GLint ok = 0, len = 0;
      glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
      glGetShaderiv(s, GL_INFO_LOG_LENGTH, &len);
      std::string log(std::max(1, len), '\0');
      glGetShaderInfoLog(s, len, nullptr, log.data());
      return JSON(@{ @"compiled": @(ok != 0), @"log": [NSString stringWithUTF8String:log.c_str()] ?: @"" });
    }
    case Q_PROGRAM: {
      GLuint p = name((int)a[0]);
      if (a[1] == 1) {  // one uniform location by name
        std::string uname = gPayloads.takeString((int)a[2]);
        return @(glGetUniformLocation(p, uname.c_str()));
      }
      return programInfo(p);
    }
    case Q_READ_PIXELS: {
      GLint x = a[0], y = a[1]; GLsizei w = a[2], h = a[3]; GLenum format = a[4], type = a[5];
      size_t need = (size_t)w * h * BytesPerPixel(format, type);
      if (!out || outLength < need) return @(0);
      bool resolve = readFB_ == 0 && msaaFBO_;
      if (resolve) {
        // The multisampled default framebuffer can't be read: resolve it into the display's first.
        glBindFramebuffer(GL_READ_FRAMEBUFFER, msaaFBO_);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, displayFBO_);
        if (scissorTest_) glDisable(GL_SCISSOR_TEST);
        glBlitFramebuffer(0, 0, width_, height_, 0, 0, width_, height_, GL_COLOR_BUFFER_BIT, GL_NEAREST);
        if (scissorTest_) glEnable(GL_SCISSOR_TEST);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, displayFBO_);
      }
      glPixelStorei(GL_PACK_ALIGNMENT, 1);
      glReadPixels(x, y, w, h, format, type, out);
      if (resolve) {
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer(drawFB_));
        glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer(readFB_));
      }
      return @(1);
    }
    case Q_BUFFER_SUB_DATA: {
      GLenum target = a[0]; GLintptr offset = a[1]; GLsizeiptr length = a[2];
      void *src = glMapBufferRange(target, offset, length, GL_MAP_READ_BIT);
      if (src && out) memcpy(out, src, std::min((size_t)length, outLength));
      glUnmapBuffer(target);
      return @(src != nullptr);
    }
    case Q_IMAGE_DATA:
      if (out) canvas_->getImageData((int)a[0], (int)a[1], (int)a[2], (int)a[3], (int)a[4], (uint8_t *)out);
      return @(1);
    case Q_FB_STATUS: return @(glCheckFramebufferStatus((GLenum)a[0]));
    case Q_IS_ENABLED: return @(glIsEnabled((GLenum)a[0]));
    case Q_FINISH: glFinish(); return @(1);
    case Q_INTERNALFORMAT: {
      GLint count = 0;
      glGetInternalformativ(a[0], a[1], GL_NUM_SAMPLE_COUNTS, 1, &count);
      std::vector<GLint> v(std::max(1, count));
      if (count) glGetInternalformativ(a[0], a[1], a[2], count, v.data());
      NSMutableArray *r = [NSMutableArray array];
      for (GLint i = 0; i < count; i++) [r addObject:@(v[i])];
      return r;
    }
    case Q_TEX_PARAM: { GLint v = 0; glGetTexParameteriv(a[0], a[1], &v); return @(v); }
    case Q_GL_INFO: return glInfo();
  }
  return @(0);
}
