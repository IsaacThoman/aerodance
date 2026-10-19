import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { CONTROL_PREFIX, LIVE_PREFIX, MAX_RELAY_FRAME, RELAY_CLOSE, SERVER_PREFIX } from './relay.ts';
import { MAX_SIGNAL_BYTES, isPairingCode } from './signals.ts';
import type { CreatedRoom, IceServer, JoinedRoom, PairingRole } from './signals.ts';

/*
 * The pairing server: it introduces a game (the host) to a phone so they can open a WebRTC
 * connection, then stays out of the way. Poses travel over that connection, never through
 * here. Rooms live in memory.
 *
 *   POST /rooms                     the game: a new six-digit code    → { code, token, iceServers }
 *   POST /rooms/:code/join          the phone, with the code          → { token, iceServers }
 *   GET  /rooms/:code/events?token  either side: server-sent events, the other side's signals
 *   GET  /rooms/:code?token         either side: is this pairing still on? (204, or 404)
 *   POST /rooms/:code/messages      { token, message }: a signal for the other side
 *   POST /rooms/:code/release       { token }: the game lost its phone; another may take its place
 *   POST /rooms/:code/close         { token }: the game ends the room, or the phone leaves it
 *   GET  /rooms/:code/link?token&epoch  either side: a WebSocket for the relay (relay.ts), for a
 *                                   game without WebRTC; upgrade() serves it
 *
 * A code takes one phone at a time. Another phone can join once the first has gone (its
 * events stream closed for a few seconds) or the game has released it, so the same QR code
 * re-pairs a phone that reloaded or lost its link. The room ends with the game: it closes it,
 * or its events stream stays closed for a minute.
 *
 * Each side may only send its own signals (signals.ts), so neither can pose as the server.
 * Signals waiting for a side, or unread on its events stream, are capped. A wrong code and a
 * wrong token get the same answer everywhere but join, and joins with wrong codes are
 * throttled across the server, so six-digit codes can't be guessed at speed (nginx also
 * limits each client's joins and new rooms).
 *
 * A phone sends a random session id with join and close, so a reloaded page's late close
 * can't end the new page's place.
 *
 * Through the relay, poses do travel through here, unread: each side's frames go to the other
 * as they are, live ones (poses, pings, preview pictures) dropped when the other side is behind
 * or the link sends faster than RELAY_BYTES_PER_S, and a side whose control frames keep going
 * past that rate loses its link, so a room can't be used as a free pipe.
 *
 * Paths are relative to where the handler is mounted (/pair in the game's dev server and
 * behind nginx). handle() returns false for paths it doesn't serve.
 */

export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
// The room outlives the game's events stream this long (reloads, network blips).
const HOST_GRACE_MS = 60_000;
// A phone keeps its place this long before its events stream opens and after it closes.
const PHONE_GRACE_MS = 10_000;
const MAX_AGE_MS = 12 * 60 * 60_000;
// Signals waiting for a side whose events stream is closed: at most this many, and bytes.
const QUEUE = 100;
const QUEUE_BYTES = 256 * 1024;
// Joins with a code that matches no game, per minute across the server, before joins pause.
const MAX_MISSES = 300;
const MISS_WINDOW_MS = 60_000;
// A release is ignored this soon after the phone's last hello.
const RELEASE_AFTER_MS = 2000;
// The signals each side may send.
const SENDS: Record<PairingRole, readonly string[]> = { host: ['offer', 'ice', 'relay'], phone: ['hello', 'answer', 'ice'] };
// Keeps proxies from timing out quiet streams.
const HEARTBEAT_MS = 15_000;
// The relay: live frames are dropped while this much is waiting for the other side, and a link
// whose control frames back up past MAX_BACKLOG is closed. Each way may send this many bytes a
// second on average (the phone's poses and a small preview are well under), in bursts of twice that.
const LIVE_BACKLOG = 64 * 1024;
const MAX_BACKLOG = 1024 * 1024;
const RELAY_BYTES_PER_S: Record<PairingRole, number> = { phone: 512 * 1024, host: 64 * 1024 };
const SWEEP_MS = 5_000;

