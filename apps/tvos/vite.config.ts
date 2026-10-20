// The game as one classic script (game.js) for the JavaScriptCore host, which has no module
// loader: the same entry as the web build (client/src/main.tsx), with stages inlined instead of
// split into chunks. Built by `node scripts/tvos.ts build --game` into apps/tvos/dist/.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverSongs } from '../../scripts/songCatalog.ts';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export default defineConfig({
  root: root('client'),
  plugins: [react(), {
    name: 'song-discovery',
    async writeBundle(options) {
      const catalog = await discoverSongs(root('client/public/songs/'));
      await mkdir(`${options.dir}/songs`, { recursive: true });
      await writeFile(`${options.dir}/songs/manifest.json`, JSON.stringify(catalog, null, 2) + '\n');
    },
  }],
  resolve: { dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'] },
  // Classic scripts have no import.meta; the host's page URL stands in for the script's.
  define: { 'import.meta.url': JSON.stringify('http://aerodance.local/game.js') },
  worker: { format: 'iife' },
  build: {
    outDir: root('apps/tvos/dist'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rolldownOptions: {
      input: root('client/src/main.tsx'),
      output: { format: 'iife', entryFileNames: 'game.js', assetFileNames: 'assets/[name]-[hash][extname]', inlineDynamicImports: true },
    },
  },
});
