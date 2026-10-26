// The Web platform pieces JavaScriptCore doesn't have: timers, animation frames, console,
// encoding, URL, Blob, fetch, storage and crypto, over the native host.
import { native } from './native.ts';

const N = native;
type Fn = (...args: unknown[]) => void;

// ---------------------------------------------------------------------------------------------
// Console

function format(args: unknown[]) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
    try { return typeof a === 'object' ? JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) ?? String(a) : String(a); } catch { return String(a); }
  }).join(' ');
}
const logAt = (level: number) => (...args: unknown[]) => N.log(level, format(args));
export const consoleShim = {
  log: logAt(0), info: logAt(0), debug: logAt(0), warn: logAt(1), error: logAt(2), trace: logAt(0),
  group: logAt(0), groupCollapsed: logAt(0), groupEnd: () => {}, table: logAt(0), dir: logAt(0),
  time: () => {}, timeEnd: () => {}, assert: (ok: unknown, ...args: unknown[]) => { if (!ok) N.log(2, `Assertion failed: ${format(args)}`); },
  count: () => {},
};

// ---------------------------------------------------------------------------------------------
// Timers: one native wake-up for the earliest deadline.

interface Timer { id: number; at: number; fn: Fn; args: unknown[]; every: number }
const timers = new Map<number, Timer>();
let nextTimer = 1;
let wakeAt = Infinity;

function schedule() {
  let soonest = Infinity;
  for (const t of timers.values()) if (t.at < soonest) soonest = t.at;
  if (soonest === Infinity || soonest >= wakeAt) return;
  wakeAt = soonest;
  N.wake(Math.max(0, soonest - N.now()));
}
export function setTimeoutShim(fn: Fn | string, ms = 0, ...args: unknown[]) {
  const id = nextTimer++;
  if (typeof fn !== 'function') return id;
  timers.set(id, { id, at: N.now() + Math.max(0, +ms || 0), fn, args, every: -1 });
  schedule();
  return id;
}
export function setIntervalShim(fn: Fn, ms = 0, ...args: unknown[]) {
  const id = nextTimer++;
  const every = Math.max(1, +ms || 0);
  timers.set(id, { id, at: N.now() + every, fn, args, every });
  schedule();
  return id;
}
export function clearTimer(id?: number) { if (id !== undefined) timers.delete(id); }

/** The host's timer wake-up: runs every timer that is due. */
export function runTimers() {
  wakeAt = Infinity;
  const now = N.now();
  const due = [...timers.values()].filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
  for (const t of due) {
    if (!timers.has(t.id)) continue;
    if (t.every >= 0) t.at = now + t.every; else timers.delete(t.id);
    try { t.fn(...t.args); } catch (e) { reportError(e); }
  }
  schedule();
}

export function reportError(e: unknown) {
  N.log(2, `Uncaught ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e)}`);
}

// ---------------------------------------------------------------------------------------------
// Animation frames

let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
export function requestAnimationFrameShim(cb: FrameRequestCallback) { const id = nextFrameId++; frameCallbacks.set(id, cb); return id; }
export function cancelAnimationFrameShim(id: number) { frameCallbacks.delete(id); }
export function runFrameCallbacks(ts: number) {
  const list = frameCallbacks;
  frameCallbacks = new Map();
  for (const cb of list.values()) {
    try { cb(ts); } catch (e) { reportError(e); }
  }
}
export const hasFrameCallbacks = () => frameCallbacks.size > 0;

// ---------------------------------------------------------------------------------------------
// Encoding

