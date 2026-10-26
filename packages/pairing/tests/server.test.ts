import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createPairingServer } from '../server.ts';
import type { PairingServerOptions } from '../server.ts';
import { isPairingCode } from '../signals.ts';
import { WebSocket } from 'ws';

/** A pairing server on a free port, mounted at /pair like nginx and the dev server mount it. */
async function serve(t: TestContext, options: PairingServerOptions = {}) {
  const pairing = createPairingServer(options);
  const server = http.createServer((req, res) => {
    req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
    void pairing.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  server.on('upgrade', (req, socket, head) => {
    req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
    if (!pairing.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pair`;
  t.after(async () => {
    pairing.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { pairing, base, post };
}

/** An events stream: next() waits for the next event's JSON. */
async function listen(t: TestContext, url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const events: unknown[] = [];
  const wake = { fn: null as (() => void) | null };
  let buffer = '';
  let ended = false;
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data) { events.push(JSON.parse(data)); wake.fn?.(); }
          }
        }
      } catch { /* Aborted. */ }
      ended = true;
      wake.fn?.();
    })();
  }
  t.after(() => controller.abort());
  return {
    status: res.status,
    get ended() { return ended; },
    async next(): Promise<unknown> {
      while (!events.length) {
        if (ended) throw Error('stream ended');
        await new Promise<void>((resolve) => { wake.fn = resolve; setTimeout(resolve, 2000); });
      }
      return events.shift();
    },
    close: () => controller.abort(),
  };
}

test('a game gets a six-digit code; a phone joins it and their signals reach each other', async (t) => {
  const { base, post } = await serve(t, { iceServers: [{ urls: 'stun:example.test' }] });
  const created = await post('/rooms');
  assert.equal(created.status, 201);
  const room = await created.json();
  assert.ok(isPairingCode(room.code));
  assert.deepEqual(room.iceServers, [{ urls: 'stun:example.test' }]);

  const host = await listen(t, `${base}/rooms/${room.code}/events?token=${room.token}`);
  assert.deepEqual(await host.next(), { type: 'peer', present: false });

  const joined = await (await post(`/rooms/${room.code}/join`)).json();
  assert.equal(typeof joined.token, 'string');
  // The phone's first signal waits for its events stream to open.
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: room.token, message: { type: 'offer', epoch: 1, sdp: 'o' } })).status, 204);
  const phone = await listen(t, `${base}/rooms/${room.code}/events?token=${joined.token}`);
  assert.deepEqual(await phone.next(), { type: 'offer', epoch: 1, sdp: 'o' });
  assert.deepEqual(await phone.next(), { type: 'peer', present: true });
  assert.deepEqual(await host.next(), { type: 'peer', present: true });

  await post(`/rooms/${room.code}/messages`, { token: joined.token, message: { type: 'hello', device: 'Test phone' } });
  assert.deepEqual(await host.next(), { type: 'hello', device: 'Test phone' });

  // The game closing the room tells the phone and ends its stream.
  assert.equal((await post(`/rooms/${room.code}/close`, { token: room.token })).status, 204);
  assert.deepEqual(await phone.next(), { type: 'closed', reason: 'The game closed the pairing.' });
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 404);
});

test('a code takes one phone at a time, keeps it on rejoin and frees up once it has gone', async (t) => {
  let now = 1_000_000;
  const { base, post, pairing } = await serve(t, { now: () => now });
  const room = await (await post('/rooms')).json();
  const first = await (await post(`/rooms/${room.code}/join`)).json();
  // Joined but not yet listening: the place is held for a few seconds.
  const blocked = await post(`/rooms/${room.code}/join`);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Another phone/);
  // The same phone (a reload) keeps its token.
  assert.equal((await (await post(`/rooms/${room.code}/join`, { token: first.token })).json()).token, first.token);

  const stream = await listen(t, `${base}/rooms/${room.code}/events?token=${first.token}`);
  await stream.next();
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 409);
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  now += 11_000;
  const second = await (await post(`/rooms/${room.code}/join`)).json();
  assert.notEqual(second.token, first.token);
  // The first phone's token no longer works.
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: first.token, message: { type: 'hello', device: 'x' } })).status, 404);
  assert.equal(pairing.rooms.size, 1);
});

test('rooms end a minute after the game stops listening, and unknown codes and tokens are refused', async (t) => {
  let now = 5_000_000;
  const { base, post, pairing } = await serve(t, { now: () => now });
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  const stream = await listen(t, `${base}/rooms/${room.code}/events?token=${phone.token}`);
  await stream.next();

  assert.equal((await listen(t, `${base}/rooms/${room.code}/events?token=nope`)).status, 404);
  assert.equal((await post('/rooms/000000x/join')).status, 404);
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: room.token, message: 'not a signal' })).status, 400);
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: room.token, message: { type: 'offer', sdp: 'x'.repeat(40_000) } })).status, 413);
  assert.equal((await fetch(`${base}/rooms/${room.code}/join`, { method: 'POST', body: '{' })).status, 400);

  now += 59_000;
  pairing.sweep();
  assert.equal(pairing.rooms.size, 1);
  now += 2_000;
  pairing.sweep();
  assert.equal(pairing.rooms.size, 0);
  assert.deepEqual(await stream.next(), { type: 'closed', reason: 'The game closed the pairing.' });
});

test('the server turns games away when full, and serves only its own paths', async (t) => {
  const { base, post } = await serve(t, { maxRooms: 1 });
  assert.equal((await post('/rooms')).status, 201);
  assert.equal((await post('/rooms')).status, 503);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/rooms`)).status, 404);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
});

test('each side may only send its own signals, so neither can pose as the server', async (t) => {
  const { post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  const send = (token: string, message: unknown) => post(`/rooms/${room.code}/messages`, { token, message });
  assert.equal((await send(phone.token, { type: 'closed', reason: 'Visit evil.example' })).status, 400);
  assert.equal((await send(phone.token, { type: 'peer', present: false })).status, 400);
  assert.equal((await send(phone.token, { type: 'offer', epoch: 1, sdp: 'x' })).status, 400);
  assert.equal((await send(room.token, { type: 'hello', device: 'x' })).status, 400);
  assert.equal((await send(room.token, { type: 'answer', epoch: 1, sdp: 'x' })).status, 400);
  assert.equal((await send(phone.token, { type: 'answer', epoch: 1, sdp: 'x' })).status, 204);
  assert.equal((await send(room.token, { type: 'offer', epoch: 1, sdp: 'x' })).status, 204);
});

test('the game can release a phone it lost, so another phone (a new tab) can take its place', async (t) => {
  const { base, post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const first = await (await post(`/rooms/${room.code}/join`)).json();
  const stream = await listen(t, `${base}/rooms/${room.code}/events?token=${first.token}`);
  await stream.next();
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 409);
  assert.equal((await post(`/rooms/${room.code}/release`, { token: first.token })).status, 404, 'only the game releases');
  assert.equal((await post(`/rooms/${room.code}/release`, { token: room.token })).status, 204);
  const second = await (await post(`/rooms/${room.code}/join`)).json();
  assert.notEqual(second.token, first.token);
  // The first phone's stream ends, and its token no longer works.
  await assert.rejects(async () => { for (;;) await stream.next(); });
  assert.equal((await fetch(`${base}/rooms/${room.code}?token=${first.token}`)).status, 404);
  assert.equal((await fetch(`${base}/rooms/${room.code}?token=${second.token}`)).status, 204);
  assert.equal((await fetch(`${base}/rooms/123456x?token=${second.token}`)).status, 404);
});

test('a phone that says hello again after a release keeps its place', async (t) => {
  const { post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  await post(`/rooms/${room.code}/release`, { token: room.token });
  await post(`/rooms/${room.code}/messages`, { token: phone.token, message: { type: 'hello', device: 'x' } });
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 409);
});

test('signals waiting for a side are capped in bytes, and the game posting does not keep a room alive', async (t) => {
  let now = 9_000_000;
  const { base, post, pairing } = await serve(t, { now: () => now });
  const room = await (await post('/rooms')).json();
  await post(`/rooms/${room.code}/join`);
  for (let i = 0; i < 20; i++) await post(`/rooms/${room.code}/messages`, { token: room.token, message: { type: 'offer', epoch: i, sdp: 'x'.repeat(30_000) } });
  const side = [...pairing.rooms.values()][0].phone;
  assert.ok(side.queued <= 256 * 1024 && side.queue.length < 20, `${side.queued} bytes queued`);
  // Only the newest signals are kept.
  assert.match(side.queue.at(-1) ?? '', /"epoch":19/);
  for (let i = 0; i < 3; i++) {
    now += 30_000;
    await post(`/rooms/${room.code}/messages`, { token: room.token, message: { type: 'ice', epoch: 1, candidate: { candidate: 'c' } } });
    pairing.sweep();
  }
  assert.equal(pairing.rooms.size, 0, 'the game never listened, so the room ended');
  assert.equal((await fetch(`${base}/rooms/${room.code}?token=${room.token}`)).status, 404);
});

test('joins pause for a minute after many wrong codes, so codes cannot be guessed at speed', async (t) => {
  let now = 1_000;
  const { post } = await serve(t, { now: () => now });
  const room = await (await post('/rooms')).json();
  const wrong = room.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 300; i++) assert.equal((await post(`/rooms/${wrong}/join`)).status, 404);
  const paused = await post(`/rooms/${room.code}/join`);
  assert.equal(paused.status, 429);
  assert.match((await paused.json()).error, /Wait a minute/);
  now += 61_000;
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 200);
});

