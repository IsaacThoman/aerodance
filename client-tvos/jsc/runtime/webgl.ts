// WebGL 2 for three.js over the native OpenGL ES 3.0 executor. Every call that returns nothing is
// encoded into a shared command buffer (see ops.ts) and runs later: when the frame ends, when the
// buffer fills, or before a query that needs the GL state (getParameter, readPixels, link status).
// Object handles are numbered here, so creating a buffer or texture never waits for the GPU.
import { GL_CONSTANTS } from './glConstants.ts';
import { KIND, OP, PAYLOAD, TEX } from './ops.ts';
import { Q, native } from './native.ts';

const N = native;
const DIRECT = N.mode === 0;
const views = N.buffers.map((b) => ({ I: new Int32Array(b), F: new Float32Array(b), U8: new Uint8Array(b) }));
/** The current command buffer, as ints, floats and bytes over the same memory. */
export let I = views[0].I, F = views[0].F, U8 = views[0].U8;
let n = 0;
// Headroom so fixed-size commands never straddle the end.
let cap = I.length - 256;
/** Payloads bigger than this go through native.block instead of the command buffer. */
const INLINE_MAX = 64 * 1024;
let commandCount = 0;

/** Submits the buffer so far; at the end of a frame the host also presents. */
export function submit(endOfFrame: boolean) {
  const next = N.submit(n, endOfFrame);
  n = 0;
  const v = views[next];
  I = v.I; F = v.F; U8 = v.U8; cap = I.length - 256;
}
/** Starts a command of `words` words (header included) and returns its index. */
export function begin(op: number, words: number) {
  if (n + words > cap) submit(false);
  const p = n;
  I[p] = op | (words << 16);
  n += words;
  return p;
}
/** Ends a command started with begin(); in direct mode it runs now. */
export function end() { if (DIRECT) submit(false); }
export const commands = () => commandCount;
/** A native query, after everything encoded so far has run. */
export function query(kind: number, a?: number, b?: number, c?: number, d?: number, e?: number, f?: number, out?: ArrayBufferView) {
  submit(false);
  return N.query(kind, a, b, c, d, e, f, out);
}

type View = ArrayBufferView & { length?: number; BYTES_PER_ELEMENT?: number };
const bytesOf = (v: ArrayBufferView | ArrayBuffer, offsetElems = 0, lengthElems?: number) => {
  if (v instanceof ArrayBuffer) return new Uint8Array(v, offsetElems, lengthElems ?? v.byteLength - offsetElems);
  const bpe = (v as View).BYTES_PER_ELEMENT ?? 1;
  const total = v.byteLength / bpe;
  const len = lengthElems || total - offsetElems;
  return new Uint8Array(v.buffer, v.byteOffset + offsetElems * bpe, len * bpe);
};

/** Writes a data payload as [kind, ref, nbytes, inline words...] starting at command index p,
 *  after a header of `head` words; returns the command's total words. */
function beginWithPayload(op: number, head: number, bytes: Uint8Array | null) {
  const nbytes = bytes ? bytes.byteLength : 0;
  const inline = bytes !== null && nbytes <= INLINE_MAX;
  const words = head + 3 + (inline ? (nbytes + 3) >> 2 : 0);
  const p = begin(op, words);
  const q = p + head;
  if (!bytes) { I[q] = PAYLOAD.none; I[q + 1] = 0; I[q + 2] = 0; return p; }
  I[q + 2] = nbytes;
  if (inline) {
    I[q] = PAYLOAD.inline; I[q + 1] = 0;
    U8.set(bytes, (q + 3) * 4);
  } else {
    I[q] = PAYLOAD.block; I[q + 1] = N.block(bytes);
  }
  return p;
}

// Precomputed headers for the hottest commands.
const H = (op: number, words: number) => op | (words << 16);
const H_U1F = H(OP.UNIFORM_1F, 3), H_U2F = H(OP.UNIFORM_2F, 4), H_U3F = H(OP.UNIFORM_3F, 5), H_U4F = H(OP.UNIFORM_4F, 6);
const H_U1I = H(OP.UNIFORM_1I, 3);
const H_M4 = H(OP.UNIFORM_MATRIX4, 18), H_M3 = H(OP.UNIFORM_MATRIX3, 11);
const H_DRAW_E = H(OP.DRAW_ELEMENTS, 5), H_DRAW_A = H(OP.DRAW_ARRAYS, 4);
const H_DRAW_EI = H(OP.DRAW_ELEMENTS_INSTANCED, 6), H_DRAW_AI = H(OP.DRAW_ARRAYS_INSTANCED, 5);
const H_BIND_TEX = H(OP.BIND_TEXTURE, 3), H_BIND_VAO = H(OP.BIND_VERTEX_ARRAY, 2), H_BIND_BUF = H(OP.BIND_BUFFER, 3);
const H_ACTIVE_TEX = H(OP.ACTIVE_TEXTURE, 2), H_USE = H(OP.USE_PROGRAM, 2), H_FRONT = H(OP.FRONT_FACE, 2);
const H_ENABLE = H(OP.ENABLE, 2), H_DISABLE = H(OP.DISABLE, 2);

/** Set when the default framebuffer may have changed this frame (it is presented at frame end). */
export let drawnThisFrame = false;
export const clearDrawn = () => { drawnThisFrame = false; };

// ---------------------------------------------------------------------------------------------
// Objects

let nextId = 1;
class GLObject {
  _id = nextId++;
  _deleted = false;
}
export class WebGLBuffer extends GLObject {}
export class WebGLTexture extends GLObject {}
export class WebGLShader extends GLObject {
  _type = 0;
  _source = '';
  _status: { compiled: boolean; log: string } | null = null;
}
type ProgramInfo = {
  link: boolean; log: string; validate: boolean;
  uniforms: { name: string; size: number; type: number; loc: number }[];
  attribs: { name: string; size: number; type: number; loc: number }[];
  blocks: { name: string; index: number }[];
  shaders: number;
};
export class WebGLProgram extends GLObject {
  _info: ProgramInfo | null = null;
  _locations: Map<string, WebGLUniformLocation | null> | null = null;
  _shaders: WebGLShader[] = [];
}
export class WebGLVertexArrayObject extends GLObject {}
export class WebGLFramebuffer extends GLObject {}
export class WebGLRenderbuffer extends GLObject {}
export class WebGLSampler extends GLObject {}
export class WebGLQuery extends GLObject {}
export class WebGLSync { _signaled = true; }
export class WebGLTransformFeedback extends GLObject {}
export class WebGLUniformLocation {
  _loc: number;
  constructor(loc: number) { this._loc = loc; }
}
export class WebGLActiveInfo {
  name: string; size: number; type: number;
  constructor(name: string, size: number, type: number) { this.name = name; this.size = size; this.type = type; }
}
export class WebGLShaderPrecisionFormat {
  rangeMin: number; rangeMax: number; precision: number;
  constructor(rangeMin: number, rangeMax: number, precision: number) { this.rangeMin = rangeMin; this.rangeMax = rangeMax; this.precision = precision; }
}

const id = (o: GLObject | null | undefined) => (o ? o._id : 0);
function create<T extends GLObject>(o: T, kind: number, arg = 0) {
  const p = begin(OP.CREATE, 4);
  I[p + 1] = kind; I[p + 2] = o._id; I[p + 3] = arg;
  end();
  return o;
}
function destroy(o: GLObject | null | undefined, kind: number) {
  if (!o || o._deleted) return;
  o._deleted = true;
  const p = begin(OP.DELETE, 3);
  I[p + 1] = kind; I[p + 2] = o._id;
  end();
}

