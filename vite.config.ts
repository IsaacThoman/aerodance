import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverSongs, songCatalogMiddleware } from './scripts/songCatalog.ts';
import { poseAssetsPlugin } from './scripts/poseAssets.ts';
import { createPairingServer } from './packages/pairing/server.ts';
import type { Connect } from 'vite';
import type { IncomingMessage, Server } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import type { Duplex } from 'node:stream';

// Phone pairing (packages/pairing/server.ts) at /pair, as nginx proxies it in production.
const pairing = createPairingServer();
const pairingMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  pairing.handle(req, res).then((handled) => { if (!handled) next(); }, next);
};
// The relay's WebSockets (packages/pairing/relay.ts), beside Vite's own (its HMR socket ignores these).
const pairingUpgrade = (httpServer: Server | Http2SecureServer | null) => {
  httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/pair/')) return;
    req.url = req.url.slice('/pair'.length);
    if (!pairing.upgrade(req, socket, head)) socket.destroy();
  });
};
// The phone page is /pair/, typed as /pair (nginx adds the slash itself, Vite would serve the
// game); old /phone links go there too, as nginx sends them.
const phonePage: Connect.NextHandleFunction = (req, res, next) => {
  const path = req.url?.split('?')[0];
  if (path !== '/pair' && path !== '/phone' && !path?.startsWith('/phone/')) { next(); return; }
  res.writeHead(302, { location: `/pair/${req.url!.slice(path.length)}` });
  res.end();
};

export default defineConfig({
  root: 'apps/web',
  plugins: [react(), poseAssetsPlugin(), {
    name: 'phone-pairing',
    configureServer(server) { server.middlewares.use('/pair', pairingMiddleware); server.middlewares.use(phonePage); pairingUpgrade(server.httpServer); },
    configurePreviewServer(server) { server.middlewares.use('/pair', pairingMiddleware); server.middlewares.use(phonePage); pairingUpgrade(server.httpServer); },
  }, {
    name: 'song-discovery',
    configureServer(server) {
      server.middlewares.use('/songs/manifest.json', songCatalogMiddleware(fileURLToPath(new URL('./apps/web/public/songs/', import.meta.url))));
    },
    async writeBundle(options) {
      const catalog = await discoverSongs(fileURLToPath(new URL('./apps/web/public/songs/', import.meta.url)));
      await mkdir(`${options.dir}/songs`, { recursive: true });
      await writeFile(`${options.dir}/songs/manifest.json`, JSON.stringify(catalog, null, 2) + '\n');
    },
  }],
  // The menu dancers import code from packages/character; keep one copy of each runtime.
  resolve: { dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'] },
  // Only the pose worker imports MediaPipe, and Vite's dependency scan doesn't follow workers:
  // without this the dev server reloads the page the first time a camera starts.
  optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // The game, and the page a phone opens to be its camera (apps/web/src/phone/).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./apps/web/index.html', import.meta.url)),
        pair: fileURLToPath(new URL('./apps/web/pair/index.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
  },
});
