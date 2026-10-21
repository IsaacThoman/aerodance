// A small DOM: enough of Node, Element, Document, events, canvas and image elements for three.js,
// React DOM and the game. Layout isn't computed; every element reports the display's size.
import { PAYLOAD } from './ops.ts';
import { native } from './native.ts';
import { CanvasRenderingContext2D, canvasCommands } from './canvas2d.ts';
import { WebGL2RenderingContext, releaseImage } from './webgl.ts';
import { BlobShim, URLShim, blobForUrl, pageUrl, reportError, setTimeoutShim } from './web.ts';

const N = native;

// ---------------------------------------------------------------------------------------------
// Events

type Listener = { fn: EventListenerOrEventListenerObject; capture: boolean; once: boolean; passive: boolean };
type ListenerOptions = boolean | { capture?: boolean; once?: boolean; passive?: boolean; signal?: { addEventListener(t: string, f: () => void): void } };

export class EventShim {
  readonly type: string; readonly bubbles: boolean; readonly cancelable: boolean; readonly composed: boolean;
  target: EventTargetShim | null = null; currentTarget: EventTargetShim | null = null; srcElement: EventTargetShim | null = null;
  eventPhase = 0; defaultPrevented = false; isTrusted = false; timeStamp = N.now();
  _stop = false; _stopNow = false;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; composed?: boolean } = {}) {
    this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
  get returnValue() { return !this.defaultPrevented; }
  get cancelBubble() { return this._stop; }
  set cancelBubble(v: boolean) { if (v) this._stop = true; }
  composedPath() { const path: EventTargetShim[] = []; for (let t: EventTargetShim | null = this.target; t; t = t._parentTarget()) path.push(t); return path; }
  static readonly NONE = 0; static readonly CAPTURING_PHASE = 1; static readonly AT_TARGET = 2; static readonly BUBBLING_PHASE = 3;
}
export class CustomEventShim extends EventShim {
  readonly detail: unknown;
  constructor(type: string, init: { detail?: unknown; bubbles?: boolean; cancelable?: boolean } = {}) { super(type, init); this.detail = init.detail ?? null; }
}
type KeyInit = { key?: string; code?: string; repeat?: boolean; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; bubbles?: boolean; cancelable?: boolean; keyCode?: number };
export class KeyboardEventShim extends EventShim {
  readonly key: string; readonly code: string; readonly repeat: boolean; readonly shiftKey: boolean; readonly ctrlKey: boolean;
  readonly altKey: boolean; readonly metaKey: boolean; readonly keyCode: number; readonly location = 0; readonly isComposing = false;
  constructor(type: string, init: KeyInit = {}) {
    super(type, init);
    this.key = init.key ?? ''; this.code = init.code ?? ''; this.repeat = !!init.repeat; this.shiftKey = !!init.shiftKey;
    this.ctrlKey = !!init.ctrlKey; this.altKey = !!init.altKey; this.metaKey = !!init.metaKey; this.keyCode = init.keyCode ?? 0;
  }
  get which() { return this.keyCode; }
  getModifierState() { return false; }
}
type PointerInit = { clientX?: number; clientY?: number; button?: number; buttons?: number; pointerId?: number; pointerType?: string; bubbles?: boolean; cancelable?: boolean; deltaY?: number };
export class MouseEventShim extends EventShim {
  readonly clientX: number; readonly clientY: number; readonly button: number; readonly buttons: number;
  readonly shiftKey = false; readonly ctrlKey = false; readonly altKey = false; readonly metaKey = false;
  constructor(type: string, init: PointerInit = {}) {
    super(type, init);
    this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.button = init.button ?? 0; this.buttons = init.buttons ?? 0;
  }
  get pageX() { return this.clientX; } get pageY() { return this.clientY; }
  get offsetX() { return this.clientX; } get offsetY() { return this.clientY; }
  get screenX() { return this.clientX; } get screenY() { return this.clientY; }
  get x() { return this.clientX; } get y() { return this.clientY; }
}
export class PointerEventShim extends MouseEventShim {
  readonly pointerId: number; readonly pointerType: string; readonly isPrimary = true; readonly width = 1; readonly height = 1; readonly pressure = 0;
  constructor(type: string, init: PointerInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse'; }
}
export class WheelEventShim extends MouseEventShim {
  readonly deltaX = 0; readonly deltaY: number; readonly deltaZ = 0; readonly deltaMode = 0;
  constructor(type: string, init: PointerInit = {}) { super(type, init); this.deltaY = init.deltaY ?? 0; }
}

export class EventTargetShim {
  _listeners: Map<string, Listener[]> | null = null;
  _parentTarget(): EventTargetShim | null { return null; }
  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: ListenerOptions) {
    if (!fn) return;
    const o = typeof options === 'boolean' ? { capture: options } : options ?? {};
    const capture = !!o.capture;
    const map = (this._listeners ??= new Map());
    const list: Listener[] = map.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once: !!o.once, passive: !!o.passive });
    map.set(type, list);
    if (typeof o === 'object' && o.signal) o.signal.addEventListener('abort', () => this.removeEventListener(type, fn, { capture }));
  }
  removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const list = this._listeners?.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  _invoke(event: EventShim, phase: number) {
    const list = this._listeners?.get(event.type);
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (!list?.length && typeof handler !== 'function') return;
    event.currentTarget = this;
    for (const l of list ? list.slice() : []) {
      if (phase === 1 && !l.capture) continue;
      if (phase === 3 && l.capture) continue;
      if (l.once) this.removeEventListener(event.type, l.fn, { capture: l.capture });
      try {
        if (typeof l.fn === 'function') l.fn.call(this, event as unknown as Event);
        else l.fn.handleEvent(event as unknown as Event);
      } catch (e) { reportError(e); }
      if (event._stopNow) return;
    }
    if (phase !== 1 && typeof handler === 'function') {
      try { (handler as (e: EventShim) => void).call(this, event); } catch (e) { reportError(e); }
    }
  }
  dispatchEvent(event: EventShim) {
    event.target = this; event.srcElement = this;
    const path: EventTargetShim[] = [];
    for (let t = this._parentTarget(); t; t = t._parentTarget()) path.push(t);
    event.eventPhase = 1;
    for (let i = path.length - 1; i >= 0 && !event._stop; i--) path[i]._invoke(event, 1);
    if (!event._stop) { event.eventPhase = 2; this._invoke(event, 2); }
    if (event.bubbles) { event.eventPhase = 3; for (let i = 0; i < path.length && !event._stop; i++) path[i]._invoke(event, 3); }
    event.eventPhase = 0; event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

// ---------------------------------------------------------------------------------------------
// Nodes

/** The display size in CSS pixels, which every element reports as its box. */
export const viewport = { width: 1920, height: 1080 };

function cssName(prop: string) { return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`); }
function camelName(prop: string) { return prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()); }
/** CSSStyleDeclaration: properties as camelCase fields, with the method API on top. */
function createStyle(): CSSStyleDeclaration {
  const target: Record<string, unknown> = {};
  const api = {
    setProperty(name: string, value: string) { target[camelName(name)] = String(value); },
    getPropertyValue(name: string) { return (target[camelName(name)] as string | undefined) ?? ''; },
    removeProperty(name: string) { const k = camelName(name); const v = target[k]; delete target[k]; return v ?? ''; },
    get cssText() { return Object.entries(target).map(([k, v]) => `${cssName(k)}: ${String(v)};`).join(' '); },
    set cssText(v: string) {
      for (const k of Object.keys(target)) delete target[k];
      for (const decl of v.split(';')) { const i = decl.indexOf(':'); if (i > 0) target[camelName(decl.slice(0, i).trim())] = decl.slice(i + 1).trim(); }
    },
  };
  return new Proxy(target, {
    get(t, k) { if (k in api) return (api as Record<string | symbol, unknown>)[k]; return typeof k === 'string' ? t[k] ?? '' : undefined; },
    set(t, k, v) { if (k === 'cssText') api.cssText = String(v); else if (typeof k === 'string') t[k] = v; return true; },
  }) as unknown as CSSStyleDeclaration;
}

class ClassList {
  _el: ElementShim;
  constructor(el: ElementShim) { this._el = el; }
  _get() { return (this._el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  _set(list: string[]) { this._el.setAttribute('class', list.join(' ')); }
  add(...c: string[]) { const l = this._get(); for (const x of c) if (!l.includes(x)) l.push(x); this._set(l); }
  remove(...c: string[]) { this._set(this._get().filter((x) => !c.includes(x))); }
  contains(c: string) { return this._get().includes(c); }
  toggle(c: string, force?: boolean) { const on = force ?? !this.contains(c); if (on) this.add(c); else this.remove(c); return on; }
  get length() { return this._get().length; }
  get value() { return this._el.getAttribute('class') ?? ''; }
  toString() { return this.value; }
}

export class NodeShim extends EventTargetShim {
  static readonly ELEMENT_NODE = 1; static readonly TEXT_NODE = 3; static readonly COMMENT_NODE = 8; static readonly DOCUMENT_NODE = 9; static readonly DOCUMENT_FRAGMENT_NODE = 11;
  readonly ELEMENT_NODE = 1; readonly TEXT_NODE = 3; readonly COMMENT_NODE = 8; readonly DOCUMENT_NODE = 9;
  nodeType = 1;
  nodeName = '';
  parentNode: NodeShim | null = null;
  childNodes: NodeShim[] = [];
  _ownerDocument: DocumentShim | null = null;
  get ownerDocument(): DocumentShim | null { return this._ownerDocument ?? documentShim; }
  _parentTarget(): EventTargetShim | null { return this.parentNode ?? (this.nodeType === 9 ? windowTarget : null); }
  get parentElement(): ElementShim | null { return this.parentNode instanceof ElementShim ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): NodeShim | null { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  get previousSibling(): NodeShim | null { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null; }
  get isConnected(): boolean { return this.getRootNode().nodeType === 9; }
  hasChildNodes() { return this.childNodes.length > 0; }
  contains(other: NodeShim | null): boolean { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  getRootNode(): NodeShim { return this.parentNode ? this.parentNode.getRootNode() : this; }
  _detach(child: NodeShim) { const i = this.childNodes.indexOf(child); if (i >= 0) this.childNodes.splice(i, 1); child.parentNode = null; }
  appendChild<T extends NodeShim>(child: T): T { return this.insertBefore(child, null); }
  insertBefore<T extends NodeShim>(child: T, ref: NodeShim | null): T {
    if (child.nodeType === 11) { for (const c of child.childNodes.slice()) this.insertBefore(c, ref); return child; }
    child.parentNode?._detach(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends NodeShim>(child: T): T { this._detach(child); return child; }
  replaceChild<T extends NodeShim>(child: NodeShim, old: T): T { this.insertBefore(child, old); this._detach(old); return old; }
  remove() { this.parentNode?._detach(this); }
  append(...nodes: (NodeShim | string)[]) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new TextShim(n) : n); }
  prepend(...nodes: (NodeShim | string)[]) { for (const n of nodes.reverse()) this.insertBefore(typeof n === 'string' ? new TextShim(n) : n, this.firstChild); }
  replaceChildren(...nodes: (NodeShim | string)[]) { for (const c of this.childNodes.slice()) this._detach(c); this.append(...nodes); }
  cloneNode(_deep?: boolean): NodeShim { return new NodeShim(); }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { for (const c of this.childNodes.slice()) this._detach(c); if (v) this.appendChild(new TextShim(String(v))); }
  get nodeValue(): string | null { return null; }
  isEqualNode(other: NodeShim) { return other === this; }
  compareDocumentPosition() { return 0; }
}

export class TextShim extends NodeShim {
  data: string;
  constructor(data = '') { super(); this.nodeType = 3; this.nodeName = '#text'; this.data = data; }
  get textContent() { return this.data; }
  set textContent(v: string) { this.data = String(v); }
  get nodeValue() { return this.data; }
  set nodeValue(v: string) { this.data = String(v); }
  get length() { return this.data.length; }
}
export class CommentShim extends TextShim {
  constructor(data = '') { super(data); this.nodeType = 8; this.nodeName = '#comment'; }
}
export class DocumentFragmentShim extends NodeShim {
  constructor() { super(); this.nodeType = 11; this.nodeName = '#document-fragment'; }
}

function matches(el: ElementShim, selector: string): boolean {
  return selector.split(',').some((sel) => {
    const s = sel.trim();
    const m = /^([a-zA-Z0-9-]*|\*)((?:[#.][\w-]+)*)$/.exec(s);
    if (!m) return false;
    if (m[1] && m[1] !== '*' && el.localName !== m[1].toLowerCase()) return false;
    for (const part of m[2].match(/[#.][\w-]+/g) ?? []) {
      if (part[0] === '#' && el.id !== part.slice(1)) return false;
      if (part[0] === '.' && !el.classList.contains(part.slice(1))) return false;
    }
    return true;
  });
}

export class ElementShim extends NodeShim {
  readonly localName: string;
  readonly tagName: string;
  namespaceURI: string;
  _attrs = new Map<string, string>();
  readonly style = createStyle();
  readonly dataset: Record<string, string> = {};
  _classList: ClassList | null = null;
  tabIndex = -1;
  constructor(name: string, ns = 'http://www.w3.org/1999/xhtml') {
    super();
    this.localName = name.toLowerCase(); this.tagName = name.toUpperCase(); this.nodeName = this.tagName; this.namespaceURI = ns;
  }
  get classList() { return (this._classList ??= new ClassList(this)); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v: string) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v: string) { this.setAttribute('class', v); }
  get children(): ElementShim[] { return this.childNodes.filter((c): c is ElementShim => c instanceof ElementShim); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] ?? null; }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(name: string) { return this._attrs.get(name.toLowerCase()) ?? null; }
  setAttribute(name: string, value: string) {
    const k = name.toLowerCase();
    this._attrs.set(k, String(value));
    if (k.startsWith('data-')) this.dataset[camelName(k.slice(5))] = String(value);
    if (k === 'style') this.style.cssText = String(value);
  }
  setAttributeNS(_ns: string | null, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { const k = name.toLowerCase(); this._attrs.delete(k); if (k.startsWith('data-')) delete this.dataset[camelName(k.slice(5))]; }
  removeAttributeNS(_ns: string | null, name: string) { this.removeAttribute(name); }
  hasAttribute(name: string) { return this._attrs.has(name.toLowerCase()); }
  toggleAttribute(name: string, force?: boolean) { const on = force ?? !this.hasAttribute(name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
  matches(selector: string) { return matches(this, selector); }
  closest(selector: string): ElementShim | null { return this.matches(selector) ? this : this.parentNode instanceof ElementShim ? this.parentNode.closest(selector) : null; }
  querySelectorAll(selector: string): ElementShim[] {
    const out: ElementShim[] = [];
    const walk = (n: NodeShim) => { for (const c of n.childNodes) if (c instanceof ElementShim) { if (c.matches(selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getElementsByTagName(name: string) { return this.querySelectorAll(name.toLowerCase()); }
  getElementsByClassName(name: string) { return this.querySelectorAll(`.${name}`); }
  getBoundingClientRect() {
    const { width, height } = viewport;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() { return this; } };
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  get clientWidth() { return viewport.width; } get clientHeight() { return viewport.height; }
  get offsetWidth() { return viewport.width; } get offsetHeight() { return viewport.height; }
  get offsetLeft() { return 0; } get offsetTop() { return 0; } get offsetParent() { return null; }
  get scrollWidth() { return viewport.width; } get scrollHeight() { return viewport.height; }
  scrollTop = 0; scrollLeft = 0;
  focus() { if (documentShim) documentShim.activeElement = this; }
  blur() { if (documentShim && documentShim.activeElement === this) documentShim.activeElement = documentShim.body; }
  click() { this.dispatchEvent(new MouseEventShim('click', { bubbles: true, cancelable: true })); }
  setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
  requestFullscreen() { return Promise.reject(new Error('fullscreen is not available')); }
  scrollIntoView() {} animate() { return { cancel() {}, finished: Promise.resolve() }; }
  attachShadow() { return new DocumentFragmentShim(); }
  get innerHTML() { return this.textContent; }
  set innerHTML(v: string) { this.textContent = v.replace(/<[^>]*>/g, ''); }
  get outerHTML() { return `<${this.localName}>${this.innerHTML}</${this.localName}>`; }
  insertAdjacentElement(where: string, el: ElementShim) {
    if (where === 'beforeend') this.appendChild(el);
    else if (where === 'afterbegin') this.insertBefore(el, this.firstChild);
    else if (where === 'beforebegin') this.parentNode?.insertBefore(el, this);
    else this.parentNode?.insertBefore(el, this.nextSibling);
    return el;
  }
  cloneNode(deep = false): ElementShim {
    const el = documentShim.createElementNS(this.namespaceURI, this.localName);
    for (const [k, v] of this._attrs) el.setAttribute(k, v);
    if (deep) for (const c of this.childNodes) el.appendChild(c.cloneNode(true));
    return el;
  }
}
export class HTMLElementShim extends ElementShim {
  hidden = false; title = ''; lang = ''; dir = ''; draggable = false; inert = false;
}
export class HTMLAnchorElementShim extends HTMLElementShim {
  href = ''; download = ''; target = ''; rel = '';
  click() {
    if (this.download) N.log(0, `download ${this.download} (${this.href}) is not supported here`);
    super.click();
  }
}
export class HTMLMediaElementShim extends HTMLElementShim {
  src = ''; srcObject: unknown = null; muted = false; autoplay = false; playsInline = false; paused = true; currentTime = 0; readyState = 0;
  videoWidth = 0; videoHeight = 0; volume = 1;
  play() { return Promise.reject(new Error('media playback is not available')); }
  pause() {}
  load() {}
}

// ---------------------------------------------------------------------------------------------
// Canvas and images

let nextSource = 1;
/** Canvas bitmaps and decoded images are native memory: free them when their element is
 *  collected. Both go through the command stream, after any command that still uses them. */
const freeCanvas = new FinalizationRegistry<number>((id) => canvasCommands.destroy(id));
const freeImage = new FinalizationRegistry<number>((id) => releaseImage(id));
/** The canvas that shows on screen: the first one with a WebGL context. */
export const screenCanvas: { current: HTMLCanvasElementShim | null } = { current: null };

export class HTMLCanvasElementShim extends HTMLElementShim {
  readonly _sourceKind: number = PAYLOAD.canvas;
  readonly _sourceId = nextSource++;
  _w = 300; _h = 150;
  _ctx2d: CanvasRenderingContext2D | null = null;
  _gl: WebGL2RenderingContext | null = null;
  _bitmap = false;
  constructor() { super('canvas'); }
  get width() { return this._w; }
  set width(v: number) { this._w = Math.max(0, Math.floor(+v) || 0); this._resized(); }
  get height() { return this._h; }
  set height(v: number) { this._h = Math.max(0, Math.floor(+v) || 0); this._resized(); }
  _resized() {
    if (this._gl) this._gl._resizeSoon();
    else if (this._bitmap) { canvasCommands.resize(this._sourceId, this._w, this._h); this._ctx2d?._reset(); }
  }
  getContext(type: string, attributes: WebGLContextAttributes = {}) {
    if (type === '2d') {
      if (this._gl) return null;
      if (!this._ctx2d) {
        if (!this._bitmap) {
          canvasCommands.create(this._sourceId, this._w, this._h);
          this._bitmap = true;
          freeCanvas.register(this, this._sourceId);
        }
        this._ctx2d = new CanvasRenderingContext2D(this);
      }
      return this._ctx2d;
    }
    if (type === 'webgl2') {
      if (this._ctx2d) return null;
      if (!this._gl) {
        if (screenCanvas.current && screenCanvas.current !== this) { N.log(2, 'Only one WebGL canvas is supported'); return null; }
        screenCanvas.current = this;
        this._gl = new WebGL2RenderingContext({ canvas: this, attributes, element: this });
      }
      return this._gl;
    }
    return null;
  }
  toDataURL() { return 'data:,'; }
  toBlob(cb: (b: BlobShim | null) => void) { setTimeoutShim(() => cb(null)); }
  transferControlToOffscreen() { throw new Error('OffscreenCanvas is not available'); }
  captureStream() { throw new Error('captureStream is not available'); }
}

/** A decoded image the native side holds (by id). */
export class ImageBitmapShim {
  readonly _sourceKind: number = PAYLOAD.image;
  _sourceId: number; width: number; height: number;
  constructor(idn: number, w: number, h: number) { this._sourceId = idn; this.width = w; this.height = h; freeImage.register(this, idn, this); }
  close() { if (!this._sourceId) return; freeImage.unregister(this); releaseImage(this._sourceId); this._sourceId = 0; }
}

/** Starts a native decode of a URL (bundled path, blob: or data:) or bytes. */
function decode(src: string | ArrayBufferView, done: (id: number, w: number, h: number, error?: string) => void) {
  if (typeof src !== 'string') { N.decodeImage(src, done); return; }
  const blob = blobForUrl(src);
  if (blob) { N.decodeImage(blob._bytes, done); return; }
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const b64 = src.slice(0, comma).endsWith(';base64');
    const text = b64 ? atob(src.slice(comma + 1)) : decodeURIComponent(src.slice(comma + 1));
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    N.decodeImage(bytes, done);
    return;
  }
  let url: URLShim;
  try { url = new URLShim(src, pageUrl); } catch { done(0, 0, 0, `bad image URL ${src}`); return; }
  if (url.origin !== new URLShim(pageUrl).origin) { done(0, 0, 0, `remote images are not supported: ${src}`); return; }
  N.decodeImage(decodeURIComponent(url.pathname), done);
}

export class HTMLImageElementShim extends HTMLElementShim {
  readonly _sourceKind: number = PAYLOAD.image;
  _sourceId = 0;
  _src = '';
  naturalWidth = 0; naturalHeight = 0; complete = true; crossOrigin: string | null = null; decoding = 'auto'; loading = 'eager'; alt = '';
  _w = 0; _h = 0;
  _waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  constructor(w?: number, h?: number) { super('img'); if (w) this._w = w; if (h) this._h = h; }
  get width() { return this._w || this.naturalWidth; }
  set width(v: number) { this._w = v; }
  get height() { return this._h || this.naturalHeight; }
  set height(v: number) { this._h = v; }
  get src() { return this._src; }
  set src(v: string) {
    this._src = String(v);
    this.complete = false;
    const want = this._src;
    decode(want, (idn, w, h, error) => {
      if (this._src !== want) { if (idn) N.releaseImage(idn); return; }
      this.complete = true;
      if (!idn) {
        N.log(1, `image failed: ${want}: ${error ?? ''}`);
        this.dispatchEvent(new EventShim('error'));
        for (const p of this._waiters.splice(0)) p.reject(new Error(error ?? 'image failed'));
        return;
      }
      if (this._sourceId) { freeImage.unregister(this); releaseImage(this._sourceId); }
      this._sourceId = idn;
      freeImage.register(this, idn, this); this.naturalWidth = w; this.naturalHeight = h;
      this.dispatchEvent(new EventShim('load'));
      for (const p of this._waiters.splice(0)) p.resolve();
    });
  }
  get currentSrc() { return this._src; }
  decode() {
    if (this.complete && this._sourceId) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this._waiters.push({ resolve, reject }));
  }
}

type BitmapSource = HTMLImageElementShim | HTMLCanvasElementShim | ImageBitmapShim | BlobShim | { width: number; height: number; data: Uint8ClampedArray };
export function createImageBitmapShim(src: BitmapSource, ..._rest: unknown[]): Promise<ImageBitmapShim> {
  if (src instanceof BlobShim) {
    return new Promise((resolve, reject) => decode(src._bytes, (idn, w, h, error) => (idn ? resolve(new ImageBitmapShim(idn, w, h)) : reject(new Error(error ?? 'decode failed')))));
  }
  if (src instanceof HTMLImageElementShim) {
    return src.decode().then(() => new Promise<ImageBitmapShim>((resolve, reject) => decode(src.src, (idn, w, h, error) => (idn ? resolve(new ImageBitmapShim(idn, w, h)) : reject(new Error(error ?? 'decode failed'))))));
  }
  // Canvases and pixel data aren't copied: the bitmap reads the canvas as it is when used.
  if (src instanceof HTMLCanvasElementShim) return Promise.resolve(src as unknown as ImageBitmapShim);
  if (src instanceof ImageBitmapShim) return Promise.resolve(src);
  return Promise.reject(new Error('createImageBitmap: unsupported source'));
}

// ---------------------------------------------------------------------------------------------
// Document

export class DocumentShim extends NodeShim {
  readonly documentElement: HTMLElementShim;
  readonly head: HTMLElementShim;
  readonly body: HTMLElementShim;
  activeElement: ElementShim | null = null;
  readonly fonts = { load: () => Promise.resolve([]), ready: Promise.resolve(), check: () => true, add() {}, addEventListener() {}, status: 'loaded' };
  hidden = false;
  visibilityState = 'visible';
  readyState = 'complete';
  title = 'aerodance';
  cookie = '';
  readonly defaultView = globalThis;
  constructor() {
    super();
    this.nodeType = 9; this.nodeName = '#document';
    this.documentElement = new HTMLElementShim('html');
    this.head = new HTMLElementShim('head');
    this.body = new HTMLElementShim('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  get location() { return (globalThis as unknown as { location: unknown }).location; }
  get fullscreenElement() { return null; }
  get fullscreenEnabled() { return false; }
  get pointerLockElement() { return null; }
  createElement(name: string) { return this.createElementNS('http://www.w3.org/1999/xhtml', name); }
  createElementNS(ns: string | null, name: string): ElementShim {
    const tag = name.toLowerCase();
    let el: ElementShim;
    if (tag === 'canvas') el = new HTMLCanvasElementShim();
    else if (tag === 'img') el = new HTMLImageElementShim();
    else if (tag === 'a') el = new HTMLAnchorElementShim('a');
    else if (tag === 'video' || tag === 'audio') el = new HTMLMediaElementShim(tag);
    else if (ns && ns !== 'http://www.w3.org/1999/xhtml') el = new ElementShim(name, ns);
    else el = new HTMLElementShim(tag);
    el._ownerDocument = this;
    return el;
  }
  createTextNode(data: string) { const t = new TextShim(data); t._ownerDocument = this; return t; }
  createComment(data: string) { const t = new CommentShim(data); t._ownerDocument = this; return t; }
  createDocumentFragment() { return new DocumentFragmentShim(); }
  createEvent() { return new EventShim(''); }
  getElementById(idn: string) { return this.documentElement.querySelector(`#${idn}`); }
  querySelector(selector: string) { return this.documentElement.matches(selector) ? this.documentElement : this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  getElementsByTagName(name: string) { return this.documentElement.getElementsByTagName(name); }
  hasFocus() { return true; }
  exitFullscreen() { return Promise.resolve(); }
  getSelection() { return null; }
  elementFromPoint() { return null; }
  get ownerDocument() { return null; }
}

/** window's EventTarget: globalThis gets these methods. */
export const windowTarget = new EventTargetShim();
export const documentShim = new DocumentShim();
