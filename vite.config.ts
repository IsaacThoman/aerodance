import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverSongs, songCatalogMiddleware } from './scripts/songCatalog.ts';
import { poseAssetsPlugin } from './scripts/poseAssets.ts';
import { createPairingServer } from './packages/pairing/server.ts';
import type { Connect } from 'vite';

// Phone pairing (packages/pairing/server.ts) at /pair, as nginx proxies it in production.
const pairing = createPairingServer();
const pairingMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  pairing.handle(req, res).then((handled) => { if (!handled) next(); }, next);
};
// The phone page is typed as /phone; nginx adds the slash itself, Vite would serve the game.
const phoneSlash: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url !== '/phone' && !req.url?.startsWith('/phone?')) { next(); return; }
  res.writeHead(302, { location: `/phone/${req.url.slice('/phone'.length)}` });
  res.end();
};

export default defineConfig({
  root: 'client',
  plugins: [react(), poseAssetsPlugin(), {
    name: 'phone-pairing',
    configureServer(server) { server.middlewares.use('/pair', pairingMiddleware); server.middlewares.use(phoneSlash); },
    configurePreviewServer(server) { server.middlewares.use('/pair', pairingMiddleware); server.middlewares.use(phoneSlash); },
  }, {
    name: 'song-discovery',
    configureServer(server) {
      server.middlewares.use('/songs/manifest.json', songCatalogMiddleware(fileURLToPath(new URL('./client/public/songs/', import.meta.url))));
    },
    async writeBundle(options) {
      const catalog = await discoverSongs(fileURLToPath(new URL('./client/public/songs/', import.meta.url)));
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
    outDir: '../dist',
    emptyOutDir: true,
    // The game, and the page a phone opens to be its camera (client/src/phone/).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./client/index.html', import.meta.url)),
        phone: fileURLToPath(new URL('./client/phone/index.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
  },
});