interface Side {
  token: string | null; stream: ServerResponse | null; seen: number;
  /** The phone page that joined last (a reloaded page's late close is ignored). */
  session: string;
  queue: string[]; queued: number;
  /** The game lost touch with this phone: another phone may take its place. */
  released: boolean;
  /** When the phone last said hello (asked the game to connect). */
  helloAt: number;
}
/** One relayed connection attempt: the two sides' sockets once they've connected. */
interface Relay {
  epoch: number;
  host: WebSocket | null;
  phone: WebSocket | null;
  open: boolean;
  /** Bytes each side may still send now (refilled at RELAY_BYTES_PER_S), and when last refilled. */
  budget: Record<PairingRole, number>;
  refilled: number;
}
interface Room { code: string; created: number; host: Side; phone: Side; relay: Relay | null; }

export interface PairingServerOptions {
  iceServers?: IceServer[];
  maxRooms?: number;
  now?: () => number;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const token = () => randomBytes(18).toString('base64url');
const side = (now: number, owner: string | null): Side => ({ token: owner, stream: null, seen: now, session: '', queue: [], queued: 0, released: false, helloAt: -Infinity });
// Wrong room or wrong token: the same answer, so neither can be told apart from outside.
const GONE = 'This pairing has ended. Pair again.';
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function json(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_SIGNAL_BYTES + 1024) throw new HttpError(413, 'Message too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  // sendBeacon posts text/plain, so the body is parsed whatever its type.
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Expected JSON'); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}

export function createPairingServer({ iceServers = DEFAULT_ICE_SERVERS, maxRooms = 500, now = Date.now }: PairingServerOptions = {}) {
  const rooms = new Map<string, Room>();
  let misses: number[] = [];
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME, perMessageDeflate: false });
  // Sockets that answered the last heartbeat's ping.
  const alive = new WeakSet<WebSocket>();

  const roomFor = (code: string, missing = GONE) => {
    const room = isPairingCode(code) ? rooms.get(code) : undefined;
    if (!room) throw new HttpError(404, missing);
    return room;
  };
  // A join: wrong codes count towards the throttle, and while it's on every join waits, except
  // the room's own phone coming back with its token (no probe: it already knows the code).
  const joinable = (code: string, owner: unknown) => {
    const missing = 'No game is waiting with that code.';
    if (!isPairingCode(code)) throw new HttpError(404, missing);
    const room = rooms.get(code);
    if (room && typeof owner === 'string' && owner && owner === room.phone.token) return room;
    const t = now();
    misses = misses.filter((at) => t - at < MISS_WINDOW_MS);
    if (misses.length >= MAX_MISSES) throw new HttpError(429, 'Too many wrong codes were tried just now. Wait a minute, then try again.');
    if (!room) { misses.push(t); throw new HttpError(404, missing); }
    return room;
  };
  const roleOf = (room: Room, owner: unknown) => {
    if (typeof owner === 'string' && owner) {
      if (owner === room.host.token) return 'host';
      if (owner === room.phone.token) return 'phone';
    }
    throw new HttpError(404, GONE);
  };
  // An events stream whose reader has stopped reading is closed rather than buffered without end.
  const write = (s: Side, text: string) => {
    const stream = s.stream;
    if (!stream) return;
    if (stream.writableLength > QUEUE_BYTES) endStream(s);
    else stream.write(text);
  };
  const deliver = (to: Side, value: unknown) => {
    const text = event(value);
    if (to.stream) write(to, text);
    else if (to.token) {
      to.queue.push(text);
      to.queued += text.length;
      while (to.queue.length > QUEUE || to.queued > QUEUE_BYTES) to.queued -= to.queue.shift()?.length ?? 0;
    }
  };
  // Its place is held from now (PHONE_GRACE_MS, HOST_GRACE_MS), as when a stream closes by itself.
  const endStream = (s: Side) => {
    const stream = s.stream;
    if (!stream) return;
    s.stream = null;
    s.seen = now();
    stream.end();
  };
  const phonePresent = ({ phone }: Room) => !!phone.token && !phone.released && (!!phone.stream || now() - phone.seen < PHONE_GRACE_MS);
  const endRelay = (room: Room, code: number) => {
    const relay = room.relay;
    if (!relay) return;
    room.relay = null;
    for (const ws of [relay.host, relay.phone]) ws?.close(code);
  };
  const remove = (room: Room, reason: string) => {
    endRelay(room, RELAY_CLOSE.ended);
    rooms.delete(room.code);
    for (const s of [room.host, room.phone]) {
      s.stream?.write(event({ type: 'closed', reason }));
      endStream(s);
    }
  };

