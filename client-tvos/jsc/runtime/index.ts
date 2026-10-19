// The browser runtime for the aerodance JavaScriptCore host: installs window, document, WebGL 2,
// the 2D canvas and the Web APIs the game uses on globalThis, and gives the host its entry
// points (globalThis.__host). The host evaluates this before the app's own script.
import { native } from './native.ts';
import { OP } from './ops.ts';
import * as gl from './webgl.ts';
import { CanvasGradient, CanvasPattern, CanvasRenderingContext2D, ImageData, Path2D, TextMetricsLite } from './canvas2d.ts';
import * as dom from './dom.ts';
import * as web from './web.ts';
import { installAudio } from './audio.ts';
import { installBench } from './bench.ts';

const N = native;
const g = globalThis as unknown as Record<string, unknown>;
type Config = { url?: string; width?: number; height?: number; [k: string]: unknown };
const config = JSON.parse(N.config || '{}') as Config;
if (config.url) web.setPageUrl(config.url);
if (config.width) dom.viewport.width = config.width;
if (config.height) dom.viewport.height = config.height;

const define = (name: string, value: unknown) => { if (!(name in g) || g[name] === undefined) g[name] = value; };
const replace = (name: string, value: unknown) => { g[name] = value; };

// window
replace('window', globalThis);
replace('self', globalThis);
replace('top', globalThis);
replace('parent', globalThis);
replace('frames', globalThis);
replace('globalThis', globalThis);
for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) {
  g[k] = (dom.windowTarget[k] as (...a: unknown[]) => unknown).bind(dom.windowTarget);
}
Object.defineProperty(g, 'innerWidth', { get: () => dom.viewport.width, configurable: true });
Object.defineProperty(g, 'innerHeight', { get: () => dom.viewport.height, configurable: true });
Object.defineProperty(g, 'outerWidth', { get: () => dom.viewport.width, configurable: true });
Object.defineProperty(g, 'outerHeight', { get: () => dom.viewport.height, configurable: true });
replace('devicePixelRatio', 1);
replace('screen', { get width() { return dom.viewport.width; }, get height() { return dom.viewport.height; }, availWidth: 1920, availHeight: 1080, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener() {} } });
replace('scrollX', 0); replace('scrollY', 0); replace('pageXOffset', 0); replace('pageYOffset', 0);
replace('scrollTo', () => {}); replace('scroll', () => {}); replace('focus', () => {}); replace('blur', () => {});
replace('open', () => null); replace('close', () => {}); replace('alert', (m: unknown) => N.log(1, `alert: ${String(m)}`));
replace('confirm', () => false); replace('prompt', () => null);
replace('getComputedStyle', (el: dom.ElementShim) => el.style);
replace('matchMedia', (media: string) => ({
  media, matches: /prefers-color-scheme:\s*dark|hover:\s*none|pointer:\s*none/.test(media), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true,
}));

const page = new web.URLShim(web.pageUrl);
replace('location', {
  get href() { return page.href; }, get origin() { return page.origin; }, get protocol() { return page.protocol; },
  get host() { return page.host; }, get hostname() { return page.hostname; }, get port() { return page.port; },
  get pathname() { return page.pathname; }, get search() { return page.search; }, get hash() { return page.hash; },
  set hash(v: string) { page.hash = v ? `#${v.replace(/^#/, '')}` : ''; },
  assign(url: string) { N.log(1, `navigation to ${url} is not supported`); }, replace(url: string) { N.log(1, `navigation to ${url} is not supported`); },
  reload() { N.log(1, 'reload is not supported'); }, toString() { return page.href; }, ancestorOrigins: [],
});
replace('history', { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} });
replace('navigator', {
  userAgent: 'Mozilla/5.0 (AppleTV; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) aerodance-jsc',
  platform: 'AppleTV', vendor: 'Apple Computer, Inc.', language: 'en-US', languages: ['en-US', 'en'], onLine: true,
  hardwareConcurrency: 6, maxTouchPoints: 0, cookieEnabled: false, webdriver: false, deviceMemory: 4,
  userActivation: { hasBeenActive: true, isActive: true }, getGamepads: () => [], vibrate: () => false,
  sendBeacon: () => false, clipboard: { writeText: () => Promise.reject(new Error('no clipboard')) },
});