// ---------------------------------------------------------------------------------------------
// Image sources: anything a texture can be made from, or drawn on a 2D canvas.

/** What the DOM layer's canvases, images and ImageBitmaps expose to the encoder. */
export interface PixelSource { readonly _sourceKind: number; readonly _sourceId: number; readonly width: number; readonly height: number }
export const isPixelSource = (v: unknown): v is PixelSource => typeof v === 'object' && v !== null && '_sourceKind' in v;
type ImageDataLike = { width: number; height: number; data: Uint8ClampedArray };
const isImageData = (v: unknown): v is ImageDataLike => typeof v === 'object' && v !== null && 'data' in v && (v as ImageDataLike).data instanceof Uint8ClampedArray;

/** Encodes a texture upload. Layout after the header: variant, target, level, internalformat,
 *  xoffset, yoffset, zoffset, width, height, depth, border, format, type, then the payload
 *  (kind, ref, nbytes, inline data). */
function texUpload(variant: number, target: number, level: number, internalformat: number,
  x: number, y: number, z: number, w: number, h: number, d: number, border: number, format: number, type: number,
  src: unknown, srcOffset = 0, srcLength?: number) {
  let p: number;
  const HEAD = 14;
  if (src === null || src === undefined) {
    p = beginWithPayload(OP.TEX_IMAGE, HEAD, null);
  } else if (typeof src === 'number') {
    p = beginWithPayload(OP.TEX_IMAGE, HEAD, null);
    I[p + HEAD] = PAYLOAD.pbo; I[p + HEAD + 1] = src;
  } else if (isPixelSource(src)) {
    p = beginWithPayload(OP.TEX_IMAGE, HEAD, null);
    I[p + HEAD] = src._sourceKind; I[p + HEAD + 1] = src._sourceId;
    if (w < 0) { w = src.width; h = src.height; }
  } else if (isImageData(src)) {
    if (w < 0) { w = src.width; h = src.height; }
    p = beginWithPayload(OP.TEX_IMAGE, HEAD, bytesOf(src.data));
  } else if (ArrayBuffer.isView(src) || src instanceof ArrayBuffer) {
    p = beginWithPayload(OP.TEX_IMAGE, HEAD, bytesOf(src, srcOffset, srcLength));
  } else {
    console.warn('texImage: unsupported source', Object.prototype.toString.call(src));
    return;
  }
  if (w < 0) { w = 0; h = 0; }
  I[p + 1] = variant; I[p + 2] = target; I[p + 3] = level; I[p + 4] = internalformat;
  I[p + 5] = x; I[p + 6] = y; I[p + 7] = z; I[p + 8] = w; I[p + 9] = h; I[p + 10] = d;
  I[p + 11] = border; I[p + 12] = format; I[p + 13] = type;
  end();
}

// ---------------------------------------------------------------------------------------------
// Context

type GLInfo = {
  version: string; renderer: string; vendor: string; glsl: string;
  extensions: string[]; params: Record<string, number | number[]>;
  precision: Record<string, [number, number, number]>;
};
let glInfo: GLInfo | null = null;
const info = () => (glInfo ??= JSON.parse(query(Q.glInfo) as string) as GLInfo);

const C = GL_CONSTANTS;
const EXT = {
  UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246,
  TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  COMPLETION_STATUS_KHR: 0x91b1,
};
// Parameters whose values are arrays in WebGL.
const INT_ARRAY_PARAMS = new Set<number>([C.VIEWPORT, C.SCISSOR_BOX, C.MAX_VIEWPORT_DIMS]);
const FLOAT_ARRAY_PARAMS = new Set<number>([C.ALIASED_LINE_WIDTH_RANGE, C.ALIASED_POINT_SIZE_RANGE, C.DEPTH_RANGE, C.COLOR_CLEAR_VALUE, C.BLEND_COLOR]);
const BOOL_PARAMS = new Set<number>([C.BLEND, C.CULL_FACE, C.DEPTH_TEST, C.DITHER, C.POLYGON_OFFSET_FILL, C.SAMPLE_ALPHA_TO_COVERAGE, C.SAMPLE_COVERAGE, C.SCISSOR_TEST, C.STENCIL_TEST, C.DEPTH_WRITEMASK, C.RASTERIZER_DISCARD, C.UNPACK_FLIP_Y_WEBGL, C.UNPACK_PREMULTIPLY_ALPHA_WEBGL]);

export interface ContextHost {
  canvas: { width: number; height: number };
  attributes: WebGLContextAttributes;
}

export class WebGL2RenderingContext {
  readonly canvas: unknown;
  _host: ContextHost;
  _attrs: Required<Pick<WebGLContextAttributes, 'alpha' | 'antialias' | 'depth' | 'stencil' | 'premultipliedAlpha' | 'preserveDrawingBuffer'>> & WebGLContextAttributes;
  _w = 0;
  _h = 0;
  _error = 0;
  _flipY = false;
  _premultiply = false;
  drawingBufferColorSpace = 'srgb';
  unpackColorSpace = 'srgb';

  constructor(host: ContextHost & { element: unknown }) {
    this._host = host;
    this.canvas = host.element;
    const a = host.attributes;
    this._attrs = {
      alpha: a.alpha ?? true, antialias: a.antialias ?? true, depth: a.depth ?? true, stencil: a.stencil ?? false,
      premultipliedAlpha: a.premultipliedAlpha ?? true, preserveDrawingBuffer: a.preserveDrawingBuffer ?? false,
      powerPreference: a.powerPreference ?? 'default', failIfMajorPerformanceCaveat: false, desynchronized: false,
    };
    this._resize();
  }

  /** The canvas's size changed: reallocate the default framebuffer once the current task is done
   *  (setting width and then height would otherwise reallocate twice). */
  _resizeSoon() {
    if (this._resizeQueued) return;
    this._resizeQueued = true;
    queueMicrotask(() => { this._resizeQueued = false; this._resize(); });
  }
  _resizeQueued = false;
  _resize() {
    const w = Math.max(1, this._host.canvas.width | 0), h = Math.max(1, this._host.canvas.height | 0);
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    const a = this._attrs;
    const p = begin(OP.RESIZE_DEFAULT_FB, 7);
    I[p + 1] = w; I[p + 2] = h; I[p + 3] = +a.antialias; I[p + 4] = +a.depth; I[p + 5] = +a.stencil; I[p + 6] = +a.alpha;
    end();
  }

  get drawingBufferWidth() { return Math.max(1, this._host.canvas.width | 0); }
  get drawingBufferHeight() { return Math.max(1, this._host.canvas.height | 0); }
  getContextAttributes() { return { ...this._attrs }; }
  isContextLost() { return false; }
  makeXRCompatible() { return Promise.resolve(); }

  getSupportedExtensions() {
    return Object.keys(EXTENSIONS).filter((name) => this.getExtension(name) !== null);
  }
  getExtension(name: string): object | null {
    const make = EXTENSIONS[name];
    if (!make) return null;
    const cached = extensionCache.get(name);
    if (cached !== undefined) return cached;
    const ext = make(info().extensions);
    extensionCache.set(name, ext);
    return ext;
  }