export class TextEncoderShim {
  readonly encoding = 'utf-8';
  encode(s = '') {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  encodeInto(s: string, dest: Uint8Array) {
    const bytes = this.encode(s);
    const n = Math.min(bytes.length, dest.length);
    dest.set(bytes.subarray(0, n));
    return { read: s.length, written: n };
  }
}

export class TextDecoderShim {
  readonly encoding: string;
  readonly fatal = false;
  readonly ignoreBOM = false;
  constructor(label = 'utf-8') { this.encoding = label.toLowerCase(); }
  decode(input?: ArrayBuffer | ArrayBufferView) {
    if (!input) return '';
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (this.encoding === 'utf-16le') { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; }
    if (this.encoding !== 'utf-8' && this.encoding !== 'utf8') { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
    const parts: string[] = [];
    let codes: number[] = [];
    let i = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
    while (i < b.length) {
      const c = b[i++];
      let cp: number;
      if (c < 0x80) cp = c;
      else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
      else if (c < 0xf0) { cp = ((c & 15) << 12) | ((b[i] & 63) << 6) | (b[i + 1] & 63); i += 2; } else { cp = ((c & 7) << 18) | ((b[i] & 63) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; }
      if (cp > 0xffff) { cp -= 0x10000; codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); } else codes.push(cp);
      if (codes.length > 8192) { parts.push(String.fromCharCode(...codes)); codes = []; }
    }
    parts.push(String.fromCharCode(...codes));
    return parts.join('');
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function btoaShim(s: string) {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
  }
  return out;
}
export function atobShim(s: string) {
  s = s.replace(/[^A-Za-z0-9+/]/g, '');
  let out = '';
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
    out += String.fromCharCode((n >> 16) & 255);
    if (i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
    if (i + 3 < s.length) out += String.fromCharCode(n & 255);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// URL

export class URLSearchParamsShim {
  _list: [string, string][] = [];
  constructor(init?: string | Record<string, string> | [string, string][] | URLSearchParamsShim) {
    if (typeof init === 'string') {
      for (const part of init.replace(/^\?/, '').split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        const dec = (x: string) => decodeURIComponent(x.replace(/\+/g, ' '));
        this._list.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
      }
    } else if (init instanceof URLSearchParamsShim) this._list = init._list.map(([k, v]) => [k, v]);
    else if (Array.isArray(init)) this._list = init.map(([k, v]) => [String(k), String(v)]);
    else if (init) this._list = Object.entries(init).map(([k, v]) => [k, String(v)]);
  }
  get size() { return this._list.length; }
  get(k: string) { const e = this._list.find(([x]) => x === k); return e ? e[1] : null; }
  getAll(k: string) { return this._list.filter(([x]) => x === k).map(([, v]) => v); }
  has(k: string) { return this._list.some(([x]) => x === k); }
  set(k: string, v: string) { const i = this._list.findIndex(([x]) => x === k); this.delete(k); this._list.splice(i < 0 ? this._list.length : i, 0, [k, String(v)]); }
  append(k: string, v: string) { this._list.push([k, String(v)]); }
  delete(k: string) { this._list = this._list.filter(([x]) => x !== k); }
  forEach(fn: (v: string, k: string, p: URLSearchParamsShim) => void) { for (const [k, v] of this._list) fn(v, k, this); }
  keys() { return this._list.map(([k]) => k)[Symbol.iterator](); }
  values() { return this._list.map(([, v]) => v)[Symbol.iterator](); }
  entries() { return this._list.map(([k, v]) => [k, v] as [string, string])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  sort() { this._list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); }
  toString() { return this._list.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
}

const blobUrls = new Map<string, BlobShim>();
let nextBlobUrl = 1;

export class URLShim {
  protocol = ''; username = ''; password = ''; hostname = ''; port = ''; pathname = '/'; hash = '';
  searchParams = new URLSearchParamsShim();
  constructor(url: string | URLShim, base?: string | URLShim) {
    const s = String(url);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(s);
    if (m) this._parseAbsolute(m[1].toLowerCase(), m[2]);
    else {
      if (base === undefined) throw new TypeError(`Invalid URL: ${s}`);
      const b = new URLShim(base);
      this.protocol = b.protocol; this.hostname = b.hostname; this.port = b.port;
      if (s.startsWith('//')) this._parseAbsolute(b.protocol, s);
      else if (s.startsWith('/')) this._setPath(s);
      else if (s.startsWith('?')) { this.pathname = b.pathname; this._setPath(b.pathname + s); } else if (s.startsWith('#')) { this.pathname = b.pathname; this.search = b.search; this.hash = s; } else this._setPath(b.pathname.replace(/[^/]*$/, '') + s);
    }
  }
  _parseAbsolute(protocol: string, rest: string) {
    this.protocol = protocol;
    if (rest.startsWith('//')) {
      const end = rest.slice(2).search(/[/?#]/);
      const authority = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
      const at = authority.lastIndexOf('@');
      const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
      const colon = hostPort.lastIndexOf(':');
      if (colon >= 0 && !hostPort.endsWith(']')) { this.hostname = hostPort.slice(0, colon).toLowerCase(); this.port = hostPort.slice(colon + 1); } else this.hostname = hostPort.toLowerCase();
      this._setPath(end < 0 ? '/' : rest.slice(2 + end));
    } else this._setPath(rest);
  }
  _setPath(p: string) {
    const h = p.indexOf('#');
    if (h >= 0) { this.hash = p.slice(h); p = p.slice(0, h); } else this.hash = '';
    const q = p.indexOf('?');
    this.searchParams = new URLSearchParamsShim(q >= 0 ? p.slice(q + 1) : '');
    p = q >= 0 ? p.slice(0, q) : p;
    if (this.protocol === 'blob:' || this.protocol === 'data:') { this.pathname = p; return; }
    // Dot segments: a trailing '.' or '..' leaves the path ending in a slash.
    const out: string[] = [];
    const segs = p.split('/').slice(1);
    segs.forEach((seg, i) => {
      const last = i === segs.length - 1;
      if (seg === '..') { out.pop(); if (last) out.push(''); } else if (seg === '.') { if (last) out.push(''); } else out.push(seg);
    });
    this.pathname = `/${out.join('/')}`;
  }
  get search() { const s = this.searchParams.toString(); return s ? `?${s}` : ''; }
  set search(v: string) { this.searchParams = new URLSearchParamsShim(v); }
  get host() { return this.port ? `${this.hostname}:${this.port}` : this.hostname; }
  get origin() { return this.hostname ? `${this.protocol}//${this.host}` : 'null'; }
  get href() {
    if (this.protocol === 'blob:' || this.protocol === 'data:') return `${this.protocol}${this.pathname}`;
    return `${this.protocol}//${this.host}${this.pathname}${this.search}${this.hash}`;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
  static createObjectURL(blob: BlobShim) { const url = `blob:aerodance/${nextBlobUrl++}`; blobUrls.set(url, blob); return url; }
  static revokeObjectURL(url: string) { blobUrls.delete(url); }
  static canParse(url: string, base?: string) { try { new URLShim(url, base); return true; } catch { return false; } }
}
export const blobForUrl = (url: string) => blobUrls.get(url);

// ---------------------------------------------------------------------------------------------
// Blob, Response, Headers, fetch

type BlobPart = BlobShim | ArrayBuffer | ArrayBufferView | string;
const toBytes = (p: BlobPart): Uint8Array => {
  if (p instanceof BlobShim) return p._bytes;
  if (typeof p === 'string') return new TextEncoderShim().encode(p);
  if (p instanceof ArrayBuffer) return new Uint8Array(p);
  return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
};
export class BlobShim {
  _bytes: Uint8Array;
  readonly type: string;
  constructor(parts: BlobPart[] = [], options: { type?: string } = {}) {
    const chunks = parts.map(toBytes);
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    this._bytes = chunks.length === 1 ? chunks[0] : new Uint8Array(total);
    if (chunks.length !== 1) { let o = 0; for (const c of chunks) { this._bytes.set(c, o); o += c.byteLength; } }
    this.type = options.type ?? '';
  }
  get size() { return this._bytes.byteLength; }
  arrayBuffer() { return Promise.resolve(this._bytes.slice().buffer); }
  bytes() { return Promise.resolve(this._bytes.slice()); }
  text() { return Promise.resolve(new TextDecoderShim().decode(this._bytes)); }
  slice(start = 0, end = this.size, type = '') { const b = new BlobShim([], { type }); b._bytes = this._bytes.slice(start, end); return b; }
}

/**
 * Files the page keeps (globalThis.__aerodanceFiles; the game's songs/folderSongs.ts): tvOS may
 * delete them when it runs short of space. Paths are relative and '/'-separated.
 */
export const appFilesShim = {
  read: (path: string) => N.fileRead(path),
  write(path: string, bytes: Uint8Array) {
    const why = N.fileWrite(path, bytes);
    if (why === 'full') throw Object.assign(new Error('Out of space'), { name: 'QuotaExceededError' });
    if (why) throw new Error(`Couldn't write ${path}: ${why}`);
  },
  list: (path: string) => JSON.parse(N.fileList(path)) as { name: string; size: number; dir: boolean }[],
  remove: (path: string) => N.fileRemove(path),
  move(from: string, to: string) {
    const why = N.fileMove(from, to);
    if (why) throw new Error(`Couldn't move ${from}: ${why}`);
  },
};
export class FileShim extends BlobShim {
  readonly name: string;
  readonly lastModified = Date.now();
  constructor(parts: BlobPart[], name: string, options?: { type?: string }) { super(parts, options); this.name = name; }
}

export class HeadersShim {
  _map = new Map<string, string>();
  constructor(init?: Record<string, string> | [string, string][] | HeadersShim) {
    if (init instanceof HeadersShim) init._map.forEach((v, k) => this._map.set(k, v));
    else if (Array.isArray(init)) for (const [k, v] of init) this.set(k, v);
    else if (init) for (const [k, v] of Object.entries(init)) this.set(k, v);
  }
  get(k: string) { return this._map.get(k.toLowerCase()) ?? null; }
  set(k: string, v: string) { this._map.set(k.toLowerCase(), String(v)); }
  append(k: string, v: string) { const old = this.get(k); this.set(k, old ? `${old}, ${v}` : v); }
  has(k: string) { return this._map.has(k.toLowerCase()); }
  delete(k: string) { this._map.delete(k.toLowerCase()); }
  forEach(fn: (v: string, k: string) => void) { this._map.forEach(fn); }
  entries() { return this._map.entries(); }
  [Symbol.iterator]() { return this._map.entries(); }
}

export class ResponseShim {
  readonly status: number; readonly statusText: string; readonly headers: HeadersShim; readonly url: string;
  readonly type = 'basic'; readonly redirected = false;
  _body: Uint8Array | null; bodyUsed = false;
  constructor(body?: BlobPart | null, init: { status?: number; statusText?: string; headers?: Record<string, string> | HeadersShim; url?: string } = {}) {
    this._body = body === null || body === undefined ? null : toBytes(body);
    this.status = init.status ?? 200; this.statusText = init.statusText ?? '';
    this.headers = new HeadersShim(init.headers); this.url = init.url ?? '';
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  get body() {
    // A minimal ReadableStream: one chunk. Enough for code that reads it with a reader.
    const bytes = this._body;
    let done = false;
    return bytes && {
      getReader: () => ({
        read: () => Promise.resolve(done ? { done: true, value: undefined } : (done = true, { done: false, value: bytes })),
        releaseLock() {}, cancel: () => Promise.resolve(),
      }),
    };
  }
  _take() { this.bodyUsed = true; return this._body ?? new Uint8Array(0); }
  arrayBuffer() { const b = this._take(); return Promise.resolve(b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer as ArrayBuffer : b.slice().buffer); }
  bytes() { return Promise.resolve(this._take().slice()); }
  text() { return Promise.resolve(new TextDecoderShim().decode(this._take())); }
  json() { return this.text().then((t) => JSON.parse(t) as unknown); }
  blob() { return Promise.resolve(new BlobShim([this._take()], { type: this.headers.get('content-type') ?? '' })); }
  clone() { return new ResponseShim(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); }
  static json(data: unknown, init?: { status?: number }) { return new ResponseShim(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json' } }); }
  static error() { return new ResponseShim(null, { status: 0 }); }
}

const MIME: Record<string, string> = {
  json: 'application/json', js: 'text/javascript', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml', glb: 'model/gltf-binary', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
};

/** The page's own URL (the host's virtual origin) for resolving relative URLs. */
export let pageUrl = 'http://aerodance.local/';
export const setPageUrl = (url: string) => { pageUrl = url; };

type RequestInit = { method?: string; body?: BlobPart | null; headers?: Record<string, string> | HeadersShim; credentials?: string; signal?: unknown; mode?: string };
export class RequestShim {
  readonly url: string; readonly method: string; readonly headers: HeadersShim; readonly body: BlobPart | null;
  readonly credentials: string; readonly signal: unknown; readonly mode: string;
  constructor(input: string | URLShim | RequestShim, init: RequestInit = {}) {
    const base = input instanceof RequestShim ? input : null;
    this.url = base ? base.url : String(input instanceof URLShim ? input.href : input);
    this.method = (init.method ?? base?.method ?? 'GET').toUpperCase();
    this.headers = new HeadersShim(init.headers ?? base?.headers);
    this.body = init.body ?? base?.body ?? null;
    this.credentials = init.credentials ?? 'same-origin'; this.signal = init.signal ?? null; this.mode = init.mode ?? 'cors';
  }
  clone() { return new RequestShim(this); }
}

export function fetchShim(input: string | URLShim | RequestShim, initArg: RequestInit = {}) {
  const raw = typeof input === 'string' ? input : input instanceof URLShim ? input.href : input.url;
  const init: RequestInit = input instanceof RequestShim ? { method: input.method, body: input.body, headers: input.headers, ...initArg } : initArg;
  return new Promise<ResponseShim>((resolve, reject) => {
    const blob = blobUrls.get(raw);
    if (blob) { resolve(new ResponseShim(blob._bytes, { headers: { 'content-type': blob.type } })); return; }
    if (raw.startsWith('data:')) {
      const comma = raw.indexOf(',');
      const meta = raw.slice(5, comma), data = raw.slice(comma + 1);
      const text = meta.endsWith(';base64') ? atobShim(data) : decodeURIComponent(data);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      resolve(new ResponseShim(bytes, { headers: { 'content-type': meta.replace(/;base64$/, '') } }));
      return;
    }
    let url: URLShim;
    try { url = new URLShim(raw, pageUrl); } catch (e) { reject(e); return; }
    const page = new URLShim(pageUrl);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.origin === page.origin && method === 'GET') {
      // Bundled files, read off the app bundle.
      const path = decodeURIComponent(url.pathname);
      const file = N.readFile(path.endsWith('/') ? `${path}index.html` : path);
      setTimeoutShim(() => {
        if (!file) resolve(new ResponseShim('not found', { status: 404, url: url.href }));
        else resolve(new ResponseShim(file, { url: url.href, headers: { 'content-type': MIME[path.split('.').pop() ?? ''] ?? 'application/octet-stream', 'content-length': String(file.byteLength) } }));
      });
      return;
    }
    const body = init.body === undefined || init.body === null ? null : typeof init.body === 'string' ? init.body : toBytes(init.body);
    const headers = init.headers instanceof HeadersShim ? Object.fromEntries(init.headers._map) : init.headers ?? {};
    N.http(method, url.href, body, JSON.stringify(headers), (status, bytes, headers) => {
      if (status === 0) { reject(new TypeError(`fetch failed: ${headers}`)); return; }
      resolve(new ResponseShim(bytes ? new Uint8Array(bytes) : null, { status, url: url.href, headers: JSON.parse(headers || '{}') as Record<string, string> }));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Storage and crypto

export class StorageShim {
  getItem(k: string) { return N.storageGet(String(k)); }
  setItem(k: string, v: string) { N.storageSet(String(k), String(v)); }
  removeItem(k: string) { N.storageSet(String(k), null); }
  clear() { for (const k of this._keys()) N.storageSet(k, null); }
  key(i: number) { return this._keys()[i] ?? null; }
  get length() { return this._keys().length; }
  _keys() { return JSON.parse(N.storageKeys()) as string[]; }
}

const DIGESTS: Record<string, number> = { 'SHA-1': 1, 'SHA-256': 256, 'SHA-384': 384, 'SHA-512': 512 };
export const cryptoShim = {
  getRandomValues<T extends ArrayBufferView>(a: T) { N.randomBytes(a); return a; },
  randomUUID() {
    const b = new Uint8Array(16); N.randomBytes(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
  subtle: {
    digest(algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView) {
      const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
      const alg = DIGESTS[name];
      if (!alg) return Promise.reject(new Error(`digest: ${name} is not supported`));
      return Promise.resolve(N.digest(alg, data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    },
  },
};

export function structuredCloneShim<T>(v: T): T {
  const seen = new Map<unknown, unknown>();
  const clone = (x: unknown): unknown => {
    if (typeof x !== 'object' || x === null) return x;
    if (seen.has(x)) return seen.get(x);
    if (ArrayBuffer.isView(x)) return (x as unknown as { slice(): unknown }).slice();
    if (x instanceof ArrayBuffer) return x.slice(0);
    if (x instanceof Date) return new Date(x.getTime());
    if (x instanceof Map) { const m = new Map(); seen.set(x, m); x.forEach((v2, k) => m.set(clone(k), clone(v2))); return m; }
    if (x instanceof Set) { const s = new Set(); seen.set(x, s); x.forEach((v2) => s.add(clone(v2))); return s; }
    const out: Record<string, unknown> | unknown[] = Array.isArray(x) ? [] : {};
    seen.set(x, out);
    for (const [k, v2] of Object.entries(x)) (out as Record<string, unknown>)[k] = clone(v2);
    return out;
  };
  return clone(v) as T;
}
