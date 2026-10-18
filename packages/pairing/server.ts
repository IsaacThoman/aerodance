import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_SIGNAL_BYTES, isPairingCode } from './signals.ts';
import type { CreatedRoom, IceServer, JoinedRoom, PairingRole } from './signals.ts';
import type { IceSource } from './turn.ts';

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
 * With an ice source (Cloudflare TURN, config.ts), each new room and each join gets its own
 * short-lived TURN credentials, or the static iceServers if those can't be had. They're
 * revoked when the room ends.
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
const SENDS: Record<PairingRole, readonly string[]> = { host: ['offer', 'ice'], phone: ['hello', 'answer', 'ice'] };
// Keeps proxies from timing out quiet streams.
const HEARTBEAT_MS = 15_000;
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
interface Room {
  code: string; created: number; host: Side; phone: Side;
  /** ICE servers issued for the room (TURN credentials to revoke when it ends). */
  issued: IceServer[][];
}

export interface PairingServerOptions {
  /** Handed to both sides; also the fallback when `ice` fails. */
  iceServers?: IceServer[];
  /** Fresh ICE servers for each new room and each join (short-lived TURN credentials: turn.ts). */
  ice?: IceSource;
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

export function createPairingServer({ iceServers = DEFAULT_ICE_SERVERS, ice, maxRooms = 500, now = Date.now }: PairingServerOptions = {}) {
  const rooms = new Map<string, Room>();
  let misses: number[] = [];
  let warned = -Infinity;
  const warn = (what: string, error: unknown) => {
    if (now() - warned < 60_000) return;
    warned = now();
    console.warn(`Pairing: ${what}`, error instanceof Error ? error.message : error);
  };
  // A side's ICE servers: fresh ones when there's a source for them, else (or if it fails) the
  // static list. Fresh ones are kept with the room, to revoke when it ends.
  const issue = async (room: Room) => {
    if (!ice) return iceServers;
    try {
      const servers = await ice.issue();
      if (rooms.get(room.code) === room) room.issued.push(servers);
      else void ice.revoke?.(servers).catch((error: unknown) => warn('could not revoke TURN credentials.', error));
      return servers;
    } catch (error) {
      warn('no TURN credentials, handing out the fallback ICE servers.', error);
      return iceServers;
    }
  };

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
  // revoke: give the room's TURN credentials back (not on shutdown: a connected phone and game
  // carry on without the server, perhaps through TURN, until the credentials expire).
  const remove = (room: Room, reason: string, revoke = true) => {
    rooms.delete(room.code);
    if (revoke) for (const servers of room.issued) void ice?.revoke?.(servers).catch((error: unknown) => warn('could not revoke TURN credentials.', error));
    room.issued = [];
    for (const s of [room.host, room.phone]) {
      s.stream?.write(event({ type: 'closed', reason }));
      endStream(s);
    }
  };

  async function create(res: ServerResponse) {
    if (rooms.size >= maxRooms) throw new HttpError(503, 'Too many games are pairing right now. Try again soon.');
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (rooms.has(code));
    const t = now();
    const owner = token();
    const room: Room = { code, created: t, host: side(t, owner), phone: side(t, null), issued: [] };
    rooms.set(code, room);
    json(res, 201, { code, token: owner, iceServers: await issue(room) } satisfies CreatedRoom);
  }

  async function join(room: Room, body: Record<string, unknown>, res: ServerResponse) {
    const { phone } = room;
    let owner = phone.token;
    if (!owner || body.token !== owner) {
      if (phonePresent(room)) throw new HttpError(409, 'Another phone is already connected to that game.');
      endStream(phone);
      owner = token();
      Object.assign(phone, side(now(), owner));
    }
    phone.seen = now();
    phone.session = typeof body.session === 'string' ? body.session.slice(0, 64) : '';
    json(res, 200, { token: owner, iceServers: await issue(room) } satisfies JoinedRoom);
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
      else if (route === 'POST rooms') await create(res);
      else if (route === 'GET rooms/:code') { roleOf(roomFor(parts[1]), url.searchParams.get('token')); json(res, 204); }
      else if (route === 'GET rooms/:code/events') events(roomFor(parts[1]), url.searchParams.get('token'), req, res);
      else {
        const body = await readBody(req);
        const room = route === 'POST rooms/:code/join' ? joinable(parts[1], body.token) : roomFor(parts[1]);
        if (route === 'POST rooms/:code/join') await join(room, body, res);
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
    for (const room of rooms.values()) for (const s of [room.host, room.phone]) write(s, ': \n\n');
  }, HEARTBEAT_MS);
  sweeper.unref?.();
  heartbeat.unref?.();

  return {
    handle,
    sweep,
    rooms,
    /** Ends every room and stops the timers. */
    close() {
      clearInterval(sweeper);
      clearInterval(heartbeat);
      for (const room of [...rooms.values()]) remove(room, 'The pairing server stopped.', false);
    },
  };
}
export type PairingServer = ReturnType<typeof createPairingServer>;