test('outside join, a wrong code and a wrong token look the same, so live codes cannot be found by probing', async (t) => {
  const { base, post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const other = room.code === '000000' ? '000001' : '000000';
  for (const code of [room.code, other]) {
    const answers = [
      await fetch(`${base}/rooms/${code}?token=nope`),
      await fetch(`${base}/rooms/${code}/events?token=nope`),
      await post(`/rooms/${code}/messages`, { token: 'nope', message: { type: 'hello', device: 'x' } }),
      await post(`/rooms/${code}/release`, { token: 'nope' }),
      await post(`/rooms/${code}/close`, { token: 'nope' }),
    ];
    assert.deepEqual(await Promise.all(answers.map(async (r) => [r.status, (await r.json()).error])),
      Array(5).fill([404, 'This pairing has ended. Pair again.']), code);
  }
});

test('a phone page that reloaded keeps its place when the old page’s close arrives late', async (t) => {
  const { post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const old = await (await post(`/rooms/${room.code}/join`, { session: 'page-1' })).json();
  const reloaded = await (await post(`/rooms/${room.code}/join`, { token: old.token, session: 'page-2' })).json();
  assert.equal(reloaded.token, old.token);
  assert.equal((await post(`/rooms/${room.code}/close`, { token: old.token, session: 'page-1' })).status, 204);
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: old.token, message: { type: 'hello', device: 'x' } })).status, 204, 'still paired');
  await post(`/rooms/${room.code}/close`, { token: old.token, session: 'page-2' });
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: old.token, message: { type: 'hello', device: 'x' } })).status, 404, 'left');
});

