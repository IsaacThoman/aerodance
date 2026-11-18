import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { LINKS } from './site.config.ts';

// Fills index.html's {{key}} placeholders from site.config.ts, so every button's address lives
// in one place.
const siteLinks = (): Plugin => ({
  name: 'site-links',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) => html.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(LINKS, key)) throw new Error(`index.html uses {{${key}}}, which site.config.ts doesn't define`);
      return LINKS[key as keyof typeof LINKS];
    }),
  },
});

// The landing page: a static site of its own, apart from the game (the root vite.config.ts).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [siteLinks()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5178 },
  preview: { port: 8083 },
});