  getParameter(pname: number): unknown {
    const i = info();
    switch (pname) {
      case C.VERSION: return 'WebGL 2.0 (OpenGL ES 3.0 aerodance-jsc)';
      case C.SHADING_LANGUAGE_VERSION: return 'WebGL GLSL ES 3.00';
      case C.VENDOR: return 'WebKit';
      case C.RENDERER: return 'WebKit WebGL';
      case EXT.UNMASKED_VENDOR_WEBGL: return i.vendor;
      case EXT.UNMASKED_RENDERER_WEBGL: return i.renderer;
      case C.UNPACK_FLIP_Y_WEBGL: return this._flipY;
      case C.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return this._premultiply;
      case C.UNPACK_COLORSPACE_CONVERSION_WEBGL: return C.BROWSER_DEFAULT_WEBGL;
      // Bindings aren't tracked here; three.js doesn't read them back.
      case C.ARRAY_BUFFER_BINDING: case C.ELEMENT_ARRAY_BUFFER_BINDING: case C.CURRENT_PROGRAM:
      case C.FRAMEBUFFER_BINDING: case C.RENDERBUFFER_BINDING: case C.TEXTURE_BINDING_2D:
      case C.TEXTURE_BINDING_CUBE_MAP: case C.VERTEX_ARRAY_BINDING: case C.READ_FRAMEBUFFER_BINDING:
        return null;
    }
    const known = i.params[pname];
    if (known !== undefined) return wrapParam(pname, known);
    return wrapParam(pname, query(Q.getParameter, pname) as number | number[]);
  }
  getError() { const e = this._error; if (e) { this._error = 0; return e; } return query(Q.getError) as number; }
  getShaderPrecisionFormat(shaderType: number, precisionType: number) {
    const f = info().precision[`${shaderType},${precisionType}`] ?? [127, 127, 23];
    return new WebGLShaderPrecisionFormat(f[0], f[1], f[2]);
  }
  getInternalformatParameter(target: number, internalformat: number, pname: number) {
    const r = query(Q.internalformatParameter, target, internalformat, pname) as number[];
    return new Int32Array(r);
  }
  isEnabled(cap: number) { return !!query(Q.isEnabled, cap); }
  finish() { query(Q.finish); }
  flush() { submit(false); }