test('an events stream nobody reads is closed instead of buffered without end', async (t) => {
  const { base, post, pairing } = await serve(t);
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  // Open the game's stream and never read it.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${base}/rooms/${room.code}/events?token=${room.token}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const host = [...pairing.rooms.values()][0].host;
  for (let i = 0; i < 400 && host.stream; i++) {
    await post(`/rooms/${room.code}/messages`, { token: phone.token, message: { type: 'answer', epoch: i, sdp: 'x'.repeat(30_000) } });
  }
  assert.equal(host.stream, null, 'the stalled stream was closed');
});

test('every form of a path meets the same limits: no trailing slashes or malformed codes', async (t) => {
  const { base, post } = await serve(t);
  assert.equal((await post('/rooms/')).status, 404);
  assert.equal((await post('/rooms//')).status, 404);
  const room = await (await post('/rooms')).json();
  assert.equal((await post(`/rooms/${room.code}/join/`)).status, 404);
  // Backslashes and dot segments, sent as they are (fetch would tidy them), which URL parsing
  // would quietly turn into a real path.
  const { port } = new URL(base);
  const rawPath = (path: string) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/pair${path}`, method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(await rawPath(`/rooms\\${room.code}\\join`), 404);
  assert.equal(await rawPath('/x\\..\\rooms'), 404);
  assert.equal(await rawPath('/x/../rooms'), 404);
  assert.equal(await rawPath('/x/%2e%2e/rooms'), 404);
  // Malformed codes don't count towards the wrong-code throttle.
  for (let i = 0; i < 350; i++) assert.equal((await post('/rooms/abc/join')).status, 404);
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 200);
});

test('the room’s own phone rejoins with its token even while wrong codes are throttled', async (t) => {
  const { post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  const wrong = room.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 300; i++) await post(`/rooms/${wrong}/join`);
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 429);
  assert.equal((await (await post(`/rooms/${room.code}/join`, { token: phone.token })).json()).token, phone.token);
});

test('a release that arrives just after the phone said hello again is ignored', async (t) => {
  const { post } = await serve(t);
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  await post(`/rooms/${room.code}/messages`, { token: phone.token, message: { type: 'hello', device: 'x' } });
  await post(`/rooms/${room.code}/release`, { token: room.token });
  assert.equal((await post(`/rooms/${room.code}/join`)).status, 409);
});

test('the iPhone app’s game, at a loopback origin on any port, may pair through the site cross-origin', async (t) => {
  const { base } = await serve(t);
  for (const origin of ['http://127.0.0.1:8417', 'http://127.0.0.1:8423', 'http://localhost:5173', 'http://[::1]:8417', 'http://127.0.0.1']) {
    // JSON posts are preflighted.
    const preflight = await fetch(`${base}/rooms`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(preflight.status, 204, origin);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /\bcontent-type\b/);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null, 'nothing is credentialed');
  }
  const origin = 'http://127.0.0.1:8417';
  const send = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await send('/rooms');
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), origin);
  const room = await created.json();
  for (const path of [`/rooms/${room.code}/messages`, `/rooms/${room.code}/release`, `/rooms/${room.code}/close`, `/rooms/${room.code}`, `/rooms/${room.code}/events`]) {
    const res = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    assert.equal(res.headers.get('access-control-allow-origin'), origin, path);
  }
  // The events stream, the pairing check and errors can be read too.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${base}/rooms/${room.code}/events?token=${room.token}`, { headers: { origin }, signal: controller.signal });
  assert.equal(events.status, 200);
  assert.equal(events.headers.get('access-control-allow-origin'), origin);
  const check = await fetch(`${base}/rooms/${room.code}?token=${room.token}`, { headers: { origin } });
  assert.equal(check.status, 204);
  assert.equal(check.headers.get('access-control-allow-origin'), origin);
  const wrong = await send(`/rooms/${room.code}/messages`, { token: 'nope', message: { type: 'offer', epoch: 1, sdp: 'x' } });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get('access-control-allow-origin'), origin);
  assert.equal((await send(`/rooms/${room.code}/messages`, { token: room.token, message: { type: 'offer', epoch: 1, sdp: 'x' } })).status, 204);
  // Preflights only for paths the server has.
  assert.equal((await fetch(`${base}/elsewhere`, { method: 'OPTIONS', headers: { origin } })).status, 404);
  assert.equal((await fetch(`${base}/rooms/${room.code}/join/`, { method: 'OPTIONS', headers: { origin } })).status, 404);
});

