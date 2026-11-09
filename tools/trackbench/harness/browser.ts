// Chromium on the GPU (Metal on macOS) and a local server for the dist snapshot, scene frames and models.
import express from 'express';
import type { Server } from 'node:http';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { chromiumPath, gpuFlags } from '../../../scripts/chromium.ts';

/** Headless Chromium rendering WebGL on the GPU: without these flags it falls back to SwiftShader. */
export async function launchGpu(): Promise<Browser> {
  const flags = [...new Set([...gpuFlags(), '--enable-gpu', '--ignore-gpu-blocklist'])];
  return chromium.launch({ executablePath: chromiumPath(false), args: ['--no-sandbox', ...flags] });
}

/** Serves each mount (URL prefix → directory) on 127.0.0.1; returns its origin and a closer. */
export async function serve(mounts: Record<string, string>): Promise<{ origin: string; close: () => Promise<void>; server: Server }> {
  const app = express();
  app.get('/', (_req, res) => { res.type('html').send('<!doctype html><html><body>trackbench</body></html>'); });
  for (const [prefix, dir] of Object.entries(mounts)) app.use(prefix, express.static(dir, { dotfiles: 'allow', maxAge: 0 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, server, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** The WebGL renderer the page sees (to confirm it's a GPU, not SwiftShader). */
export const RENDERER_PROBE = () => {
  const g = new OffscreenCanvas(1, 1).getContext('webgl2');
  const d = g?.getExtension('WEBGL_debug_renderer_info');
  return d ? String(g!.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown';
};