// document and DOM classes
replace('document', dom.documentShim);
const classes: Record<string, unknown> = {
  EventTarget: dom.EventTargetShim, Event: dom.EventShim, CustomEvent: dom.CustomEventShim, KeyboardEvent: dom.KeyboardEventShim,
  MouseEvent: dom.MouseEventShim, PointerEvent: dom.PointerEventShim, WheelEvent: dom.WheelEventShim, FocusEvent: dom.EventShim,
  UIEvent: dom.EventShim, TouchEvent: dom.EventShim, InputEvent: dom.EventShim,
  Node: dom.NodeShim, Element: dom.ElementShim, HTMLElement: dom.HTMLElementShim, Text: dom.TextShim, Comment: dom.CommentShim,
  DocumentFragment: dom.DocumentFragmentShim, Document: dom.DocumentShim, HTMLDocument: dom.DocumentShim,
  HTMLCanvasElement: dom.HTMLCanvasElementShim, HTMLImageElement: dom.HTMLImageElementShim, HTMLAnchorElement: dom.HTMLAnchorElementShim,
  HTMLMediaElement: dom.HTMLMediaElementShim, HTMLVideoElement: dom.HTMLMediaElementShim, HTMLAudioElement: dom.HTMLMediaElementShim,
  HTMLDivElement: dom.HTMLElementShim, HTMLIFrameElement: class {}, SVGElement: dom.ElementShim,
  ImageBitmap: dom.ImageBitmapShim, Image: dom.HTMLImageElementShim,
  CanvasRenderingContext2D, CanvasGradient, CanvasPattern, ImageData, Path2D, TextMetrics: TextMetricsLite,
  WebGL2RenderingContext: gl.WebGL2RenderingContext, WebGLBuffer: gl.WebGLBuffer, WebGLTexture: gl.WebGLTexture,
  WebGLProgram: gl.WebGLProgram, WebGLShader: gl.WebGLShader, WebGLFramebuffer: gl.WebGLFramebuffer,
  WebGLRenderbuffer: gl.WebGLRenderbuffer, WebGLVertexArrayObject: gl.WebGLVertexArrayObject, WebGLUniformLocation: gl.WebGLUniformLocation,
  WebGLActiveInfo: gl.WebGLActiveInfo, WebGLSampler: gl.WebGLSampler, WebGLQuery: gl.WebGLQuery, WebGLSync: gl.WebGLSync,
  WebGLShaderPrecisionFormat: gl.WebGLShaderPrecisionFormat, WebGLTransformFeedback: gl.WebGLTransformFeedback,
  URL: web.URLShim, URLSearchParams: web.URLSearchParamsShim, TextEncoder: web.TextEncoderShim, TextDecoder: web.TextDecoderShim,
  Blob: web.BlobShim, File: web.FileShim, Response: web.ResponseShim, Headers: web.HeadersShim, Storage: web.StorageShim,
};
for (const [k, v] of Object.entries(classes)) define(k, v);
define('createImageBitmap', dom.createImageBitmapShim);

// Timers, frames, console
replace('console', web.consoleShim);
replace('setTimeout', web.setTimeoutShim);
replace('setInterval', web.setIntervalShim);
replace('clearTimeout', web.clearTimer);
replace('clearInterval', web.clearTimer);
replace('setImmediate', (fn: () => void, ...args: unknown[]) => web.setTimeoutShim(fn, 0, ...args));
replace('clearImmediate', web.clearTimer);
define('queueMicrotask', (fn: () => void) => { Promise.resolve().then(fn).catch(web.reportError); });
replace('requestAnimationFrame', web.requestAnimationFrameShim);
replace('cancelAnimationFrame', web.cancelAnimationFrameShim);
replace('requestIdleCallback', (fn: (d: { didTimeout: boolean; timeRemaining(): number }) => void) => web.setTimeoutShim(() => fn({ didTimeout: false, timeRemaining: () => 8 }), 1));
replace('cancelIdleCallback', web.clearTimer);
const timeOrigin = Date.now() - N.now();
replace('performance', {
  now: () => N.now(), timeOrigin, mark: () => undefined, measure: () => undefined, clearMarks() {}, clearMeasures() {},
  getEntriesByName: () => [], getEntriesByType: () => [], getEntries: () => [],
});
replace('reportError', web.reportError);