  function create(res: ServerResponse) {
    if (rooms.size >= maxRooms) throw new HttpError(503, 'Too many games are pairing right now. Try again soon.');
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (rooms.has(code));
    const t = now();
    const owner = token();
    rooms.set(code, { code, created: t, host: side(t, owner), phone: side(t, null), relay: null });
    json(res, 201, { code, token: owner, iceServers } satisfies CreatedRoom);
  }

  function join(room: Room, body: Record<string, unknown>, res: ServerResponse) {
    const { phone } = room;
    let owner = phone.token;
    if (!owner || body.token !== owner) {
      if (phonePresent(room)) throw new HttpError(409, 'Another phone is already connected to that game.');
      endStream(phone);
      // A new phone: the one before it loses any relayed link.
      if (room.relay?.phone) endRelay(room, RELAY_CLOSE.replaced);
      owner = token();
      Object.assign(phone, side(now(), owner));
    }
    phone.seen = now();
    phone.session = typeof body.session === 'string' ? body.session.slice(0, 64) : '';
    json(res, 200, { token: owner, iceServers } satisfies JoinedRoom);
  }

  function events(room: Room, owner: string | null, req: IncomingMessage, res: ServerResponse) {
    const role = roleOf(room, owner);
    const me = room[role], other = role === 'host' ? room.phone : room.host;
    endStream(me);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    for (const text of me.queue) res.write(text);
    me.queue = [];
    me.queued = 0;
    me.stream = res;
    me.seen = now();
    me.released = false;
    res.write(event({ type: 'peer', present: !!other.stream }));
    deliver(other, { type: 'peer', present: true });
    req.on('close', () => {
      if (me.stream !== res) return;
      me.stream = null;
      me.seen = now();
      if (rooms.get(room.code) === room) deliver(other, { type: 'peer', present: false });
    });
  }

  function message(room: Room, body: Record<string, unknown>, res: ServerResponse) {
    const role = roleOf(room, body.token);
    const { message: signal } = body;
    const type = typeof signal === 'object' && signal !== null ? (signal as { type?: unknown }).type : undefined;
    if (typeof type !== 'string' || !SENDS[role].includes(type)) throw new HttpError(400, 'Expected a signal');
    if (JSON.stringify(signal).length > MAX_SIGNAL_BYTES) throw new HttpError(413, 'Message too large');
    // Only the phone's posts keep its place; the game is there while its events stream is open.
    if (role === 'phone') {
      room.phone.seen = now();
      if (type === 'hello') { room.phone.released = false; room.phone.helloAt = now(); }
    }
    deliver(role === 'host' ? room.phone : room.host, signal);
    json(res, 204);
  }

  function release(room: Room, body: Record<string, unknown>, res: ServerResponse) {
    if (roleOf(room, body.token) !== 'host') throw new HttpError(404, GONE);
    // A release that arrives just after the phone asked to reconnect (its hello overtook it) is out of date.
    if (now() - room.phone.helloAt > RELEASE_AFTER_MS) room.phone.released = true;
    json(res, 204);
  }

  function close(room: Room, body: Record<string, unknown>, res: ServerResponse) {
    const role = roleOf(room, body.token);
    if (role === 'host') remove(room, 'The game closed the pairing.');
    // A page that joined since (a reload) keeps its place.
    else if (!room.phone.session || body.session === room.phone.session) {
      endStream(room.phone);
      Object.assign(room.phone, side(now(), null));
      deliver(room.host, { type: 'peer', present: false, left: true });
    }
    json(res, 204);
  }