  // State
  activeTexture(texture: number) { if (n + 2 > cap) submit(false); I[n] = H_ACTIVE_TEX; I[n + 1] = texture; n += 2; if (DIRECT) submit(false); }
  blendColor(r: number, g: number, b: number, a: number) { const p = begin(OP.BLEND_COLOR, 5); F[p + 1] = r; F[p + 2] = g; F[p + 3] = b; F[p + 4] = a; end(); }
  blendEquation(mode: number) { const p = begin(OP.BLEND_EQUATION, 2); I[p + 1] = mode; end(); }
  blendEquationSeparate(rgb: number, alpha: number) { const p = begin(OP.BLEND_EQUATION_SEPARATE, 3); I[p + 1] = rgb; I[p + 2] = alpha; end(); }
  blendFunc(s: number, d: number) { const p = begin(OP.BLEND_FUNC, 3); I[p + 1] = s; I[p + 2] = d; end(); }
  blendFuncSeparate(sr: number, dr: number, sa: number, da: number) { const p = begin(OP.BLEND_FUNC_SEPARATE, 5); I[p + 1] = sr; I[p + 2] = dr; I[p + 3] = sa; I[p + 4] = da; end(); }
  clear(mask: number) { drawnThisFrame = true; const p = begin(OP.CLEAR, 2); I[p + 1] = mask; end(); }
  clearColor(r: number, g: number, b: number, a: number) { const p = begin(OP.CLEAR_COLOR, 5); F[p + 1] = r; F[p + 2] = g; F[p + 3] = b; F[p + 4] = a; end(); }
  clearDepth(d: number) { const p = begin(OP.CLEAR_DEPTH, 2); F[p + 1] = d; end(); }
  clearStencil(s: number) { const p = begin(OP.CLEAR_STENCIL, 2); I[p + 1] = s; end(); }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean) { const p = begin(OP.COLOR_MASK, 5); I[p + 1] = +r; I[p + 2] = +g; I[p + 3] = +b; I[p + 4] = +a; end(); }
  cullFace(mode: number) { const p = begin(OP.CULL_FACE, 2); I[p + 1] = mode; end(); }
  depthFunc(f: number) { const p = begin(OP.DEPTH_FUNC, 2); I[p + 1] = f; end(); }
  depthMask(flag: boolean) { const p = begin(OP.DEPTH_MASK, 2); I[p + 1] = +flag; end(); }
  depthRange(near: number, far: number) { const p = begin(OP.DEPTH_RANGE, 3); F[p + 1] = near; F[p + 2] = far; end(); }
  disable(c: number) { if (n + 2 > cap) submit(false); I[n] = H_DISABLE; I[n + 1] = c; n += 2; if (DIRECT) submit(false); }
  enable(c: number) { if (n + 2 > cap) submit(false); I[n] = H_ENABLE; I[n + 1] = c; n += 2; if (DIRECT) submit(false); }
  frontFace(mode: number) { if (n + 2 > cap) submit(false); I[n] = H_FRONT; I[n + 1] = mode; n += 2; if (DIRECT) submit(false); }
  hint(target: number, mode: number) { const p = begin(OP.HINT, 3); I[p + 1] = target; I[p + 2] = mode; end(); }
  lineWidth(w: number) { const p = begin(OP.LINE_WIDTH, 2); F[p + 1] = w; end(); }
  pixelStorei(pname: number, param: number | boolean) {
    if (pname === C.UNPACK_FLIP_Y_WEBGL) this._flipY = !!param;
    else if (pname === C.UNPACK_PREMULTIPLY_ALPHA_WEBGL) this._premultiply = !!param;
    const p = begin(OP.PIXEL_STOREI, 3); I[p + 1] = pname; I[p + 2] = +param; end();
  }
  polygonOffset(factor: number, units: number) { const p = begin(OP.POLYGON_OFFSET, 3); F[p + 1] = factor; F[p + 2] = units; end(); }
  sampleCoverage(value: number, invert: boolean) { const p = begin(OP.SAMPLE_COVERAGE, 3); F[p + 1] = value; I[p + 2] = +invert; end(); }
  scissor(x: number, y: number, w: number, h: number) { const p = begin(OP.SCISSOR, 5); I[p + 1] = x; I[p + 2] = y; I[p + 3] = w; I[p + 4] = h; end(); }
  stencilFunc(func: number, ref: number, mask: number) { this.stencilFuncSeparate(C.FRONT_AND_BACK, func, ref, mask); }
  stencilFuncSeparate(face: number, func: number, ref: number, mask: number) { const p = begin(OP.STENCIL_FUNC_SEPARATE, 5); I[p + 1] = face; I[p + 2] = func; I[p + 3] = ref; I[p + 4] = mask; end(); }
  stencilMask(mask: number) { this.stencilMaskSeparate(C.FRONT_AND_BACK, mask); }
  stencilMaskSeparate(face: number, mask: number) { const p = begin(OP.STENCIL_MASK_SEPARATE, 3); I[p + 1] = face; I[p + 2] = mask; end(); }
  stencilOp(fail: number, zfail: number, zpass: number) { this.stencilOpSeparate(C.FRONT_AND_BACK, fail, zfail, zpass); }
  stencilOpSeparate(face: number, fail: number, zfail: number, zpass: number) { const p = begin(OP.STENCIL_OP_SEPARATE, 5); I[p + 1] = face; I[p + 2] = fail; I[p + 3] = zfail; I[p + 4] = zpass; end(); }
  viewport(x: number, y: number, w: number, h: number) { const p = begin(OP.VIEWPORT, 5); I[p + 1] = x; I[p + 2] = y; I[p + 3] = w; I[p + 4] = h; end(); }

  // Objects
  createBuffer() { return create(new WebGLBuffer(), KIND.buffer); }
  createTexture() { return create(new WebGLTexture(), KIND.texture); }
  createProgram() { return create(new WebGLProgram(), KIND.program); }
  createShader(type: number) { const s = new WebGLShader(); s._type = type; return create(s, KIND.shader, type); }
  createVertexArray() { return create(new WebGLVertexArrayObject(), KIND.vertexArray); }
  createFramebuffer() { return create(new WebGLFramebuffer(), KIND.framebuffer); }
  createRenderbuffer() { return create(new WebGLRenderbuffer(), KIND.renderbuffer); }
  createSampler() { return create(new WebGLSampler(), KIND.sampler); }
  createQuery() { return create(new WebGLQuery(), KIND.query); }
  createTransformFeedback() { return new WebGLTransformFeedback(); }
  deleteBuffer(o: WebGLBuffer | null) { destroy(o, KIND.buffer); }
  deleteTexture(o: WebGLTexture | null) { destroy(o, KIND.texture); }
  deleteProgram(o: WebGLProgram | null) { destroy(o, KIND.program); }
  deleteShader(o: WebGLShader | null) { destroy(o, KIND.shader); }
  deleteVertexArray(o: WebGLVertexArrayObject | null) { destroy(o, KIND.vertexArray); }
  deleteFramebuffer(o: WebGLFramebuffer | null) { destroy(o, KIND.framebuffer); }
  deleteRenderbuffer(o: WebGLRenderbuffer | null) { destroy(o, KIND.renderbuffer); }
  deleteSampler(o: WebGLSampler | null) { destroy(o, KIND.sampler); }
  deleteQuery(o: WebGLQuery | null) { destroy(o, KIND.query); }
  deleteTransformFeedback() {}
  deleteSync() {}
  isBuffer(o: unknown) { return o instanceof WebGLBuffer && !o._deleted; }
  isTexture(o: unknown) { return o instanceof WebGLTexture && !o._deleted; }
  isProgram(o: unknown) { return o instanceof WebGLProgram && !o._deleted; }
  isShader(o: unknown) { return o instanceof WebGLShader && !o._deleted; }
  isFramebuffer(o: unknown) { return o instanceof WebGLFramebuffer && !o._deleted; }
  isRenderbuffer(o: unknown) { return o instanceof WebGLRenderbuffer && !o._deleted; }
  isVertexArray(o: unknown) { return o instanceof WebGLVertexArrayObject && !o._deleted; }

  bindBuffer(target: number, b: WebGLBuffer | null) { if (n + 3 > cap) submit(false); I[n] = H_BIND_BUF; I[n + 1] = target; I[n + 2] = b === null ? 0 : b._id; n += 3; if (DIRECT) submit(false); }
  bindBufferBase(target: number, index: number, b: WebGLBuffer | null) { const p = begin(OP.BIND_BUFFER_BASE, 4); I[p + 1] = target; I[p + 2] = index; I[p + 3] = id(b); end(); }
  bindBufferRange(target: number, index: number, b: WebGLBuffer | null, offset: number, size: number) {
    const p = begin(OP.BIND_BUFFER_RANGE, 6); I[p + 1] = target; I[p + 2] = index; I[p + 3] = id(b); I[p + 4] = offset; I[p + 5] = size; end();
  }
  bindFramebuffer(target: number, fb: WebGLFramebuffer | null) { const p = begin(OP.BIND_FRAMEBUFFER, 3); I[p + 1] = target; I[p + 2] = id(fb); end(); }
  bindRenderbuffer(target: number, rb: WebGLRenderbuffer | null) { const p = begin(OP.BIND_RENDERBUFFER, 3); I[p + 1] = target; I[p + 2] = id(rb); end(); }
  bindSampler(unit: number, s: WebGLSampler | null) { const p = begin(OP.BIND_SAMPLER, 3); I[p + 1] = unit; I[p + 2] = id(s); end(); }
  bindTexture(target: number, t: WebGLTexture | null) { if (n + 3 > cap) submit(false); I[n] = H_BIND_TEX; I[n + 1] = target; I[n + 2] = t === null ? 0 : t._id; n += 3; if (DIRECT) submit(false); }
  bindVertexArray(v: WebGLVertexArrayObject | null) { if (n + 2 > cap) submit(false); I[n] = H_BIND_VAO; I[n + 1] = v === null ? 0 : v._id; n += 2; if (DIRECT) submit(false); }
  bindTransformFeedback() {}

  // Buffers
  bufferData(target: number, data: number | ArrayBufferView | ArrayBuffer | null, usage: number, srcOffset = 0, length?: number) {
    if (typeof data === 'number' || data === null) {
      const p = beginWithPayload(OP.BUFFER_DATA, 3, null);
      I[p + 1] = target; I[p + 2] = usage; I[p + 5] = typeof data === 'number' ? data : 0;
    } else {
      const p = beginWithPayload(OP.BUFFER_DATA, 3, bytesOf(data, srcOffset, length));
      I[p + 1] = target; I[p + 2] = usage;
    }
    end();
  }
  bufferSubData(target: number, dstOffset: number, data: ArrayBufferView | ArrayBuffer, srcOffset = 0, length?: number) {
    const p = beginWithPayload(OP.BUFFER_SUB_DATA, 3, bytesOf(data, srcOffset, length));
    I[p + 1] = target; I[p + 2] = dstOffset;
    end();
  }
  copyBufferSubData(readTarget: number, writeTarget: number, readOffset: number, writeOffset: number, size: number) {
    const p = begin(OP.COPY_BUFFER_SUB_DATA, 6); I[p + 1] = readTarget; I[p + 2] = writeTarget; I[p + 3] = readOffset; I[p + 4] = writeOffset; I[p + 5] = size; end();
  }
  getBufferSubData(target: number, srcByteOffset: number, dst: ArrayBufferView, dstOffset = 0, length?: number) {
    const bytes = bytesOf(dst, dstOffset, length);
    query(Q.getBufferSubData, target, srcByteOffset, bytes.byteLength, 0, 0, 0, bytes);
  }

  // Shaders and programs
  shaderSource(s: WebGLShader, source: string) {
    s._source = source; s._status = null;
    const p = begin(OP.SHADER_SOURCE, 3); I[p + 1] = s._id; I[p + 2] = N.str(source); end();
  }
  getShaderSource(s: WebGLShader) { return s._source; }
  compileShader(s: WebGLShader) { s._status = null; const p = begin(OP.COMPILE_SHADER, 2); I[p + 1] = s._id; end(); }
  attachShader(prog: WebGLProgram, s: WebGLShader) { prog._shaders.push(s); const p = begin(OP.ATTACH_SHADER, 3); I[p + 1] = prog._id; I[p + 2] = s._id; end(); }
  detachShader(prog: WebGLProgram, s: WebGLShader) { prog._shaders = prog._shaders.filter((x) => x !== s); const p = begin(OP.DETACH_SHADER, 3); I[p + 1] = prog._id; I[p + 2] = s._id; end(); }
  getAttachedShaders(prog: WebGLProgram) { return [...prog._shaders]; }
  linkProgram(prog: WebGLProgram) { prog._info = null; prog._locations = null; const p = begin(OP.LINK_PROGRAM, 2); I[p + 1] = prog._id; end(); }
  validateProgram() {}
  useProgram(prog: WebGLProgram | null) { if (n + 2 > cap) submit(false); I[n] = H_USE; I[n + 1] = prog === null ? 0 : prog._id; n += 2; if (DIRECT) submit(false); }
  bindAttribLocation(prog: WebGLProgram, index: number, name: string) { const p = begin(OP.BIND_ATTRIB_LOCATION, 4); I[p + 1] = prog._id; I[p + 2] = index; I[p + 3] = N.str(name); end(); }
  uniformBlockBinding(prog: WebGLProgram, index: number, binding: number) { const p = begin(OP.UNIFORM_BLOCK_BINDING, 4); I[p + 1] = prog._id; I[p + 2] = index; I[p + 3] = binding; end(); }

  _shaderStatus(s: WebGLShader) {
    return (s._status ??= JSON.parse(query(Q.shaderParameter, s._id) as string) as { compiled: boolean; log: string });
  }
  getShaderParameter(s: WebGLShader, pname: number) {
    if (pname === C.SHADER_TYPE) return s._type;
    if (pname === C.DELETE_STATUS) return s._deleted;
    if (pname === EXT.COMPLETION_STATUS_KHR) return true;
    return this._shaderStatus(s).compiled;
  }
  getShaderInfoLog(s: WebGLShader) { return this._shaderStatus(s).log; }
  _programInfo(prog: WebGLProgram) {
    return (prog._info ??= JSON.parse(query(Q.programInfo, prog._id) as string) as ProgramInfo);
  }
  getProgramParameter(prog: WebGLProgram, pname: number) {
    if (pname === EXT.COMPLETION_STATUS_KHR) return true;
    if (pname === C.DELETE_STATUS) return prog._deleted;
    const i = this._programInfo(prog);
    switch (pname) {
      case C.LINK_STATUS: return i.link;
      case C.VALIDATE_STATUS: return i.validate;
      case C.ATTACHED_SHADERS: return i.shaders;
      case C.ACTIVE_UNIFORMS: return i.uniforms.length;
      case C.ACTIVE_ATTRIBUTES: return i.attribs.length;
      case C.ACTIVE_UNIFORM_BLOCKS: return i.blocks.length;
      case C.TRANSFORM_FEEDBACK_BUFFER_MODE: return C.SEPARATE_ATTRIBS;
      case C.TRANSFORM_FEEDBACK_VARYINGS: return 0;
    }
    return null;
  }
  getProgramInfoLog(prog: WebGLProgram) { return this._programInfo(prog).log; }
  getActiveUniform(prog: WebGLProgram, index: number) {
    const u = this._programInfo(prog).uniforms[index];
    return u ? new WebGLActiveInfo(u.name, u.size, u.type) : null;
  }
  getActiveAttrib(prog: WebGLProgram, index: number) {
    const a = this._programInfo(prog).attribs[index];
    return a ? new WebGLActiveInfo(a.name, a.size, a.type) : null;
  }
  getUniformLocation(prog: WebGLProgram, name: string) {
    const i = this._programInfo(prog);
    if (!prog._locations) {
      prog._locations = new Map();
      for (const u of i.uniforms) {
        const loc = new WebGLUniformLocation(u.loc);
        prog._locations.set(u.name, loc);
        if (u.name.endsWith('[0]')) prog._locations.set(u.name.slice(0, -3), loc);
      }
    }
    const known = prog._locations.get(name);
    if (known !== undefined) return known;
    // Array elements and struct members that aren't listed by name.
    const loc = query(Q.programInfo, prog._id, 1, N.str(name)) as number;
    const result = loc >= 0 ? new WebGLUniformLocation(loc) : null;
    prog._locations.set(name, result);
    return result;
  }
  getAttribLocation(prog: WebGLProgram, name: string) {
    const a = this._programInfo(prog).attribs.find((x) => x.name === name);
    return a ? a.loc : -1;
  }
  getUniformBlockIndex(prog: WebGLProgram, name: string) {
    const b = this._programInfo(prog).blocks.find((x) => x.name === name);
    return b ? b.index : C.INVALID_INDEX;
  }
  getFragDataLocation() { return 0; }
  getUniform() { return null; }
  transformFeedbackVaryings() {}

  // Uniforms
  uniform1f(l: WebGLUniformLocation | null, x: number) { if (l === null) return; if (n + 3 > cap) submit(false); I[n] = H_U1F; I[n + 1] = l._loc; F[n + 2] = x; n += 3; if (DIRECT) submit(false); }
  uniform2f(l: WebGLUniformLocation | null, x: number, y: number) { if (l === null) return; if (n + 4 > cap) submit(false); I[n] = H_U2F; I[n + 1] = l._loc; F[n + 2] = x; F[n + 3] = y; n += 4; if (DIRECT) submit(false); }
  uniform3f(l: WebGLUniformLocation | null, x: number, y: number, z: number) { if (l === null) return; if (n + 5 > cap) submit(false); I[n] = H_U3F; I[n + 1] = l._loc; F[n + 2] = x; F[n + 3] = y; F[n + 4] = z; n += 5; if (DIRECT) submit(false); }
  uniform4f(l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number) { if (l === null) return; if (n + 6 > cap) submit(false); I[n] = H_U4F; I[n + 1] = l._loc; F[n + 2] = x; F[n + 3] = y; F[n + 4] = z; F[n + 5] = w; n += 6; if (DIRECT) submit(false); }
  uniform1i(l: WebGLUniformLocation | null, x: number) { if (l === null) return; if (n + 3 > cap) submit(false); I[n] = H_U1I; I[n + 1] = l._loc; I[n + 2] = x; n += 3; if (DIRECT) submit(false); }
  uniform2i(l: WebGLUniformLocation | null, x: number, y: number) { this._ui(OP.UNIFORM_2I, l, x, y, 0, 0, 2); }
  uniform3i(l: WebGLUniformLocation | null, x: number, y: number, z: number) { this._ui(OP.UNIFORM_3I, l, x, y, z, 0, 3); }
  uniform4i(l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number) { this._ui(OP.UNIFORM_4I, l, x, y, z, w, 4); }
  uniform1ui(l: WebGLUniformLocation | null, x: number) { this._ui(OP.UNIFORM_1UI, l, x, 0, 0, 0, 1); }
  uniform2ui(l: WebGLUniformLocation | null, x: number, y: number) { this._ui(OP.UNIFORM_2UI, l, x, y, 0, 0, 2); }
  uniform3ui(l: WebGLUniformLocation | null, x: number, y: number, z: number) { this._ui(OP.UNIFORM_3UI, l, x, y, z, 0, 3); }
  uniform4ui(l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number) { this._ui(OP.UNIFORM_4UI, l, x, y, z, w, 4); }
  _ui(op: number, l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number, k: number) {
    if (l === null) return;
    const p = begin(op, 2 + k); I[p + 1] = l._loc; I[p + 2] = x;
    if (k > 1) I[p + 3] = y;
    if (k > 2) I[p + 4] = z;
    if (k > 3) I[p + 5] = w;
    end();
  }
  _uv(op: number, l: WebGLUniformLocation | null, comps: number, v: ArrayLike<number>, srcOffset = 0, srcLength = 0, ints = false) {
    if (l === null) return;
    const len = srcLength || v.length - srcOffset;
    const p = begin(op, 4 + len); I[p + 1] = l._loc; I[p + 2] = comps; I[p + 3] = len;
    const dst = ints ? I : F;
    if (srcOffset === 0 && len === v.length && ArrayBuffer.isView(v)) dst.set(v as Float32Array, p + 4);
    else for (let i = 0; i < len; i++) dst[p + 4 + i] = v[srcOffset + i];
    end();
  }
  uniform1fv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_FV, l, 1, v, o, k); }
  uniform2fv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_FV, l, 2, v, o, k); }
  uniform3fv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_FV, l, 3, v, o, k); }
  uniform4fv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_FV, l, 4, v, o, k); }
  uniform1iv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_IV, l, 1, v, o, k, true); }
  uniform2iv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_IV, l, 2, v, o, k, true); }
  uniform3iv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_IV, l, 3, v, o, k, true); }
  uniform4iv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_IV, l, 4, v, o, k, true); }
  uniform1uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_UIV, l, 1, v, o, k, true); }
  uniform2uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_UIV, l, 2, v, o, k, true); }
  uniform3uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_UIV, l, 3, v, o, k, true); }
  uniform4uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>, o?: number, k?: number) { this._uv(OP.UNIFORM_UIV, l, 4, v, o, k, true); }
  uniformMatrix4fv(l: WebGLUniformLocation | null, transpose: boolean, v: Float32Array | number[], srcOffset?: number, srcLength?: number) {
    if (l === null) return;
    if (v.length === 16 && !transpose && srcOffset === undefined) {
      if (n + 18 > cap) submit(false);
      I[n] = H_M4; I[n + 1] = l._loc; F.set(v, n + 2); n += 18;
      if (DIRECT) submit(false);
      return;
    }
    this._um(4, 4, l, transpose, v, srcOffset, srcLength);
  }
  uniformMatrix3fv(l: WebGLUniformLocation | null, transpose: boolean, v: Float32Array | number[], srcOffset?: number, srcLength?: number) {
    if (l === null) return;
    if (v.length === 9 && !transpose && srcOffset === undefined) {
      if (n + 11 > cap) submit(false);
      I[n] = H_M3; I[n + 1] = l._loc; F.set(v, n + 2); n += 11;
      if (DIRECT) submit(false);
      return;
    }
    this._um(3, 3, l, transpose, v, srcOffset, srcLength);
  }
  uniformMatrix2fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(2, 2, l, t, v, o, k); }
  uniformMatrix2x3fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(2, 3, l, t, v, o, k); }
  uniformMatrix2x4fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(2, 4, l, t, v, o, k); }
  uniformMatrix3x2fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(3, 2, l, t, v, o, k); }
  uniformMatrix3x4fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(3, 4, l, t, v, o, k); }
  uniformMatrix4x2fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(4, 2, l, t, v, o, k); }
  uniformMatrix4x3fv(l: WebGLUniformLocation | null, t: boolean, v: Float32Array | number[], o?: number, k?: number) { this._um(4, 3, l, t, v, o, k); }
  /** Layout: loc, columns, rows, transpose, count of floats, floats. */
  _um(cols: number, rows: number, l: WebGLUniformLocation | null, transpose: boolean, v: ArrayLike<number>, srcOffset = 0, srcLength = 0) {
    if (l === null) return;
    const len = srcLength || v.length - srcOffset;
    const p = begin(OP.UNIFORM_MATRIX_FV, 6 + len);
    I[p + 1] = l._loc; I[p + 2] = cols; I[p + 3] = rows; I[p + 4] = +transpose; I[p + 5] = len;
    for (let i = 0; i < len; i++) F[p + 6 + i] = v[srcOffset + i];
    end();
  }

  // Vertex attributes
  enableVertexAttribArray(i: number) { const p = begin(OP.ENABLE_VERTEX_ATTRIB_ARRAY, 2); I[p + 1] = i; end(); }
  disableVertexAttribArray(i: number) { const p = begin(OP.DISABLE_VERTEX_ATTRIB_ARRAY, 2); I[p + 1] = i; end(); }
  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number) {
    const p = begin(OP.VERTEX_ATTRIB_POINTER, 7); I[p + 1] = index; I[p + 2] = size; I[p + 3] = type; I[p + 4] = +normalized; I[p + 5] = stride; I[p + 6] = offset; end();
  }
  vertexAttribIPointer(index: number, size: number, type: number, stride: number, offset: number) {
    const p = begin(OP.VERTEX_ATTRIB_IPOINTER, 6); I[p + 1] = index; I[p + 2] = size; I[p + 3] = type; I[p + 4] = stride; I[p + 5] = offset; end();
  }
  vertexAttribDivisor(index: number, divisor: number) { const p = begin(OP.VERTEX_ATTRIB_DIVISOR, 3); I[p + 1] = index; I[p + 2] = divisor; end(); }
  vertexAttrib4f(i: number, x: number, y: number, z: number, w: number) { const p = begin(OP.VERTEX_ATTRIB_4F, 6); I[p + 1] = i; F[p + 2] = x; F[p + 3] = y; F[p + 4] = z; F[p + 5] = w; end(); }
  vertexAttrib1f(i: number, x: number) { this.vertexAttrib4f(i, x, 0, 0, 1); }
  vertexAttrib2f(i: number, x: number, y: number) { this.vertexAttrib4f(i, x, y, 0, 1); }
  vertexAttrib3f(i: number, x: number, y: number, z: number) { this.vertexAttrib4f(i, x, y, z, 1); }
  vertexAttrib1fv(i: number, v: ArrayLike<number>) { this.vertexAttrib4f(i, v[0], 0, 0, 1); }
  vertexAttrib2fv(i: number, v: ArrayLike<number>) { this.vertexAttrib4f(i, v[0], v[1], 0, 1); }
  vertexAttrib3fv(i: number, v: ArrayLike<number>) { this.vertexAttrib4f(i, v[0], v[1], v[2], 1); }
  vertexAttrib4fv(i: number, v: ArrayLike<number>) { this.vertexAttrib4f(i, v[0], v[1], v[2], v[3]); }
  vertexAttribI4i(i: number, x: number, y: number, z: number, w: number) { const p = begin(OP.VERTEX_ATTRIB_I4, 7); I[p + 1] = i; I[p + 2] = x; I[p + 3] = y; I[p + 4] = z; I[p + 5] = w; I[p + 6] = 0; end(); }
  vertexAttribI4ui(i: number, x: number, y: number, z: number, w: number) { const p = begin(OP.VERTEX_ATTRIB_I4, 7); I[p + 1] = i; I[p + 2] = x; I[p + 3] = y; I[p + 4] = z; I[p + 5] = w; I[p + 6] = 1; end(); }

  // Drawing
  drawArrays(mode: number, first: number, count: number) { drawnThisFrame = true; commandCount++; if (n + 4 > cap) submit(false); I[n] = H_DRAW_A; I[n + 1] = mode; I[n + 2] = first; I[n + 3] = count; n += 4; if (DIRECT) submit(false); }
  drawElements(mode: number, count: number, type: number, offset: number) { drawnThisFrame = true; commandCount++; if (n + 5 > cap) submit(false); I[n] = H_DRAW_E; I[n + 1] = mode; I[n + 2] = count; I[n + 3] = type; I[n + 4] = offset; n += 5; if (DIRECT) submit(false); }
  drawArraysInstanced(mode: number, first: number, count: number, instances: number) { drawnThisFrame = true; commandCount++; if (n + 5 > cap) submit(false); I[n] = H_DRAW_AI; I[n + 1] = mode; I[n + 2] = first; I[n + 3] = count; I[n + 4] = instances; n += 5; if (DIRECT) submit(false); }
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instances: number) { drawnThisFrame = true; commandCount++; if (n + 6 > cap) submit(false); I[n] = H_DRAW_EI; I[n + 1] = mode; I[n + 2] = count; I[n + 3] = type; I[n + 4] = offset; I[n + 5] = instances; n += 6; if (DIRECT) submit(false); }
  drawRangeElements(mode: number, start: number, endIndex: number, count: number, type: number, offset: number) {
    drawnThisFrame = true; commandCount++;
    const p = begin(OP.DRAW_RANGE_ELEMENTS, 7); I[p + 1] = mode; I[p + 2] = start; I[p + 3] = endIndex; I[p + 4] = count; I[p + 5] = type; I[p + 6] = offset; end();
  }
  drawBuffers(buffers: number[]) { const p = begin(OP.DRAW_BUFFERS, 2 + buffers.length); I[p + 1] = buffers.length; for (let i = 0; i < buffers.length; i++) I[p + 2 + i] = buffers[i]; end(); }

  // Textures
  texParameteri(target: number, pname: number, param: number) { const p = begin(OP.TEX_PARAMETERI, 4); I[p + 1] = target; I[p + 2] = pname; I[p + 3] = param; end(); }
  texParameterf(target: number, pname: number, param: number) { const p = begin(OP.TEX_PARAMETERF, 4); I[p + 1] = target; I[p + 2] = pname; F[p + 3] = param; end(); }
  samplerParameteri(s: WebGLSampler, pname: number, param: number) { const p = begin(OP.SAMPLER_PARAMETERI, 4); I[p + 1] = s._id; I[p + 2] = pname; I[p + 3] = param; end(); }
  samplerParameterf(s: WebGLSampler, pname: number, param: number) { const p = begin(OP.SAMPLER_PARAMETERF, 4); I[p + 1] = s._id; I[p + 2] = pname; F[p + 3] = param; end(); }
  getTexParameter(target: number, pname: number) { return query(Q.texParameter, target, pname); }
  generateMipmap(target: number) { const p = begin(OP.GENERATE_MIPMAP, 2); I[p + 1] = target; end(); }
  texStorage2D(target: number, levels: number, internalformat: number, w: number, h: number) {
    const p = begin(OP.TEX_STORAGE_2D, 6); I[p + 1] = target; I[p + 2] = levels; I[p + 3] = internalformat; I[p + 4] = w; I[p + 5] = h; end();
  }
  texStorage3D(target: number, levels: number, internalformat: number, w: number, h: number, d: number) {
    const p = begin(OP.TEX_STORAGE_3D, 7); I[p + 1] = target; I[p + 2] = levels; I[p + 3] = internalformat; I[p + 4] = w; I[p + 5] = h; I[p + 6] = d; end();
  }
  texImage2D(target: number, level: number, internalformat: number, a: number, b: number, c: unknown, format?: number, type?: number, src?: unknown, srcOffset?: number) {
    // (target, level, internalformat, format, type, source)
    if (arguments.length === 6) return texUpload(TEX.image2D, target, level, internalformat, 0, 0, 0, -1, -1, 1, 0, a, b, c);
    // (target, level, internalformat, width, height, border, format, type, data | source | offset, srcOffset)
    texUpload(TEX.image2D, target, level, internalformat, 0, 0, 0, a, b, 1, c as number, format ?? 0, type ?? 0, src, srcOffset);
  }
  texSubImage2D(target: number, level: number, x: number, y: number, a: number, b: number, c: unknown, d?: number, src?: unknown, srcOffset?: number) {
    // (target, level, x, y, format, type, source)
    if (arguments.length === 7) return texUpload(TEX.subImage2D, target, level, 0, x, y, 0, -1, -1, 1, 0, a, b, c);
    // (target, level, x, y, width, height, format, type, data | source | offset, srcOffset)
    texUpload(TEX.subImage2D, target, level, 0, x, y, 0, a, b, 1, 0, c as number, d ?? 0, src, srcOffset);
  }
  texImage3D(target: number, level: number, internalformat: number, w: number, h: number, d: number, border: number, format: number, type: number, src: unknown, srcOffset?: number) {
    texUpload(TEX.image3D, target, level, internalformat, 0, 0, 0, w, h, d, border, format, type, src, srcOffset);
  }
  texSubImage3D(target: number, level: number, x: number, y: number, z: number, w: number, h: number, d: number, format: number, type: number, src: unknown, srcOffset?: number) {
    texUpload(TEX.subImage3D, target, level, 0, x, y, z, w, h, d, 0, format, type, src, srcOffset);
  }
  compressedTexImage2D(target: number, level: number, internalformat: number, w: number, h: number, border: number, src: unknown, srcOffset?: number, srcLength?: number) {
    texUpload(TEX.compressed2D, target, level, internalformat, 0, 0, 0, w, h, 1, border, 0, 0, src, srcOffset, srcLength);
  }
  compressedTexSubImage2D(target: number, level: number, x: number, y: number, w: number, h: number, format: number, src: unknown, srcOffset?: number, srcLength?: number) {
    texUpload(TEX.compressedSub2D, target, level, 0, x, y, 0, w, h, 1, 0, format, 0, src, srcOffset, srcLength);
  }
  compressedTexImage3D(target: number, level: number, internalformat: number, w: number, h: number, d: number, border: number, src: unknown, srcOffset?: number, srcLength?: number) {
    texUpload(TEX.compressed3D, target, level, internalformat, 0, 0, 0, w, h, d, border, 0, 0, src, srcOffset, srcLength);
  }
  compressedTexSubImage3D(target: number, level: number, x: number, y: number, z: number, w: number, h: number, d: number, format: number, src: unknown, srcOffset?: number, srcLength?: number) {
    texUpload(TEX.compressedSub3D, target, level, 0, x, y, z, w, h, d, 0, format, 0, src, srcOffset, srcLength);
  }
  copyTexImage2D(target: number, level: number, internalformat: number, x: number, y: number, w: number, h: number, border: number) {
    const p = begin(OP.COPY_TEX_IMAGE_2D, 9); I[p + 1] = target; I[p + 2] = level; I[p + 3] = internalformat; I[p + 4] = x; I[p + 5] = y; I[p + 6] = w; I[p + 7] = h; I[p + 8] = border; end();
  }
  copyTexSubImage2D(target: number, level: number, xoff: number, yoff: number, x: number, y: number, w: number, h: number) {
    this._copySub(target, level, xoff, yoff, -1, x, y, w, h);
  }
  copyTexSubImage3D(target: number, level: number, xoff: number, yoff: number, zoff: number, x: number, y: number, w: number, h: number) {
    this._copySub(target, level, xoff, yoff, zoff, x, y, w, h);
  }
  _copySub(target: number, level: number, xoff: number, yoff: number, zoff: number, x: number, y: number, w: number, h: number) {
    const p = begin(OP.COPY_TEX_SUB_IMAGE, 10);
    I[p + 1] = target; I[p + 2] = level; I[p + 3] = xoff; I[p + 4] = yoff; I[p + 5] = zoff; I[p + 6] = x; I[p + 7] = y; I[p + 8] = w; I[p + 9] = h;
    end();
  }

  // Framebuffers
  framebufferRenderbuffer(target: number, attachment: number, rbTarget: number, rb: WebGLRenderbuffer | null) {
    const p = begin(OP.FRAMEBUFFER_RENDERBUFFER, 5); I[p + 1] = target; I[p + 2] = attachment; I[p + 3] = rbTarget; I[p + 4] = id(rb); end();
  }
  framebufferTexture2D(target: number, attachment: number, texTarget: number, tex: WebGLTexture | null, level: number) {
    const p = begin(OP.FRAMEBUFFER_TEXTURE_2D, 6); I[p + 1] = target; I[p + 2] = attachment; I[p + 3] = texTarget; I[p + 4] = id(tex); I[p + 5] = level; end();
  }
  framebufferTextureLayer(target: number, attachment: number, tex: WebGLTexture | null, level: number, layer: number) {
    const p = begin(OP.FRAMEBUFFER_TEXTURE_LAYER, 6); I[p + 1] = target; I[p + 2] = attachment; I[p + 3] = id(tex); I[p + 4] = level; I[p + 5] = layer; end();
  }
  renderbufferStorage(target: number, internalformat: number, w: number, h: number) { this.renderbufferStorageMultisample(target, 0, internalformat, w, h); }
  renderbufferStorageMultisample(target: number, samples: number, internalformat: number, w: number, h: number) {
    const p = begin(OP.RENDERBUFFER_STORAGE, 6); I[p + 1] = target; I[p + 2] = samples; I[p + 3] = internalformat; I[p + 4] = w; I[p + 5] = h; end();
  }
  blitFramebuffer(sx0: number, sy0: number, sx1: number, sy1: number, dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number) {
    drawnThisFrame = true;
    const p = begin(OP.BLIT_FRAMEBUFFER, 11);
    I[p + 1] = sx0; I[p + 2] = sy0; I[p + 3] = sx1; I[p + 4] = sy1; I[p + 5] = dx0; I[p + 6] = dy0; I[p + 7] = dx1; I[p + 8] = dy1; I[p + 9] = mask; I[p + 10] = filter;
    end();
  }
  invalidateFramebuffer(target: number, attachments: number[]) {
    const p = begin(OP.INVALIDATE_FRAMEBUFFER, 3 + attachments.length); I[p + 1] = target; I[p + 2] = attachments.length;
    for (let i = 0; i < attachments.length; i++) I[p + 3 + i] = attachments[i];
    end();
  }
  invalidateSubFramebuffer(target: number, attachments: number[]) { this.invalidateFramebuffer(target, attachments); }
  readBuffer(src: number) { const p = begin(OP.READ_BUFFER, 2); I[p + 1] = src; end(); }
  clearBufferfv(buffer: number, drawbuffer: number, v: ArrayLike<number>, o = 0) { drawnThisFrame = true; const p = begin(OP.CLEAR_BUFFERFV, 7); I[p + 1] = buffer; I[p + 2] = drawbuffer; for (let i = 0; i < 4; i++) F[p + 3 + i] = v[o + i] ?? 0; end(); }
  clearBufferiv(buffer: number, drawbuffer: number, v: ArrayLike<number>, o = 0) { drawnThisFrame = true; const p = begin(OP.CLEAR_BUFFERIV, 7); I[p + 1] = buffer; I[p + 2] = drawbuffer; for (let i = 0; i < 4; i++) I[p + 3 + i] = v[o + i] ?? 0; end(); }
  clearBufferuiv(buffer: number, drawbuffer: number, v: ArrayLike<number>, o = 0) { drawnThisFrame = true; const p = begin(OP.CLEAR_BUFFERUIV, 7); I[p + 1] = buffer; I[p + 2] = drawbuffer; for (let i = 0; i < 4; i++) I[p + 3 + i] = v[o + i] ?? 0; end(); }
  clearBufferfi(buffer: number, drawbuffer: number, depth: number, stencil: number) { drawnThisFrame = true; const p = begin(OP.CLEAR_BUFFERFI, 5); I[p + 1] = buffer; I[p + 2] = drawbuffer; F[p + 3] = depth; I[p + 4] = stencil; end(); }
  checkFramebufferStatus(target: number) { return query(Q.checkFramebufferStatus, target) as number; }
  getFramebufferAttachmentParameter() { return null; }
  getRenderbufferParameter() { return 0; }
  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, dst: ArrayBufferView | number | null, dstOffset = 0) {
    if (!dst || typeof dst === 'number') return;
    query(Q.readPixels, x, y, w, h, format, type, bytesOf(dst, dstOffset));
  }

  // Queries and syncs: no timer queries are offered, so these only need to be harmless.
  beginQuery() {}
  endQuery() {}
  getQuery() { return null; }
  getQueryParameter() { return 0; }
  fenceSync() { return new WebGLSync(); }
  clientWaitSync() { query(Q.finish); return C.ALREADY_SIGNALED; }
  waitSync() {}
  getSyncParameter() { return C.SIGNALED; }
}

