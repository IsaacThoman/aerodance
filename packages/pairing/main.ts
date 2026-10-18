// The pairing server on its own (the `pairing` Compose service; nginx proxies /pair/ to it):
// node packages/pairing/main.ts. PORT (default 3001); PAIRING_ICE_SERVERS: a JSON array of
// RTCIceServer entries handed to both sides, e.g. to add a TURN server (default: a public STUN server).
import http from 'node:http';
import { DEFAULT_ICE_SERVERS, createPairingServer } from './server.ts';
import type { IceServer } from './signals.ts';

function iceServers(): IceServer[] {
  const raw = process.env.PAIRING_ICE_SERVERS;
  if (!raw) return DEFAULT_ICE_SERVERS;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'object' && s && 'urls' in s)) throw Error('PAIRING_ICE_SERVERS must be a JSON array of { urls } objects');
  return parsed as IceServer[];
}

const pairing = createPairingServer({ iceServers: iceServers() });
const PREFIX = '/pair';
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`)) req.url = url.slice(PREFIX.length) || '/';
  void pairing.handle(req, res).then((handled) => {
    if (!handled) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"Not found"}'); }
  });
});
const port = Number(process.env.PORT) || 3001;
server.listen(port, () => console.log(`Pairing server listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { pairing.close(); server.close(() => process.exit(0)); server.closeAllConnections(); });
}
