// WebSocket and EventSource over URLSession (src/Net.mm): what phone pairing needs to reach the
// pairing server from this host (packages/pairing/browser/: the events stream, and the relay
// that stands in for WebRTC, which there is none of here).
import { native } from './native.ts';
import { EventShim, EventTargetShim } from './dom.ts';
import { BlobShim, TextDecoderShim, TextEncoderShim, URLShim, pageUrl, setTimeoutShim } from './web.ts';

/** The commands of native.net (src/Net.mm). */
const NET = { socketOpen: 1, socketSend: 2, socketClose: 3, streamOpen: 4, streamClose: 5 } as const;
type NetCallback = (kind: string, a?: unknown, b?: unknown) => void;
const net = (command: number, ...args: unknown[]) => native.net(command, ...args);

export class MessageEventShim extends EventShim {
  readonly data: unknown; readonly origin: string; readonly lastEventId: string;
  constructor(type: string, init: { data?: unknown; origin?: string; lastEventId?: string } = {}) {
    super(type);
    this.data = init.data ?? null; this.origin = init.origin ?? ''; this.lastEventId = init.lastEventId ?? '';
  }
}
export class CloseEventShim extends EventShim {
  readonly code: number; readonly reason: string; readonly wasClean: boolean;
  constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean } = {}) {
    super(type);
    this.code = init.code ?? 0; this.reason = init.reason ?? ''; this.wasClean = !!init.wasClean;
  }
}

const absolute = (url: string | URLShim) => new URLShim(String(url), pageUrl).href;

export class WebSocketShim extends EventTargetShim {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = ''; readonly extensions = '';
  readyState = 0;
  /** Bytes handed to send() that haven't gone out yet. */
  bufferedAmount = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: ((e: EventShim) => void) | null = null;
  onmessage: ((e: MessageEventShim) => void) | null = null;
  onclose: ((e: CloseEventShim) => void) | null = null;
  onerror: ((e: EventShim) => void) | null = null;
  _id: number;
  constructor(url: string | URLShim) {
    super();
    this.url = absolute(url);
    if (!/^wss?:/.test(this.url)) throw new SyntaxError(`WebSocket: not a ws: or wss: URL: ${this.url}`);
    const callback: NetCallback = (kind, a, b) => this._event(kind, a, b);
    this._id = net(NET.socketOpen, this.url, callback) as number;
    if (!this._id) setTimeoutShim(() => this._event('close', 1006, 'bad URL'));
  }
  _event(kind: string, a?: unknown, b?: unknown) {
    if (kind === 'open') {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new EventShim('open'));
    } else if (kind === 'text' || kind === 'binary') {
      if (this.readyState !== 1) return;
      const data = kind === 'text' ? a : this.binaryType === 'arraybuffer' ? a : new BlobShim([a as ArrayBuffer]);
      this.dispatchEvent(new MessageEventShim('message', { data, origin: new URLShim(this.url).origin }));
    } else if (kind === 'sent') {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - (a as number));
    } else if (kind === 'close') {
      if (this.readyState === 3) return;
      const opened = this.readyState !== 0;
      this.readyState = 3;
      this.bufferedAmount = 0;
      const code = a as number;
      // A socket that never opened, or dropped without a closing handshake, errors first.
      if (!opened || code === 1006) this.dispatchEvent(new EventShim('error'));
      this.dispatchEvent(new CloseEventShim('close', { code, reason: String(b ?? ''), wasClean: code !== 1006 }));
    }
  }
  send(data: string | ArrayBuffer | ArrayBufferView | BlobShim) {
    if (this.readyState === 0) throw new Error('InvalidStateError: the WebSocket is still connecting');
    if (this.readyState !== 1) return;
    const payload = data instanceof BlobShim ? data._bytes : data;
    this.bufferedAmount += typeof payload === 'string' ? new TextEncoderShim().encode(payload).byteLength : payload.byteLength;
    net(NET.socketSend, this._id, payload);
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    net(NET.socketClose, this._id, code, reason);
  }
}

const NL = 10, CR = 13;

export class EventSourceShim extends EventTargetShim {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((e: EventShim) => void) | null = null;
  onmessage: ((e: MessageEventShim) => void) | null = null;
  onerror: ((e: EventShim) => void) | null = null;
  _id = 0;
  _retry = 3000;
  _lastId = '';
  /** Bytes of a line not finished yet, and the event being put together. */
  _pending = new Uint8Array(0);
  _data: string[] = [];
  _type = '';
  _decoder = new TextDecoderShim();
  constructor(url: string | URLShim) {
    super();
    this.url = absolute(url);
    this._connect();
  }
  _connect() {
    const headers: Record<string, string> = { accept: 'text/event-stream', 'cache-control': 'no-store' };
    if (this._lastId) headers['last-event-id'] = this._lastId;
    const callback: NetCallback = (kind, a, b) => this._event(kind, a, b);
    const id = this._id = net(NET.streamOpen, this.url, JSON.stringify(headers), callback) as number;
    if (!id) setTimeoutShim(() => this._fail());
  }
  _event(kind: string, a?: unknown, b?: unknown) {
    if (this.readyState === 2) return;
    if (kind === 'response') {
      // Anything but a stream of events closes it for good, as in a browser.
      if (a !== 200 || !String(b).toLowerCase().startsWith('text/event-stream')) { this._fail(); return; }
      this.readyState = 1;
      this._pending = new Uint8Array(0); this._data = []; this._type = '';
      this.dispatchEvent(new EventShim('open'));
    } else if (kind === 'data') {
      this._feed(new Uint8Array(a as ArrayBuffer));
    } else if (kind === 'end') {
      // The connection went (or never came): try again after the retry delay.
      this.readyState = 0;
      this.dispatchEvent(new EventShim('error'));
      setTimeoutShim(() => { if (this.readyState === 0) this._connect(); }, this._retry);
    }
  }
  _fail() {
    this.readyState = 2;
    net(NET.streamClose, this._id);
    this.dispatchEvent(new EventShim('error'));
  }
  /** Splits the stream into lines (bytes first, so a character split across chunks survives). */
  _feed(chunk: Uint8Array) {
    const bytes = new Uint8Array(this._pending.byteLength + chunk.byteLength);
    bytes.set(this._pending); bytes.set(chunk, this._pending.byteLength);
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== NL && bytes[i] !== CR) continue;
      this._line(this._decoder.decode(bytes.subarray(start, i)));
      if (bytes[i] === CR && bytes[i + 1] === NL) i++;
      start = i + 1;
      if (this.readyState === 2) return;
    }
    this._pending = bytes.slice(start);
  }
  _line(line: string) {
    if (line === '') {
      if (this._data.length) {
        const type = this._type || 'message';
        this.dispatchEvent(new MessageEventShim(type, { data: this._data.join('\n'), origin: new URLShim(this.url).origin, lastEventId: this._lastId }));
      }
      this._data = []; this._type = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this._data.push(value);
    else if (field === 'event') this._type = value;
    else if (field === 'id' && !value.includes('\0')) this._lastId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this._retry = Number(value);
  }
  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    net(NET.streamClose, this._id);
  }
}
