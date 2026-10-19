// CanvasRenderingContext2D over the native CoreGraphics canvas (src/Canvas2D.mm). Drawing is
// encoded into the same command stream as WebGL, so a texture upload from a canvas always sees
// the drawing before it. State is mirrored here for the getters and to skip redundant setters;
// measureText runs natively right away (and is cached), since it needs no drawing.
import { OP, PAINT } from './ops.ts';
import { Q, native } from './native.ts';
import { parseColor, serializeColor } from './color.ts';
import type { RGBA } from './color.ts';
import { F, I, U8, begin, counters, end, isPixelSource, query } from './webgl.ts';
import type { PixelSource } from './webgl.ts';

const N = native;
let selected = 0;
/** Emits C_SELECT when commands start going to another canvas. */
function select(canvasId: number) {
  if (selected === canvasId) return;
  selected = canvasId;
  const p = begin(OP.C_SELECT, 2); I[p + 1] = canvasId; end();
}
export const deselect = (canvasId: number) => { if (selected === canvasId) selected = 0; };

const COMPOSITE = ['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out',
  'destination-atop', 'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];
const ALIGNS = ['start', 'end', 'left', 'right', 'center'];
const BASELINES = ['alphabetic', 'top', 'hanging', 'middle', 'ideographic', 'bottom'];

/** Gradients and patterns live only here: they're sent by value (C_FILL_PAINT / C_STROKE_PAINT)
 *  when they become the fill or stroke style, and again if they change before the next draw, so
 *  the native canvas state owns its copy and nothing needs freeing. `_v` counts changes. */
export class CanvasGradient {
  _kind: number; _a: number[]; _stops: number[] = []; _v = 0;
  constructor(kind: number, a: number[]) { this._kind = kind; this._a = a; }
  addColorStop(offset: number, color: string) {
    const c = parseColor(color);
    if (!c) throw new SyntaxError(`addColorStop: ${color} is not a colour`);
    if (!(offset >= 0 && offset <= 1)) throw new RangeError('addColorStop: offset out of range');
    this._stops.push(offset, c[0], c[1], c[2], c[3]);
    this._v++;
  }
}
export class CanvasPattern {
  _kind = PAINT.pattern; _sourceKind: number; _sourceId: number; _repeat: number; _v = 0;
  constructor(source: PixelSource, repetition: string) {
    this._sourceKind = source._sourceKind; this._sourceId = source._sourceId;
    this._repeat = Math.max(0, ['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].indexOf(repetition || 'repeat'));
  }
  setTransform() {}
}

type PathCommand = [op: number, ...args: number[]];
/** A recorded path, replayed into the native path builder when it is used. */
export class Path2D {
  _cmds: PathCommand[] = [];
  constructor(path?: Path2D | string) {
    if (path instanceof Path2D) this._cmds = path._cmds.slice();
    else if (typeof path === 'string') console.warn('Path2D: SVG path strings are not supported');
  }
  addPath(path: Path2D) { this._cmds.push(...path._cmds); }
  closePath() { this._cmds.push([OP.C_CLOSE_PATH]); }
  moveTo(x: number, y: number) { this._cmds.push([OP.C_MOVE_TO, x, y]); }
  lineTo(x: number, y: number) { this._cmds.push([OP.C_LINE_TO, x, y]); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) { this._cmds.push([OP.C_BEZIER_TO, a, b, c, d, x, y]); }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { this._cmds.push([OP.C_QUAD_TO, a, b, x, y]); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) { this._cmds.push([OP.C_ARC, x, y, r, a0, a1, +ccw]); }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) { this._cmds.push([OP.C_ARC_TO, x1, y1, x2, y2, r]); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false) { this._cmds.push([OP.C_ELLIPSE, x, y, rx, ry, rot, a0, a1, +ccw]); }
  rect(x: number, y: number, w: number, h: number) { this._cmds.push([OP.C_RECT, x, y, w, h]); }
  roundRect(x: number, y: number, w: number, h: number, radii?: number | DOMPointInit | (number | DOMPointInit)[]) { this._cmds.push([OP.C_ROUND_RECT, x, y, w, h, ...cornerRadii(radii)]); }
}

function emitPathCommand(c: PathCommand) {
  const p = begin(c[0], c.length);
  for (let i = 1; i < c.length; i++) F[p + i] = c[i];
  // Booleans (arc's anticlockwise) are read as floats natively too.
  end();
}

/** Canvas roundRect radii as [tlx, tly, trx, try, brx, bry, blx, bly]. */
function cornerRadii(radii?: number | DOMPointInit | (number | DOMPointInit)[]) {
  const list = radii === undefined ? [0] : Array.isArray(radii) ? radii : [radii];
  const xy = list.map((r) => (typeof r === 'number' ? [r, r] : [r.x ?? 0, r.y ?? 0]));
  const [tl, tr, br, bl] = xy.length === 1 ? [xy[0], xy[0], xy[0], xy[0]]
    : xy.length === 2 ? [xy[0], xy[1], xy[0], xy[1]]
      : xy.length === 3 ? [xy[0], xy[1], xy[2], xy[1]]
        : [xy[0], xy[1], xy[2], xy[3]];
  return [...tl, ...tr, ...br, ...bl];
}

type Paint = string | CanvasGradient | CanvasPattern;
interface State {
  fill: Paint; stroke: Paint; lineWidth: number; lineCap: string; lineJoin: string; miterLimit: number;
  dash: number[]; dashOffset: number; alpha: number; composite: string; shadowBlur: number; shadowColor: string;
  shadowX: number; shadowY: number; font: string; fontId: number; textAlign: string; textBaseline: string;
  letterSpacing: string; letterSpacingPx: number; smoothing: boolean; smoothingQuality: string; filter: string;
  direction: string; m: [number, number, number, number, number, number];
  /** The version of a gradient or pattern style last sent (-1 for colours). */
  fillSent: number; strokeSent: number;
}
const defaultState = (): State => ({
  fill: '#000000', stroke: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, dash: [], dashOffset: 0,
  alpha: 1, composite: 'source-over', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowX: 0, shadowY: 0,
  font: '10px sans-serif', fontId: -1, textAlign: 'start', textBaseline: 'alphabetic', letterSpacing: '0px', letterSpacingPx: 0,
  smoothing: true, smoothingQuality: 'low', filter: 'none', direction: 'ltr', m: [1, 0, 0, 1, 0, 0], fillSent: -1, strokeSent: -1,
});

const fontIds = new Map<string, number>();
function fontId(css: string) {
  let idn = fontIds.get(css);
  if (idn === undefined) { idn = N.font(css); fontIds.set(css, idn); }
  return idn;
}
const metricsScratch = new Float64Array(8);
const measured = new Map<string, TextMetricsLite>();

export class TextMetricsLite {
  width: number; actualBoundingBoxLeft: number; actualBoundingBoxRight: number; actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number; fontBoundingBoxAscent: number; fontBoundingBoxDescent: number;
  emHeightAscent: number; emHeightDescent: number; hangingBaseline: number; alphabeticBaseline = 0; ideographicBaseline: number;
  constructor(m: Float64Array) {
    this.width = m[0]; this.actualBoundingBoxLeft = m[1]; this.actualBoundingBoxRight = m[2];
    this.actualBoundingBoxAscent = m[3]; this.actualBoundingBoxDescent = m[4];
    this.fontBoundingBoxAscent = m[5]; this.fontBoundingBoxDescent = m[6];
    this.emHeightAscent = m[5]; this.emHeightDescent = m[6]; this.hangingBaseline = m[5] * 0.8; this.ideographicBaseline = -m[6];
  }
}

export class ImageData {
  readonly width: number; readonly height: number; readonly data: Uint8ClampedArray; readonly colorSpace = 'srgb';
  constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c ?? a.length / 4 / b; }
  }
}

