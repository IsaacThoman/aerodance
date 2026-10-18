import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPairingServer } from '../server.ts';
import type { PairingServerOptions } from '../server.ts';
import { isPairingCode } from '../signals.ts';

/** A pairing server on a free port, mounted at /pair like nginx and the dev server mount it. */
async function serve(t: TestContext, options: PairingServerOptions = {}) {
  const pairing = createPairingServer(options);
  const server = http.createServer((req, res) => {
    req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
    void pairing.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
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
  assert.equal((await post(`/rooms/${room.code}/messages`, { token: first.token, message: { type: 'hello', device: 'x' } })).status, 403);
  assert.equal(pairing.rooms.size, 1);
});

test('rooms end a minute after the game stops listening, and unknown codes and tokens are refused', async (t) => {
  let now = 5_000_000;
  const { base, post, pairing } = await serve(t, { now: () => now });
  const room = await (await post('/rooms')).json();
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  const stream = await listen(t, `${base}/rooms/${room.code}/events?token=${phone.token}`);
  await stream.next();

  assert.equal((await listen(t, `${base}/rooms/${room.code}/events?token=nope`)).status, 403);
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
  assert.equal((await post(`/rooms/${room.code}/release`, { token: first.token })).status, 403, 'only the game releases');
  assert.equal((await post(`/rooms/${room.code}/release`, { token: room.token })).status, 204);
  const second = await (await post(`/rooms/${room.code}/join`)).json();
  assert.notEqual(second.token, first.token);
  // The first phone's stream ends, and its token no longer works.
  await assert.rejects(async () => { for (;;) await stream.next(); });
  assert.equal((await fetch(`${base}/rooms/${room.code}?token=${first.token}`)).status, 403);
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
