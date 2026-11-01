// The pictures looks are sampled from: each frame drawn into a canvas LOOKS_WIDTH (128) pixels
// wide in Chromium, exactly as pose.worker.ts draws the camera's bitmap, and its pixels read back.
// Cached per scene in $TRACKBENCH_DATA/cache/looks128/<scene>.bin (RGBA, frame after frame).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOOKS_WIDTH } from '../../../packages/pose/browser/appearance.ts';
import type { Pixels } from '../../../packages/pose/browser/appearance.ts';
import { DATA, frameFiles, readJson, writeJson } from './common.ts';
import type { Scene } from './common.ts';
import { launchGpu, serve } from './browser.ts';

export async function framePixels(scene: Scene): Promise<Map<number, Pixels>> {
  const files = frameFiles(scene.dir);
  if (!files.length) throw Error(`${scene.id}: no frames to sample looks from`);
  const width = LOOKS_WIDTH, height = Math.max(1, Math.round(LOOKS_WIDTH * scene.height / scene.width));
  const cache = path.join(DATA, 'cache', 'looks128', `${scene.id}.bin`), index = cache.replace(/\.bin$/, '.json');
  const stamp = statSync(path.join(scene.dir, 'frames', files[files.length - 1])).mtimeMs;
  const size = width * height * 4;
  if (existsSync(cache) && existsSync(index)) {
    const meta = readJson<{ frames: number[]; width: number; height: number; stamp: number }>(index);
    if (meta.width === width && meta.height === height && meta.stamp === stamp && meta.frames.length === files.length) {
      const buf = readFileSync(cache);
      return new Map(meta.frames.map((f, i) => [f, { data: buf.subarray(i * size, (i + 1) * size), width, height }]));
    }
  }
  const server = await serve({ '/frames': path.join(scene.dir, 'frames') });
  const browser = await launchGpu();
  try {
    const page = await browser.newPage();
    await page.goto(server.origin);
    const out = Buffer.alloc(files.length * size);
    const frames: number[] = [];
    for (const [i, name] of files.entries()) {
      const b64 = await page.evaluate(async ({ url, width, height }) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        // As pose.worker.ts: a willReadFrequently 2D canvas, the whole bitmap drawn into it.
        const w = globalThis as unknown as { looks?: OffscreenCanvasRenderingContext2D };
        const g = w.looks ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
        if (g.canvas.width !== width || g.canvas.height !== height) { g.canvas.width = width; g.canvas.height = height; }
        g.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const data = g.getImageData(0, 0, width, height).data;
        let s = '';
        for (let k = 0; k < data.length; k += 0x8000) s += String.fromCharCode(...data.subarray(k, k + 0x8000));
        return btoa(s);
      }, { url: `/frames/${name}`, width, height });
      Buffer.from(b64, 'base64').copy(out, i * size);
      frames.push(Number(name.slice(0, -4)));
    }
    mkdirSync(path.dirname(cache), { recursive: true });
    writeFileSync(cache, out);
    writeJson(index, { frames, width, height, stamp });
    return new Map(frames.map((f, i) => [f, { data: out.subarray(i * size, (i + 1) * size), width, height }]));
  } finally {
    await browser.close();
    await server.close();
  }
}
