// The pairing server on its own (beside nginx in the app container, which proxies /pair/ to it):
// node packages/pairing/main.ts. PAIRING_PORT (default 3001; not PORT, which may be the app's)
// and PAIRING_HOST (default: every interface). ICE and TURN settings: config.ts.
import http from 'node:http';
import { createPairingServer } from './server.ts';
import { pairingOptions } from './config.ts';

const options = pairingOptions();
const pairing = createPairingServer(options);
console.log(options.ice ? 'Pairing: TURN credentials from Cloudflare.' : 'Pairing: no TURN server (set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN to add one).');
const PREFIX = '/pair';
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`)) req.url = url.slice(PREFIX.length) || '/';
  void pairing.handle(req, res).then((handled) => {
    if (!handled) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"Not found"}'); }
  });
});
const port = Number(process.env.PAIRING_PORT) || 3001;
server.listen(port, process.env.PAIRING_HOST || undefined, () => console.log(`Pairing server listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { pairing.close(); server.close(() => process.exit(0)); server.closeAllConnections(); });
}
