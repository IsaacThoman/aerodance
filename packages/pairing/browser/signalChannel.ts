import { parsePairingEvent } from '../signals.ts';
import type { CreatedRoom, JoinedRoom, PairingEvent, Signal } from '../signals.ts';

/*
 * The browser end of the pairing server (packages/pairing/server.ts): create or join a room,
 * then hear the other side's signals on an events stream and post ours.
 *
 * const room = await createRoom();                     // the game
 * const { token } = await joinRoom(code, savedToken);  // the phone
 * const channel = new SignalChannel({ code, token, onEvent });
 * channel.open(); channel.send({ type: 'hello', device }); channel.leave();
 */

export const PAIRING_BASE = '/pair';

/** A pairing request the server turned down, with its reason. */
export class PairingError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Fetch = typeof fetch;
/** The part of an EventSource the channel uses; replaceable in tests. */
export interface EventStream {
  readyState: number;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
const CLOSED = 2;
// After the events stream fails outright (a proxy error, the service restarting), check the
// room and listen again this long after.
const RETRY_MS = 2000;

async function post<T>(path: string, body: unknown, fetchFn: Fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new PairingError(0, 'Could not reach the pairing server. Check your connection.');
  }
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof data === 'object' && data && 'error' in data && typeof data.error === 'string' ? data.error : '';
    // No reason given when creating a room: nothing answers at /pair (a static host, or the
    // pairing service is down).
    throw new PairingError(res.status, message || (path.endsWith('/rooms') ? 'Phone pairing is not available on this server.' : 'Pairing failed. Try again.'));
  }
  return data as T;
}

/** A new room for the game: its code and the game's token. */
export async function createRoom(base = PAIRING_BASE, fetchFn?: Fetch): Promise<CreatedRoom> {
  const room = await post<CreatedRoom>(`${base}/rooms`, {}, fetchFn);
  if (!room || typeof room.code !== 'string' || typeof room.token !== 'string' || !Array.isArray(room.iceServers)) throw new PairingError(0, 'Phone pairing is not available on this server.');
  return room;
}

/** The phone's place in the room with this code (pass the token from an earlier join to keep it). */
export async function joinRoom(code: string, token: string | null, base = PAIRING_BASE, fetchFn?: Fetch): Promise<JoinedRoom> {
  const joined = await post<JoinedRoom>(`${base}/rooms/${code}/join`, { token }, fetchFn);
  if (!joined || typeof joined.token !== 'string' || !Array.isArray(joined.iceServers)) throw new PairingError(0, 'Pairing failed. Try again.');
  return joined;
}

export interface SignalChannelOptions {
  code: string;
  token: string;
  /** Each signal from the other side, and the server's own events. */
  onEvent: (event: PairingEvent) => void;
  base?: string;
  fetch?: Fetch;
  createStream?: (url: string) => EventStream;
}

export class SignalChannel {
  code: string;
  token: string;
  base: string;
  onEvent: (event: PairingEvent) => void;
  fetch: Fetch;
  createStream: (url: string) => EventStream;
  stream: EventStream | null = null;
  /** Stopped listening. */
  ended = false;
  /** The server ended the room (or no longer knows this token). */
  gone = false;
  retry: ReturnType<typeof setTimeout> | undefined;
  constructor({ code, token, onEvent, base = PAIRING_BASE, fetch: fetchFn = (...args) => fetch(...args), createStream = (url) => new EventSource(url) }: SignalChannelOptions) {
    this.code = code; this.token = token; this.onEvent = onEvent; this.base = base; this.fetch = fetchFn; this.createStream = createStream;
  }
  get room() { return `${this.base}/rooms/${this.code}`; }

  /** Starts listening; the stream reconnects by itself after network errors and failed responses. */
  open() {
    this.stream?.close();
    const stream = this.stream = this.createStream(`${this.room}/events?token=${encodeURIComponent(this.token)}`);
    stream.onmessage = ({ data }) => {
      let value: unknown;
      try { value = JSON.parse(data); } catch { return; }
      const event = parsePairingEvent(value);
      if (event?.type === 'closed') this.end(event.reason);
      else if (event) this.onEvent(event);
    };
    // A failed response closes an EventSource for good: ended if the server no longer knows the
    // room or this token, otherwise (a proxy error, a restart in progress) listen again shortly.
    stream.onerror = () => {
      if (stream !== this.stream || stream.readyState !== CLOSED) return;
      this.stream = null;
      void this.check().then((alive) => {
        if (this.ended) return;
        if (!alive) this.end('The pairing ended. Pair again.');
        else this.retry = setTimeout(() => { if (!this.ended) this.open(); }, RETRY_MS);
      });
    };
  }

  /** False once the server says the room or this token is gone; true while it might be back. */
  async check() {
    try {
      const res = await this.fetch(`${this.room}?token=${encodeURIComponent(this.token)}`, { cache: 'no-store' });
      return res.status !== 403 && res.status !== 404;
    } catch { return true; }
  }

  /** Posts a signal for the other side. */
  async send(signal: Signal) {
    if (this.ended) return;
    try {
      await post(`${this.room}/messages`, { token: this.token, message: signal }, this.fetch);
    } catch (error) {
      if (error instanceof PairingError && (error.status === 403 || error.status === 404)) this.end(error.message);
      else throw error;
    }
  }

  /** The game: its phone has gone, so another phone may take its place. */
  release() {
    if (this.ended) return;
    post(`${this.room}/release`, { token: this.token }, this.fetch).catch(() => {});
  }

  /** Leaves the room for good (the game's leaving ends it), even while the page unloads. */
  leave() {
    const body = JSON.stringify({ token: this.token });
    this.close();
    if (this.gone) return;
    if (!globalThis.navigator?.sendBeacon?.(`${this.room}/close`, body)) {
      this.fetch(`${this.room}/close`, { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  }

  /** Stops listening without leaving. */
  close() {
    this.ended = true;
    clearTimeout(this.retry);
    this.stream?.close();
    this.stream = null;
  }

  end(reason: string) {
    if (this.ended) return;
    this.gone = true;
    this.close();
    this.onEvent({ type: 'closed', reason });
  }
}
