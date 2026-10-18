import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cloudflareTurn, parseIceServers } from '../turn.ts';
import type { IceSource } from '../turn.ts';
import { pairingOptions } from '../config.ts';
import { DEFAULT_ICE_SERVERS, createPairingServer } from '../server.ts';
import type { PairingServerOptions } from '../server.ts';

// What Cloudflare's generate-ice-servers answers (its documented shape).
const CLOUDFLARE = { iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user-1', credential: 'secret-1' },
] };

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fn, calls };
}

test('Cloudflare TURN: asks for credentials with the key, keeps the URLs browsers can use, and revokes them', async () => {
  const { fn, calls } = fakeFetch(({ url }) => (url.endsWith('/revoke') ? new Response(null, { status: 204 }) : Response.json(CLOUDFLARE, { status: 201 })));
  const turn = cloudflareTurn({ keyId: 'key id', apiToken: 'token', ttlSeconds: 600, fetch: fn });
  const servers = await turn.issue();
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key%20id/credentials/generate-ice-servers');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer token', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ttl: 600 });
  // Port 53 is blocked in browsers.
  assert.deepEqual(servers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user-1', credential: 'secret-1' },
  ]);
  await turn.revoke?.(servers);
  assert.equal(calls[1].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key%20id/credentials/user-1/revoke');
  assert.equal(calls[1].init.method, 'POST');
});

test('Cloudflare TURN failures throw, so the pairing server can fall back', async () => {
  for (const answer of [() => new Response('nope', { status: 401 }), () => Response.json({ iceServers: [] }, { status: 201 }),
    () => Response.json({ iceServers: [{ urls: ['turn:x:3478'] }] }, { status: 201 }), () => new Response('{', { status: 201 })]) {
    await assert.rejects(cloudflareTurn({ keyId: 'k', apiToken: 't', fetch: fakeFetch(answer).fn }).issue());
  }
  // Slow answers time out.
  const slow = fakeFetch(({ init }) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
  await assert.rejects(cloudflareTurn({ keyId: 'k', apiToken: 't', timeoutMs: 20, fetch: slow.fn }).issue());
});

test('ICE server lists are checked: TURN needs credentials, urls must be strings', () => {
  assert.deepEqual(parseIceServers([{ urls: 'stun:a.test:3478' }]), [{ urls: ['stun:a.test:3478'] }]);
  assert.throws(() => parseIceServers([{ urls: 'turn:a.test:3478' }]), /username and credential/);
  assert.throws(() => parseIceServers([{ urls: [3] }]), /urls/);
  assert.throws(() => parseIceServers({ urls: 'stun:a' }), /array/);
});

test('settings come from the environment, and half a Cloudflare key is refused', () => {
  assert.deepEqual(pairingOptions({}), { iceServers: DEFAULT_ICE_SERVERS });
  assert.deepEqual(pairingOptions({ PAIRING_ICE_SERVERS: '[{"urls":"stun:a.test:3478"}]' }).iceServers, [{ urls: ['stun:a.test:3478'] }]);
  assert.throws(() => pairingOptions({ PAIRING_ICE_SERVERS: '[{"urls":"turn:a.test"}]' }), /PAIRING_ICE_SERVERS/);
  assert.throws(() => pairingOptions({ CLOUDFLARE_TURN_KEY_ID: 'k' }), /both/);
  assert.ok(pairingOptions({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' }).ice);
});

async function serve(t: { after(fn: () => unknown): void }, options: PairingServerOptions) {
  const pairing = createPairingServer(options);
  const server = http.createServer((req, res) => {
    req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
    void pairing.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pair`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    pairing.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  const post = async (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { pairing, post, close };
}

test('each new room and join gets fresh credentials, revoked when the room ends (not when the server stops)', async (t) => {
  let n = 0;
  const revoked: string[] = [];
  const ice: IceSource = {
    issue: async () => [{ urls: ['turn:t.test:3478'], username: `u${++n}`, credential: 'c' }],
    revoke: async (servers) => { revoked.push(...servers.map((s) => s.username ?? '')); },
  };
  const { post, close } = await serve(t, { ice });
  const room = await (await post('/rooms')).json();
  assert.equal(room.iceServers[0].username, 'u1');
  const phone = await (await post(`/rooms/${room.code}/join`)).json();
  assert.equal(phone.iceServers[0].username, 'u2');
  await post(`/rooms/${room.code}/close`, { token: room.token });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(revoked, ['u1', 'u2']);

  await post('/rooms');
  await close();
  assert.deepEqual(revoked, ['u1', 'u2'], 'a shutdown leaves running sessions their credentials');
});

test('without TURN credentials (Cloudflare down or slow) both sides get the fallback servers', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fallback = [{ urls: 'stun:fallback.test:3478' }];
  const { post } = await serve(t, { iceServers: fallback, ice: { issue: async () => { throw Error('Cloudflare TURN answered 503'); } } });
  const room = await (await post('/rooms')).json();
  assert.deepEqual(room.iceServers, fallback);
  assert.deepEqual((await (await post(`/rooms/${room.code}/join`)).json()).iceServers, fallback);
  assert.equal(warn.mock.callCount(), 1, 'warned once, not per request');
});