  /**
   * A relay socket (GET /rooms/:code/link?token&epoch, relay.ts), from the HTTP server's
   * 'upgrade' event. Returns false for paths it doesn't serve (the socket is left alone).
   */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    // Node's HTTP server stops watching the socket for errors before 'upgrade', and a client that
    // resets it before ws takes over would otherwise take the process down.
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url || '/', 'http://pairing');
    const parts = url.pathname.split('/').filter(Boolean);
    const raw = (req.url || '/').split('?')[0];
    if (raw !== url.pathname || raw !== `/${parts.join('/')}` || parts.length !== 3 || parts[0] !== 'rooms' || parts[2] !== 'link') return false;
    // Answered and closed from this side too, so a client that stays connected holds nothing.
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\ncache-control: no-store\r\n\r\n`, () => socket.destroy());
    };
    let room: Room, role: PairingRole;
    // A wrong code and a wrong token look the same here too.
    try { room = roomFor(parts[1]); role = roleOf(room, url.searchParams.get('token')); } catch { refuse(404, 'Not Found'); return true; }
    const epochText = url.searchParams.get('epoch') ?? '';
    const epoch = /^\d{1,9}$/.test(epochText) ? Number(epochText) : -1;
    if (req.method !== 'GET' || epoch < 0) { refuse(400, 'Bad Request'); return true; }
    // The phone joins the game's socket for the same attempt; anything else is out of date.
    if (role === 'phone' && (room.relay?.epoch !== epoch || !room.relay.host)) { refuse(409, 'Conflict'); return true; }
    sockets.handleUpgrade(req, socket, head, (ws) => attach(room, role, epoch, ws));
    return true;
  }

  function attach(room: Room, role: PairingRole, epoch: number, ws: WebSocket) {
    if (rooms.get(room.code) !== room) { ws.close(RELAY_CLOSE.ended); return; }
    let relay = room.relay;
    if (role === 'host') {
      // A new attempt replaces the last one, both its sockets.
      if (relay && relay.epoch !== epoch) { endRelay(room, RELAY_CLOSE.replaced); relay = null; }
      if (!relay) {
        const t = now();
        relay = room.relay = { epoch, host: null, phone: null, open: false, budget: { host: 2 * RELAY_BYTES_PER_S.host, phone: 2 * RELAY_BYTES_PER_S.phone }, refilled: t };
      }
    } else if (!relay || relay.epoch !== epoch || !relay.host) { ws.close(RELAY_CLOSE.replaced); return; }
    const mine = relay;
    mine[role]?.close(RELAY_CLOSE.replaced);
    mine[role] = ws;
    alive.add(ws);
    if (role === 'phone') room.phone.seen = now();
    ws.on('message', (data, isBinary) => forward(mine, role, ws, data, isBinary));
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      if (mine[role] !== ws) return;
      mine[role] = null;
      mine.open = false;
      // Either side going ends the link, as a closed data channel ends a WebRTC one.
      const other = mine[role === 'host' ? 'phone' : 'host'];
      if (other) { mine[role === 'host' ? 'phone' : 'host'] = null; other.close(RELAY_CLOSE.peerGone); }
      if (room.relay === mine) room.relay = null;
    });
    if (mine.host && mine.phone) {
      mine.open = true;
      const open = SERVER_PREFIX + JSON.stringify({ type: 'open' });
      mine.host.send(open);
      mine.phone.send(open);
    }
  }

  function forward(relay: Relay, from: PairingRole, ws: WebSocket, data: RawData, isBinary: boolean) {
    if (relay[from] !== ws) return;
    const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    const kind = isBinary ? '' : String.fromCharCode(buffer[0] ?? 0);
    // Pictures come only from the phone, and text only as live or control frames.
    if (isBinary ? from !== 'phone' : kind !== LIVE_PREFIX && kind !== CONTROL_PREFIX) { ws.close(RELAY_CLOSE.refused); return; }
    const to = relay[from === 'host' ? 'phone' : 'host'];
    if (!relay.open || !to || to.readyState !== WebSocket.OPEN) return;
    const t = now();
    for (const r of ['host', 'phone'] as const) relay.budget[r] = Math.min(2 * RELAY_BYTES_PER_S[r], relay.budget[r] + (t - relay.refilled) / 1000 * RELAY_BYTES_PER_S[r]);
    relay.refilled = t;
    const live = isBinary || kind === LIVE_PREFIX;
    if (live && (to.bufferedAmount > LIVE_BACKLOG || relay.budget[from] < buffer.length)) return;
    relay.budget[from] -= buffer.length;
    // Control frames aren't dropped (they're settings and status, a few small ones a second), but
    // they count: a side that sends them past its rate's own burst again loses the link.
    if (relay.budget[from] < -2 * RELAY_BYTES_PER_S[from]) { ws.close(RELAY_CLOSE.refused); return; }
    // A side that stopped reading (or sends control frames without end): the link goes.
    if (to.bufferedAmount > MAX_BACKLOG) { to.terminate(); return; }
    to.send(buffer, { binary: isBinary });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://pairing');
    const parts = url.pathname.split('/').filter(Boolean);
    // Exact paths only, as sent (URL parsing turns \ into / and resolves ..), so every form of a
    // path meets the proxy's limits for it.
    const raw = (req.url || '/').split('?')[0];
    if (raw !== url.pathname || raw !== `/${parts.join('/')}`) return false;
    const route = `${req.method} ${parts[0] === 'rooms' ? ['rooms', parts[1] && ':code', parts[2]].filter(Boolean).join('/') : parts.join('/')}`;
    const known = ['POST rooms', 'GET rooms/:code', 'POST rooms/:code/join', 'GET rooms/:code/events', 'POST rooms/:code/messages',
      'POST rooms/:code/release', 'POST rooms/:code/close', 'GET health'];
    if (!known.includes(route) || parts.length > 3) return false;
    try {
      if (route === 'GET health') json(res, 200, { rooms: rooms.size });
      else if (route === 'POST rooms') create(res);
      else if (route === 'GET rooms/:code') { roleOf(roomFor(parts[1]), url.searchParams.get('token')); json(res, 204); }
      else if (route === 'GET rooms/:code/events') events(roomFor(parts[1]), url.searchParams.get('token'), req, res);
      else {
        const body = await readBody(req);
        const room = route === 'POST rooms/:code/join' ? joinable(parts[1], body.token) : roomFor(parts[1]);
        if (route === 'POST rooms/:code/join') join(room, body, res);
        else if (route === 'POST rooms/:code/messages') message(room, body, res);
        else if (route === 'POST rooms/:code/release') release(room, body, res);
        else close(room, body, res);
      }
    } catch (error) {
      if (res.headersSent) res.end();
      else json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Pairing failed' });
    }
    return true;
  }

  /** Ends rooms whose game has gone, and very old ones. */
  function sweep() {
    const t = now();
    for (const room of rooms.values()) {
      if (t - room.created > MAX_AGE_MS) remove(room, 'This pairing expired. Pair again.');
      else if (!room.host.stream && t - room.host.seen > HOST_GRACE_MS) remove(room, 'The game closed the pairing.');
    }
  }
  const sweeper = setInterval(sweep, SWEEP_MS);
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const s of [room.host, room.phone]) write(s, ': \n\n');
      // Relay sockets that didn't answer the last ping have gone (a phone that lost its network).
      for (const ws of [room.relay?.host, room.relay?.phone]) {
        if (!ws) continue;
        if (!alive.has(ws)) { ws.terminate(); continue; }
        alive.delete(ws);
        ws.ping();
      }
    }
  }, HEARTBEAT_MS);
  sweeper.unref?.();
  heartbeat.unref?.();

  return {
    handle,
    upgrade,
    sweep,
    rooms,
    /** Ends every room and stops the timers. */
    close() {
      clearInterval(sweeper);
      clearInterval(heartbeat);
      for (const room of [...rooms.values()]) remove(room, 'The pairing server stopped.');
      sockets.close();
    },
  };
}
export type PairingServer = ReturnType<typeof createPairingServer>;