test('no other origin may read the pairing server’s answers', async (t) => {
  const { base } = await serve(t);
  for (const origin of ['https://evil.example', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example:8417', 'http://127.0.0.1:8417.evil.example',
    'https://127.0.0.1:8417', 'http://127.0.0.2:8417', 'null']) {
    const preflight = await fetch(`${base}/rooms`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(preflight.status, 204, origin);
    for (const name of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers']) assert.equal(preflight.headers.get(name), null, `${origin} ${name}`);
    // A post that needs no preflight still gets an answer, which it can't read.
    const created = await fetch(`${base}/rooms`, { method: 'POST', headers: { origin }, body: '{}' });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('access-control-allow-origin'), null, origin);
    assert.equal(created.headers.get('vary'), 'origin');
  }
  // The site's own pages send no origin on GETs, and get no CORS headers.
  assert.equal((await fetch(`${base}/health`)).headers.get('access-control-allow-origin'), null);
});

/** A relay socket: frames received (text as strings, binary as Buffers), and how it closed. */
async function relaySocket(t: TestContext, base: string, code: string, token: string, epoch: number | string) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/rooms/${code}/link?token=${token}&epoch=${epoch}`);
  const frames: (string | Buffer)[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (data, isBinary) => { frames.push(isBinary ? Buffer.from(data as Buffer) : String(data)); });
  t.after(() => ws.terminate());
  const opened = await new Promise<number>((resolve) => {
    ws.on('open', () => resolve(101));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
  const until = async (count: number) => {
    for (let i = 0; i < 200 && frames.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return frames;
  };
  return { ws, opened, frames, closed, until };
}

async function relayRoom(t: TestContext, options: PairingServerOptions = {}) {
  const served = await serve(t, options);
  const room = await (await served.post('/rooms')).json();
  const joined = await (await served.post(`/rooms/${room.code}/join`)).json();
  return { ...served, code: room.code as string, host: room.token as string, phone: joined.token as string };
}

test('through the relay, a game and its phone pass frames both ways, pictures only from the phone', async (t) => {
  const { base, code, host, phone, post } = await relayRoom(t);
  // A relay signal is the game's to send.
  assert.equal((await post(`/rooms/${code}/messages`, { token: host, message: { type: 'relay', epoch: 1 } })).status, 204);
  assert.equal((await post(`/rooms/${code}/messages`, { token: phone, message: { type: 'relay', epoch: 1 } })).status, 400);

  const game = await relaySocket(t, base, code, host, 1);
  assert.equal(game.opened, 101);
  const mobile = await relaySocket(t, base, code, phone, 1);
  assert.equal(mobile.opened, 101);
  assert.deepEqual(await game.until(1), ['S{"type":"open"}']);
  assert.deepEqual(await mobile.until(1), ['S{"type":"open"}']);

  game.ws.send('C{"type":"config"}');
  mobile.ws.send('L{"type":"pose"}');
  const picture = Buffer.from([0xff, 0xd8, 1, 2, 3]);
  mobile.ws.send(picture);
  assert.deepEqual((await mobile.until(2))[1], 'C{"type":"config"}');
  const got = await game.until(3);
  assert.equal(got[1], 'L{"type":"pose"}');
  assert.ok(Buffer.isBuffer(got[2]) && got[2].equals(picture));

  // The game may not send pictures, and nobody may send frames of another kind.
  game.ws.send(Buffer.from([1]));
  assert.equal(await game.closed, 4003);
  // ...which ends the link for the phone too.
  assert.equal(await mobile.closed, 4000);
});

test('relay sockets need the room’s token and, for the phone, the game’s current attempt', async (t) => {
  const { base, code, host, phone } = await relayRoom(t);
  assert.equal((await relaySocket(t, base, code, 'wrong', 1)).opened, 404);
  assert.equal((await relaySocket(t, base, code === '000000' ? '000001' : '000000', host, 1)).opened, 404);
  assert.equal((await relaySocket(t, base, code, host, 'x')).opened, 400);
  // The phone can't connect before the game, or to another attempt.
  assert.equal((await relaySocket(t, base, code, phone, 1)).opened, 409);
  await relaySocket(t, base, code, host, 2);
  assert.equal((await relaySocket(t, base, code, phone, 1)).opened, 409);
  assert.equal((await relaySocket(t, base, code, phone, 2)).opened, 101);
});

test('a new attempt replaces the last link, either side leaving ends it, and so does the room ending', async (t) => {
  const { base, code, host, phone, post } = await relayRoom(t);
  const game1 = await relaySocket(t, base, code, host, 1);
  const phone1 = await relaySocket(t, base, code, phone, 1);
  await phone1.until(1);
  const game2 = await relaySocket(t, base, code, host, 2);
  assert.equal(await game1.closed, 4001);
  assert.equal(await phone1.closed, 4001);
  const phone2 = await relaySocket(t, base, code, phone, 2);
  assert.deepEqual(await game2.until(1), ['S{"type":"open"}']);
  phone2.ws.close();
  assert.equal(await game2.closed, 4000);

  const game3 = await relaySocket(t, base, code, host, 3);
  const phone3 = await relaySocket(t, base, code, phone, 3);
  await phone3.until(1);
  assert.equal((await post(`/rooms/${code}/close`, { token: host })).status, 204);
  assert.equal(await game3.closed, 4002);
  assert.equal(await phone3.closed, 4002);
});

test('the relay drops live frames beyond its rate but passes control frames, and refuses oversized ones', async (t) => {
  // A clock that stands still: no budget comes back during the test.
  const { base, code, host, phone } = await relayRoom(t, { now: () => 5_000_000 });
  const game = await relaySocket(t, base, code, host, 1);
  const mobile = await relaySocket(t, base, code, phone, 1);
  await game.until(1);
  const picture = Buffer.alloc(60 * 1024, 7);
  for (let i = 0; i < 40; i++) mobile.ws.send(picture);
  for (let i = 0; i < 20; i++) mobile.ws.send(`C{"n":${i}}`);
  const frames = await game.until(1 + 20);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const pictures = frames.filter((f) => Buffer.isBuffer(f)).length, controls = frames.filter((f) => typeof f === 'string' && f.startsWith('C')).length;
  // Twice the phone's 512 KB/s at most, in a burst: 17 of the 60 KB pictures.
  assert.ok(pictures >= 10 && pictures <= 18, `${pictures} pictures passed`);
  assert.equal(controls, 20);
  // Over the frame limit: the socket closes (1009, message too big).
  mobile.ws.send(Buffer.alloc(70 * 1024));
  assert.equal(await mobile.closed, 1009);
  assert.equal(await game.closed, 4000);
});

test('control frames count towards the relay’s rate too: a side that floods them loses its link', async (t) => {
  const { base, code, host, phone } = await relayRoom(t, { now: () => 5_000_000 });
  const game = await relaySocket(t, base, code, host, 1);
  const mobile = await relaySocket(t, base, code, phone, 1);
  await mobile.until(1);
  // The game's 64 KB/s, twice over in a burst, then twice that again: about 4 × 64 KB.
  const big = `C${'x'.repeat(60 * 1024)}`;
  for (let i = 0; i < 12 && game.ws.readyState === WebSocket.OPEN; i++) game.ws.send(big);
  assert.equal(await Promise.race([game.closed, new Promise((resolve) => setTimeout(() => resolve('still open'), 3000))]), 4003);
  assert.equal(await mobile.closed, 4000);
  assert.ok((await mobile.until(1)).length <= 1 + 8, 'most of the flood never got through');
});

test('a refused relay upgrade whose client resets doesn’t take the server down', async (t) => {
  const { base, code } = await relayRoom(t);
  const { port } = new URL(base);
  for (let i = 0; i < 20; i++) {
    const socket = net.connect(Number(port), '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`GET /pair/rooms/${code}/link?token=wrong&epoch=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    socket.on('error', () => {});
    socket.resetAndDestroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Still serving, and refused sockets are closed from its side too.
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const socket = net.connect(Number(port), '127.0.0.1');
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`GET /pair/rooms/${code}/link?token=wrong&epoch=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  socket.resume();
  const ended = await new Promise<boolean>((resolve) => { socket.once('close', () => resolve(true)); setTimeout(() => resolve(false), 2000); });
  assert.ok(ended, 'the server closes a refused socket');
});

async function transferRoom(t: TestContext, options: PairingServerOptions = {}) {
  const served = await serve(t, options);
  const room = await (await served.post('/rooms', { kind: 'transfer' })).json();
  const joined = await (await served.post(`/rooms/${room.code}/join`, { kind: 'transfer' })).json();
  return { ...served, code: room.code as string, host: room.token as string, phone: joined.token as string };
}

test('a transfer room’s code only joins as a transfer, and a phone pairing code only as a phone', async (t) => {
  const { post } = await serve(t);
  const transfer = await (await post('/rooms', { kind: 'transfer' })).json();
  const pairing = await (await post('/rooms')).json();
  const asPhone = await post(`/rooms/${transfer.code}/join`);
  assert.equal(asPhone.status, 404);
  assert.match((await asPhone.json()).error, /sending songs/);
  const asTransfer = await post(`/rooms/${pairing.code}/join`, { kind: 'transfer' });
  assert.equal(asTransfer.status, 404);
  assert.match((await asTransfer.json()).error, /pairing a phone/);
  assert.equal((await post(`/rooms/${transfer.code}/join`, { kind: 'transfer' })).status, 200);
  assert.equal((await post(`/rooms/${pairing.code}/join`, { kind: 'pair' })).status, 200);
  assert.equal((await post('/rooms', { kind: 'other' })).status, 400);
});

test('a transfer room relays pieces of songs both ways, every one of them, pausing a side that sends too fast', async (t) => {
  const { base, code, host, phone } = await transferRoom(t, { transferBytesPerS: 1024 * 1024 });
  const game = await relaySocket(t, base, code, host, 1);
  const other = await relaySocket(t, base, code, phone, 1);
  await game.until(1);
  await other.until(1);
  const piece = Buffer.alloc(60 * 1024, 3);
  const started = performance.now();
  // 3 MB from the host: 2 MB of burst, then a second's worth at 1 MB/s.
  for (let i = 0; i < 50; i++) game.ws.send(piece);
  for (let i = 0; i < 4; i++) other.ws.send(Buffer.alloc(1000, i));
  const received = await (async () => {
    for (let i = 0; i < 500 && other.frames.filter((f) => Buffer.isBuffer(f)).length < 50; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return other.frames.filter((f) => Buffer.isBuffer(f));
  })();
  const elapsed = performance.now() - started;
  assert.equal(received.length, 50, 'none were dropped');
  assert.ok(elapsed > 600, `paced: ${elapsed.toFixed(0)} ms`);
  assert.equal((await game.until(1 + 4)).filter((f) => Buffer.isBuffer(f)).length, 4);
  assert.equal(game.ws.readyState, WebSocket.OPEN);
});

test('a transfer room relays at most its byte limit', async (t) => {
  const { base, code, host, phone } = await transferRoom(t, { transferMaxBytes: 200 * 1024 });
  const game = await relaySocket(t, base, code, host, 1);
  const other = await relaySocket(t, base, code, phone, 1);
  await game.until(1);
  for (let i = 0; i < 5 && game.ws.readyState === WebSocket.OPEN; i++) game.ws.send(Buffer.alloc(60 * 1024));
  assert.equal(await game.closed, 4003);
  assert.equal(await other.closed, 4000);
  assert.equal(other.frames.filter((f) => Buffer.isBuffer(f)).length, 3);
});