/** What the DOM layer's canvas element gives its 2D context. */
export interface CanvasHost { readonly _sourceId: number; width: number; height: number }

export class CanvasRenderingContext2D {
  readonly canvas: CanvasHost;
  _id: number;
  _s: State = defaultState();
  _stack: State[] = [];

  constructor(canvas: CanvasHost) { this.canvas = canvas; this._id = canvas._sourceId; }

  /** The canvas was resized: its bitmap and state are new. */
  _reset() { this._s = defaultState(); this._stack = []; }

  _op(op: number, words: number) { counters.canvasOps++; if (selected !== this._id) select(this._id); return begin(op, words); }

  save() { this._stack.push({ ...this._s, dash: this._s.dash.slice(), m: [...this._s.m] }); this._op(OP.C_SAVE, 1); end(); }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._s = s;
    this._op(OP.C_RESTORE, 1); end();
  }
  reset() { this._reset(); const p = this._op(OP.C_RESIZE, 3); I[p + 1] = this.canvas.width; I[p + 2] = this.canvas.height; end(); }
  isContextLost() { return false; }
  getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false }; }

  // Transforms
  _matrix(a: number, b: number, c: number, d: number, e: number, f: number, set: boolean) {
    const m = this._s.m;
    if (set) { m[0] = a; m[1] = b; m[2] = c; m[3] = d; m[4] = e; m[5] = f; } else {
      const [ma, mb, mc, md, me, mf] = m;
      m[0] = ma * a + mc * b; m[1] = mb * a + md * b; m[2] = ma * c + mc * d; m[3] = mb * c + md * d;
      m[4] = ma * e + mc * f + me; m[5] = mb * e + md * f + mf;
    }
    const p = this._op(set ? OP.C_SET_TRANSFORM : OP.C_TRANSFORM, 7);
    F[p + 1] = a; F[p + 2] = b; F[p + 3] = c; F[p + 4] = d; F[p + 5] = e; F[p + 6] = f;
    end();
  }
  setTransform(a: number | DOMMatrix2DInit = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    if (typeof a === 'object') { const m = a; this._matrix(m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0, true); return; }
    this._matrix(a, b, c, d, e, f, true);
  }
  resetTransform() { this._matrix(1, 0, 0, 1, 0, 0, true); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) { this._matrix(a, b, c, d, e, f, false); }
  translate(x: number, y: number) { this._matrix(1, 0, 0, 1, x, y, false); }
  scale(x: number, y: number) { this._matrix(x, 0, 0, y, 0, 0, false); }
  rotate(angle: number) { const c = Math.cos(angle), s = Math.sin(angle); this._matrix(c, s, -s, c, 0, 0, false); }
  getTransform() {
    const [a, b, c, d, e, f] = this._s.m;
    return { a, b, c, d, e, f, m11: a, m12: b, m21: c, m22: d, m41: e, m42: f, is2D: true, isIdentity: a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0 };
  }

  // Paint and line state
  _paint(op: number, opPaint: number, v: Paint) {
    if (typeof v === 'string') {
      const c: RGBA | null = parseColor(v);
      if (!c) return false;
      const p = this._op(op, 5); F[p + 1] = c[0]; F[p + 2] = c[1]; F[p + 3] = c[2]; F[p + 4] = c[3]; end();
      return true;
    }
    if (v instanceof CanvasGradient || v instanceof CanvasPattern) { this._sendPaint(opPaint, v); return true; }
    return false;
  }
  /** Layout: kind, 6 floats (gradient geometry), source kind, source id, repetition, stop count,
   *  then offset, r, g, b, a per stop. */
  _sendPaint(op: number, v: CanvasGradient | CanvasPattern) {
    const stops = v instanceof CanvasGradient ? v._stops : [];
    const p = this._op(op, 12 + stops.length);
    I[p + 1] = v._kind;
    for (let i = 0; i < 6; i++) F[p + 2 + i] = v instanceof CanvasGradient ? v._a[i] ?? 0 : 0;
    I[p + 8] = v instanceof CanvasPattern ? v._sourceKind : 0;
    I[p + 9] = v instanceof CanvasPattern ? v._sourceId : 0;
    I[p + 10] = v instanceof CanvasPattern ? v._repeat : 0;
    I[p + 11] = stops.length / 5;
    for (let i = 0; i < stops.length; i++) F[p + 12 + i] = stops[i];
    end();
    if (op === OP.C_FILL_PAINT) this._s.fillSent = v._v; else this._s.strokeSent = v._v;
  }
  /** Before drawing with a gradient that gained stops since it was set, sends it again. */
  _fresh(fill: boolean) {
    const s = this._s, v = fill ? s.fill : s.stroke;
    if (typeof v === 'string' || v._v === (fill ? s.fillSent : s.strokeSent)) return;
    this._sendPaint(fill ? OP.C_FILL_PAINT : OP.C_STROKE_PAINT, v);
  }
  get fillStyle(): Paint { const f = this._s.fill; return typeof f === 'string' ? normalizeColor(f) : f; }
  set fillStyle(v: Paint) {
    if (v === this._s.fill && (typeof v === 'string' || v._v === this._s.fillSent)) return;
    if (this._paint(OP.C_FILL_COLOR, OP.C_FILL_PAINT, v)) this._s.fill = v;
  }
  get strokeStyle(): Paint { const f = this._s.stroke; return typeof f === 'string' ? normalizeColor(f) : f; }
  set strokeStyle(v: Paint) {
    if (v === this._s.stroke && (typeof v === 'string' || v._v === this._s.strokeSent)) return;
    if (this._paint(OP.C_STROKE_COLOR, OP.C_STROKE_PAINT, v)) this._s.stroke = v;
  }
  _f(op: number, v: number) { const p = this._op(op, 2); F[p + 1] = v; end(); }
  _i(op: number, v: number) { const p = this._op(op, 2); I[p + 1] = v; end(); }
  get lineWidth() { return this._s.lineWidth; }
  set lineWidth(v: number) { if (v > 0 && Number.isFinite(v) && v !== this._s.lineWidth) { this._s.lineWidth = v; this._f(OP.C_LINE_WIDTH, v); } }
  get lineCap() { return this._s.lineCap; }
  set lineCap(v: string) { const k = CAPS.indexOf(v); if (k >= 0 && v !== this._s.lineCap) { this._s.lineCap = v; this._i(OP.C_LINE_CAP, k); } }
  get lineJoin() { return this._s.lineJoin; }
  set lineJoin(v: string) { const k = JOINS.indexOf(v); if (k >= 0 && v !== this._s.lineJoin) { this._s.lineJoin = v; this._i(OP.C_LINE_JOIN, k); } }
  get miterLimit() { return this._s.miterLimit; }
  set miterLimit(v: number) { if (v > 0 && v !== this._s.miterLimit) { this._s.miterLimit = v; this._f(OP.C_MITER_LIMIT, v); } }
  getLineDash() { return this._s.dash.slice(); }
  setLineDash(segments: number[]) {
    if (segments.some((x) => !Number.isFinite(x) || x < 0)) return;
    const dash = segments.length % 2 ? [...segments, ...segments] : segments.slice();
    this._s.dash = dash;
    const p = this._op(OP.C_LINE_DASH, 2 + dash.length); I[p + 1] = dash.length;
    for (let i = 0; i < dash.length; i++) F[p + 2 + i] = dash[i];
    end();
  }
  get lineDashOffset() { return this._s.dashOffset; }
  set lineDashOffset(v: number) { if (Number.isFinite(v)) { this._s.dashOffset = v; this._f(OP.C_LINE_DASH_OFFSET, v); } }
  get globalAlpha() { return this._s.alpha; }
  set globalAlpha(v: number) { if (v >= 0 && v <= 1 && v !== this._s.alpha) { this._s.alpha = v; this._f(OP.C_GLOBAL_ALPHA, v); } }
  get globalCompositeOperation() { return this._s.composite; }
  set globalCompositeOperation(v: string) { const k = COMPOSITE.indexOf(v); if (k >= 0 && v !== this._s.composite) { this._s.composite = v; this._i(OP.C_COMPOSITE, k); } }
  get shadowBlur() { return this._s.shadowBlur; }
  set shadowBlur(v: number) { if (v >= 0 && Number.isFinite(v) && v !== this._s.shadowBlur) { this._s.shadowBlur = v; this._f(OP.C_SHADOW_BLUR, v); } }
  get shadowColor() { return normalizeColor(this._s.shadowColor); }
  set shadowColor(v: string) {
    if (v === this._s.shadowColor) return;
    const c = parseColor(v);
    if (!c) return;
    this._s.shadowColor = v;
    const p = this._op(OP.C_SHADOW_COLOR, 5); F[p + 1] = c[0]; F[p + 2] = c[1]; F[p + 3] = c[2]; F[p + 4] = c[3]; end();
  }
  _shadowOffset() { const p = this._op(OP.C_SHADOW_OFFSET, 3); F[p + 1] = this._s.shadowX; F[p + 2] = this._s.shadowY; end(); }
  get shadowOffsetX() { return this._s.shadowX; }
  set shadowOffsetX(v: number) { if (Number.isFinite(v) && v !== this._s.shadowX) { this._s.shadowX = v; this._shadowOffset(); } }
  get shadowOffsetY() { return this._s.shadowY; }
  set shadowOffsetY(v: number) { if (Number.isFinite(v) && v !== this._s.shadowY) { this._s.shadowY = v; this._shadowOffset(); } }
  get imageSmoothingEnabled() { return this._s.smoothing; }
  set imageSmoothingEnabled(v: boolean) { if (!!v !== this._s.smoothing) { this._s.smoothing = !!v; this._i(OP.C_SMOOTHING, +!!v); } }
  get imageSmoothingQuality() { return this._s.smoothingQuality; }
  set imageSmoothingQuality(v: string) { this._s.smoothingQuality = v; }
  get filter() { return this._s.filter; }
  set filter(v: string) {
    if (v === this._s.filter) return;
    this._s.filter = v;
    const blur = /blur\(\s*([\d.]+)px\s*\)/.exec(v);
    this._f(OP.C_FILTER, blur ? parseFloat(blur[1]) : 0);
  }

  // Text state
  get font() { return this._s.font; }
  set font(v: string) {
    if (v === this._s.font) return;
    const f = fontId(v);
    if (f < 0) return;
    this._s.font = v; this._s.fontId = f;
    this._i(OP.C_FONT, f);
  }
  get textAlign() { return this._s.textAlign; }
  set textAlign(v: string) { const k = ALIGNS.indexOf(v); if (k >= 0 && v !== this._s.textAlign) { this._s.textAlign = v; this._i(OP.C_TEXT_ALIGN, k); } }
  get textBaseline() { return this._s.textBaseline; }
  set textBaseline(v: string) { const k = BASELINES.indexOf(v); if (k >= 0 && v !== this._s.textBaseline) { this._s.textBaseline = v; this._i(OP.C_TEXT_BASELINE, k); } }
  get letterSpacing() { return this._s.letterSpacing; }
  set letterSpacing(v: string) {
    if (v === this._s.letterSpacing) return;
    const m = /^\s*(-?[\d.]+)(px|em)?\s*$/.exec(v);
    if (!m) return;
    const px = m[2] === 'em' ? parseFloat(m[1]) * fontSize(this._s.font) : parseFloat(m[1]);
    this._s.letterSpacing = v; this._s.letterSpacingPx = px;
    this._f(OP.C_LETTER_SPACING, px);
  }
  get direction() { return this._s.direction; }
  set direction(v: string) { this._s.direction = v; }
  get fontKerning() { return 'auto'; }
  set fontKerning(_v: string) {}

  _fontId() { const s = this._s; if (s.fontId < 0) { s.fontId = fontId(s.font); this._i(OP.C_FONT, s.fontId); } return s.fontId; }
  measureText(text: string) {
    const f = this._fontId(), ls = this._s.letterSpacingPx;
    const key = `${f}|${ls}|${text}`;
    let m = measured.get(key);
    if (!m) {
      counters.measureMisses++;
      N.measureText(f, String(text), ls, metricsScratch);
      m = new TextMetricsLite(metricsScratch);
      if (measured.size > 4096) measured.clear();
      measured.set(key, m);
    }
    return m;
  }
  _text(op: number, text: string, x: number, y: number, maxWidth?: number) {
    this._fontId();
    this._fresh(op === OP.C_FILL_TEXT);
    counters.strings++;
    const p = this._op(op, 5); I[p + 1] = N.str(String(text)); F[p + 2] = x; F[p + 3] = y; F[p + 4] = maxWidth ?? -1; end();
  }
  fillText(text: string, x: number, y: number, maxWidth?: number) { this._text(OP.C_FILL_TEXT, text, x, y, maxWidth); }
  strokeText(text: string, x: number, y: number, maxWidth?: number) { this._text(OP.C_STROKE_TEXT, text, x, y, maxWidth); }

  // Paths
  beginPath() { this._op(OP.C_BEGIN_PATH, 1); end(); }
  closePath() { this._op(OP.C_CLOSE_PATH, 1); end(); }
  moveTo(x: number, y: number) { const p = this._op(OP.C_MOVE_TO, 3); F[p + 1] = x; F[p + 2] = y; end(); }
  lineTo(x: number, y: number) { const p = this._op(OP.C_LINE_TO, 3); F[p + 1] = x; F[p + 2] = y; end(); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) {
    const p = this._op(OP.C_BEZIER_TO, 7); F[p + 1] = a; F[p + 2] = b; F[p + 3] = c; F[p + 4] = d; F[p + 5] = x; F[p + 6] = y; end();
  }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { const p = this._op(OP.C_QUAD_TO, 5); F[p + 1] = a; F[p + 2] = b; F[p + 3] = x; F[p + 4] = y; end(); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) {
    if (r < 0) throw new RangeError('arc: negative radius');
    const p = this._op(OP.C_ARC, 7); F[p + 1] = x; F[p + 2] = y; F[p + 3] = r; F[p + 4] = a0; F[p + 5] = a1; F[p + 6] = +ccw; end();
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) { const p = this._op(OP.C_ARC_TO, 6); F[p + 1] = x1; F[p + 2] = y1; F[p + 3] = x2; F[p + 4] = y2; F[p + 5] = r; end(); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false) {
    if (rx < 0 || ry < 0) throw new RangeError('ellipse: negative radius');
    const p = this._op(OP.C_ELLIPSE, 9); F[p + 1] = x; F[p + 2] = y; F[p + 3] = rx; F[p + 4] = ry; F[p + 5] = rot; F[p + 6] = a0; F[p + 7] = a1; F[p + 8] = +ccw; end();
  }
  rect(x: number, y: number, w: number, h: number) { const p = this._op(OP.C_RECT, 5); F[p + 1] = x; F[p + 2] = y; F[p + 3] = w; F[p + 4] = h; end(); }
  roundRect(x: number, y: number, w: number, h: number, radii?: number | DOMPointInit | (number | DOMPointInit)[]) {
    const r = cornerRadii(radii);
    const p = this._op(OP.C_ROUND_RECT, 13); F[p + 1] = x; F[p + 2] = y; F[p + 3] = w; F[p + 4] = h;
    for (let i = 0; i < 8; i++) F[p + 5 + i] = r[i];
    end();
  }
  /** Replays a Path2D into the native scratch path (1); returns the path id to draw. */
  _usePath(path?: Path2D | string) {
    if (!(path instanceof Path2D)) return 0;
    const p = this._op(OP.C_PATH_SELECT, 2); I[p + 1] = 1; end();
    this._op(OP.C_BEGIN_PATH, 1); end();
    for (const c of path._cmds) emitPathCommand(c);
    const q = this._op(OP.C_PATH_SELECT, 2); I[q + 1] = 0; end();
    return 1;
  }
  fill(a?: Path2D | string, b?: string) {
    const rule = (typeof a === 'string' ? a : b) === 'evenodd' ? 1 : 0;
    const path = this._usePath(a);
    this._fresh(true);
    const p = this._op(OP.C_FILL, 3); I[p + 1] = rule; I[p + 2] = path; end();
  }
  stroke(path?: Path2D) { const id = this._usePath(path); this._fresh(false); const p = this._op(OP.C_STROKE, 2); I[p + 1] = id; end(); }
  clip(a?: Path2D | string, b?: string) {
    const rule = (typeof a === 'string' ? a : b) === 'evenodd' ? 1 : 0;
    const path = this._usePath(a);
    const p = this._op(OP.C_CLIP, 3); I[p + 1] = rule; I[p + 2] = path; end();
  }
  isPointInPath() { return false; }
  isPointInStroke() { return false; }
  fillRect(x: number, y: number, w: number, h: number) { this._fresh(true); const p = this._op(OP.C_FILL_RECT, 5); F[p + 1] = x; F[p + 2] = y; F[p + 3] = w; F[p + 4] = h; end(); }
  strokeRect(x: number, y: number, w: number, h: number) { this._fresh(false); const p = this._op(OP.C_STROKE_RECT, 5); F[p + 1] = x; F[p + 2] = y; F[p + 3] = w; F[p + 4] = h; end(); }
  clearRect(x: number, y: number, w: number, h: number) { const p = this._op(OP.C_CLEAR_RECT, 5); F[p + 1] = x; F[p + 2] = y; F[p + 3] = w; F[p + 4] = h; end(); }

  // Paint objects
  createLinearGradient(x0: number, y0: number, x1: number, y1: number) { return new CanvasGradient(PAINT.linear, [x0, y0, x1, y1]); }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) { return new CanvasGradient(PAINT.radial, [x0, y0, r0, x1, y1, r1]); }
  createConicGradient(angle: number, x: number, y: number) { return new CanvasGradient(PAINT.conic, [angle, x, y]); }
  createPattern(source: unknown, repetition: string) { return isPixelSource(source) ? new CanvasPattern(source, repetition) : null; }

  // Images and pixels
  drawImage(src: unknown, a: number, b: number, c?: number, d?: number, e?: number, f?: number, g?: number, h?: number) {
    let source: PixelSource;
    if (isPixelSource(src)) source = src;
    else if (src instanceof ImageData) { this.putImageData(src, a, b); return; } else return;
    const sw = source.width, sh = source.height;
    let sx = 0, sy = 0, sW = sw, sH = sh, dx = a, dy = b, dW = sw, dH = sh;
    if (e !== undefined) { sx = a; sy = b; sW = c ?? 0; sH = d ?? 0; dx = e; dy = f ?? 0; dW = g ?? 0; dH = h ?? 0; } else if (c !== undefined) { dW = c; dH = d ?? 0; }
    if (!sw || !sh) return;
    const p = this._op(OP.C_DRAW_IMAGE, 11);
    I[p + 1] = source._sourceKind; I[p + 2] = source._sourceId;
    F[p + 3] = sx; F[p + 4] = sy; F[p + 5] = sW; F[p + 6] = sH; F[p + 7] = dx; F[p + 8] = dy; F[p + 9] = dW; F[p + 10] = dH;
    end();
  }
  createImageData(a: number | ImageData, b?: number) {
    if (a instanceof ImageData) return new ImageData(a.width, a.height);
    return new ImageData(Math.abs(a), Math.abs(b ?? 0));
  }
  getImageData(x: number, y: number, w: number, h: number) {
    const img = new ImageData(w, h);
    query(Q.getImageData, this._id, x, y, w, h, 0, img.data);
    return img;
  }
  putImageData(img: ImageData, dx: number, dy: number, sx = 0, sy = 0, sw = img.width, sh = img.height) {
    const bytes = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const head = 9, inline = bytes.byteLength <= 64 * 1024;
    const p = this._op(OP.C_PUT_IMAGE_DATA, head + 3 + (inline ? (bytes.byteLength + 3) >> 2 : 0));
    I[p + 1] = img.width; I[p + 2] = img.height; I[p + 3] = dx; I[p + 4] = dy; I[p + 5] = sx; I[p + 6] = sy; I[p + 7] = sw; I[p + 8] = sh;
    const q = p + head;
    I[q + 2] = bytes.byteLength;
    if (inline) { I[q] = 1; I[q + 1] = 0; U8.set(bytes, (q + 3) * 4); } else { I[q] = 2; I[q + 1] = N.block(bytes); }
    end();
  }
  drawFocusIfNeeded() {}
}

function fontSize(css: string) { const m = /([\d.]+)px/.exec(css); return m ? parseFloat(m[1]) : 10; }
function normalizeColor(v: string) { const c = parseColor(v); return c ? serializeColor(c) : v; }

/** Creates, resizes and frees a canvas's native bitmap. */
export const canvasCommands = {
  create(canvasId: number, w: number, h: number) { const p = begin(OP.C_CREATE, 4); I[p + 1] = canvasId; I[p + 2] = w; I[p + 3] = h; end(); },
  resize(canvasId: number, w: number, h: number) { select(canvasId); const p = begin(OP.C_RESIZE, 3); I[p + 1] = w; I[p + 2] = h; end(); },
  destroy(canvasId: number) { deselect(canvasId); const p = begin(OP.C_DESTROY, 2); I[p + 1] = canvasId; end(); },
};