// Network, storage, crypto
replace('fetch', web.fetchShim);
replace('localStorage', new web.StorageShim());
replace('sessionStorage', new web.StorageShim());
replace('crypto', web.cryptoShim);
define('structuredClone', web.structuredCloneShim);
define('atob', web.atobShim);
define('btoa', web.btoaShim);
class AbortSignalShim extends dom.EventTargetShim {
  aborted = false; reason: unknown = undefined; onabort: ((e: unknown) => void) | null = null;
  throwIfAborted() { if (this.aborted) throw this.reason; }
  static timeout(ms: number) { const c = new AbortControllerShim(); web.setTimeoutShim(() => c.abort(new Error('timeout')), ms); return c.signal; }
}
class AbortControllerShim {
  readonly signal = new AbortSignalShim();
  abort(reason?: unknown) { if (this.signal.aborted) return; this.signal.aborted = true; this.signal.reason = reason ?? new Error('aborted'); this.signal.dispatchEvent(new dom.EventShim('abort')); }
}
define('AbortController', AbortControllerShim);
define('AbortSignal', AbortSignalShim);
class DOMExceptionShim extends Error { constructor(message = '', name = 'Error') { super(message); this.name = name; } }
define('DOMException', DOMExceptionShim);
class ResizeObserverShim {
  _cb: (entries: unknown[], o: unknown) => void;
  _els = new Set<dom.ElementShim>();
  constructor(cb: (entries: unknown[], o: unknown) => void) { this._cb = cb; observers.add(this); }
  observe(el: dom.ElementShim) { this._els.add(el); web.setTimeoutShim(() => this._fire([el])); }
  unobserve(el: dom.ElementShim) { this._els.delete(el); }
  disconnect() { this._els.clear(); observers.delete(this); }
  _fire(els: dom.ElementShim[]) {
    if (!els.length) return;
    const { width, height } = dom.viewport;
    this._cb(els.map((target) => ({ target, contentRect: { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height }, borderBoxSize: [{ inlineSize: width, blockSize: height }], contentBoxSize: [{ inlineSize: width, blockSize: height }] })), this);
  }
}
const observers = new Set<ResizeObserverShim>();
define('ResizeObserver', ResizeObserverShim);
define('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
define('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
installAudio(g);

g.WebGLRenderingContext = undefined;

// ---------------------------------------------------------------------------------------------
// Host entry points

let frameCount = 0;
const host = {
  /** A display refresh: runs the animation frame callbacks. Promise jobs run when this returns. */
  frame(ts: number) {
    frameCount++;
    web.runFrameCallbacks(ts);
  },
  /** After frame() and its promise jobs: submits the frame's commands (and presents if it drew). */
  endFrame() {
    if (gl.drawnThisFrame) {
      gl.begin(OP.PRESENT, 1); gl.clearDrawn();
      gl.submit(true);
    } else gl.submit(false);
  },
  hasFrameCallbacks: web.hasFrameCallbacks,
  timers: web.runTimers,
  /** A remote button: keydown or keyup on the focused element. */
  key(type: string, key: string, code: string, repeat: boolean) {
    const target = dom.documentShim.activeElement ?? dom.documentShim.body;
    target.dispatchEvent(new dom.KeyboardEventShim(type, { key, code, repeat, bubbles: true, cancelable: true, keyCode: KEY_CODES[key] ?? 0 }));
  },
  resize(w: number, h: number) {
    dom.viewport.width = w; dom.viewport.height = h;
    dom.windowTarget.dispatchEvent(new dom.EventShim('resize'));
    for (const o of observers) o._fire([...o._els]);
  },
  visibility(hidden: boolean) {
    dom.documentShim.hidden = hidden;
    dom.documentShim.visibilityState = hidden ? 'hidden' : 'visible';
    dom.documentShim.dispatchEvent(new dom.EventShim('visibilitychange'));
  },
  error: web.reportError,
  frames: () => frameCount,
  commands: gl.commands,
};
const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, Backspace: 8 };
g.__host = host;
installBench(g, config as Parameters<typeof installBench>[1]);