function wrapParam(pname: number, v: number | number[] | string | boolean | null): unknown {
  if (Array.isArray(v)) return FLOAT_ARRAY_PARAMS.has(pname) ? new Float32Array(v) : new Int32Array(v);
  if (INT_ARRAY_PARAMS.has(pname) && typeof v === 'number') return new Int32Array([v, v]);
  if (BOOL_PARAMS.has(pname)) return !!v;
  return v;
}

const extensionCache = new Map<string, object | null>();
const has = (list: string[], ...names: string[]) => names.some((x) => list.includes(x));
const EXTENSIONS: Record<string, (gl: string[]) => object | null> = {
  EXT_color_buffer_float: (gl) => (has(gl, 'GL_EXT_color_buffer_float') ? {} : null),
  EXT_color_buffer_half_float: (gl) => (has(gl, 'GL_EXT_color_buffer_half_float', 'GL_EXT_color_buffer_float') ? { RGBA16F_EXT: 0x881a, RGB16F_EXT: 0x881b, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8c17 } : null),
  OES_texture_float_linear: (gl) => (has(gl, 'GL_OES_texture_float_linear') ? {} : null),
  EXT_texture_filter_anisotropic: (gl) => (has(gl, 'GL_EXT_texture_filter_anisotropic') ? { TEXTURE_MAX_ANISOTROPY_EXT: EXT.TEXTURE_MAX_ANISOTROPY_EXT, MAX_TEXTURE_MAX_ANISOTROPY_EXT: EXT.MAX_TEXTURE_MAX_ANISOTROPY_EXT } : null),
  WEBGL_debug_renderer_info: () => ({ UNMASKED_VENDOR_WEBGL: EXT.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: EXT.UNMASKED_RENDERER_WEBGL }),
  WEBGL_lose_context: () => ({ loseContext() {}, restoreContext() {} }),
  WEBGL_compressed_texture_etc: () => ({
    COMPRESSED_R11_EAC: 0x9270, COMPRESSED_SIGNED_R11_EAC: 0x9271, COMPRESSED_RG11_EAC: 0x9272, COMPRESSED_SIGNED_RG11_EAC: 0x9273,
    COMPRESSED_RGB8_ETC2: 0x9274, COMPRESSED_SRGB8_ETC2: 0x9275, COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276,
    COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277, COMPRESSED_RGBA8_ETC2_EAC: 0x9278, COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
  }),
  WEBGL_compressed_texture_astc: (gl) => (has(gl, 'GL_KHR_texture_compression_astc_ldr') ? astcConstants() : null),
  WEBGL_compressed_texture_pvrtc: (gl) => (has(gl, 'GL_IMG_texture_compression_pvrtc') ? {
    COMPRESSED_RGB_PVRTC_4BPPV1_IMG: 0x8c00, COMPRESSED_RGB_PVRTC_2BPPV1_IMG: 0x8c01, COMPRESSED_RGBA_PVRTC_4BPPV1_IMG: 0x8c02, COMPRESSED_RGBA_PVRTC_2BPPV1_IMG: 0x8c03,
  } : null),
};
function astcConstants() {
  const sizes = ['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'];
  const out: Record<string, unknown> = { getSupportedProfiles: () => ['ldr'] };
  sizes.forEach((s, i) => { out[`COMPRESSED_RGBA_ASTC_${s}_KHR`] = 0x93b0 + i; out[`COMPRESSED_SRGB8_ALPHA8_ASTC_${s}_KHR`] = 0x93d0 + i; });
  return out;
}

for (const [k, v] of Object.entries(GL_CONSTANTS)) {
  Object.defineProperty(WebGL2RenderingContext.prototype, k, { value: v, enumerable: false });
  Object.defineProperty(WebGL2RenderingContext, k, { value: v, enumerable: false });
}
