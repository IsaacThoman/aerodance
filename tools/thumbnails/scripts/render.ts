#!/usr/bin/env node
// Renders every shot in client/src/shots.ts to with-logo/<id>.png and no-logo/<id>.png.
//
//   node tools/thumbnails/scripts/render.ts [--only id,id] [--spec shots.json --out dir] [--jobs 2]
//   node tools/thumbnails/scripts/render.ts --tv-icons [--only id,id] [--out dir]
//   node tools/thumbnails/scripts/render.ts --app-icons [--only id,id] [--out dir]
//
// Builds the capture page with Vite, opens it in headless Chrome (GPU WebGL), steps each
// shot's stage to its time and reads back the 540x480 buffer. Each buffer pixel is written
// as an exact 4x3 block (2160x1440, 3:2) into a lossless PNG: no filtering or resampling.
//
// --tv-icons renders TV_ICONS instead, into assets/tv-icon/<id>/: each layer as a transparent
// PNG at Apple TV's three app icon sizes (<size>/<n>-<layer>.png), and the layers stacked back
// together (flat.png). Those sizes aren't whole multiples of the 600x480 buffer, so they're
// area-averaged.
//
// --app-icons renders APP_ICONS, square phone app icons, into assets/app-icon/: <id>.png at
// 1024x1024, area-averaged from the 360x480 buffer. A layered one's layers go in <id>/1024x1024/,
// and it stays transparent if its back layer isn't opaque.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';
import { APP_ICONS, SHOTS, TV_ICONS, UPSCALE, assertShot } from '../client/src/shots.ts';
import type { Shot, ThumbnailFrame, ThumbnailWindow } from '../client/src/shots.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Apple TV app icons: the App Store's, then the home screen's @2x and @1x.
const TV_ICON_SIZES: readonly (readonly [width: number, height: number])[] = [[1280, 768], [800, 480], [400, 240]];
// A phone's app icon: the one 1024x1024 image that iOS and the stores scale down.
const APP_ICON_SIZE = 1024;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const tvIcons = process.argv.includes('--tv-icons');
const appIcons = process.argv.includes('--app-icons');
let shots: readonly Shot[] = tvIcons ? TV_ICONS : appIcons ? APP_ICONS : SHOTS;
const spec = option('spec');
if (spec) {
  const list: unknown = JSON.parse(await readFile(spec, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${spec} must hold an array of shots`);
  shots = list.map((shot: unknown) => { assertShot(shot); return shot; });
}
const onlyIds = option('only');
if (onlyIds) {
  const only = new Set(onlyIds.split(','));
  shots = shots.filter((s) => only.has(s.id));
}
const outDir = path.resolve(option('out') ?? (tvIcons ? path.join(ROOT, '../../assets/tv-icon') : appIcons ? path.join(ROOT, '../../assets/app-icon') : ROOT));
const jobs = Number(option('jobs') ?? 2);
if (!shots.length) throw new Error('No shots to render');

// --- PNG ----------------------------------------------------------------------------

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// 8-bit RGB or RGBA PNG, choosing each row's filter by the usual minimum-sum heuristic.
function encodePng(width: number, height: number, pixels: Buffer, channels: 3 | 4 = 3) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0;
        const b = up[i];
        const c = i >= channels ? up[i - channels] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8); // 8-bit, RGB(A), deflate, adaptive filtering, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Every source pixel becomes an exact sx-by-sy block.
function upscale(rgba: Buffer, width: number, height: number, [sx, sy]: readonly [number, number]) {
  const w = width * sx;
  const out = Buffer.alloc(w * height * sy * 3);
  const line = Buffer.alloc(w * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      for (let k = 0; k < sx; k++) {
        const d = (x * sx + k) * 3;
        line[d] = rgba[s];
        line[d + 1] = rgba[s + 1];
        line[d + 2] = rgba[s + 2];
      }
    }
    for (let k = 0; k < sy; k++) line.copy(out, (y * sy + k) * w * 3);
  }
  return { width: w, height: height * sy, rgb: out };
}

async function writeImage(file: string, base64: string, width: number, height: number) {
  const big = upscale(Buffer.from(base64, 'base64'), width, height, UPSCALE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encodePng(big.width, big.height, big.rgb));
}

// Box-filters RGBA to any size: each output pixel averages the source area it covers, with
// alpha premultiplied so transparent pixels don't darken the edges.
function resample(rgba: Buffer, sw: number, sh: number, dw: number, dh: number) {
  const src = new Float32Array(sw * sh * 4);
  for (let i = 0; i < src.length; i += 4) {
    const a = rgba[i + 3] / 255;
    src.set([rgba[i] * a, rgba[i + 1] * a, rgba[i + 2] * a, rgba[i + 3]], i);
  }
  // One axis at a time: n source cells into m along each of `lines` rows or columns.
  const pass = (from: Float32Array, n: number, m: number, lines: number, at: (line: number, k: number) => number, outAt: (line: number, k: number) => number, size: number) => {
    const to = new Float32Array(size);
    for (let line = 0; line < lines; line++) {
      for (let d = 0; d < m; d++) {
        const x0 = (d * n) / m, x1 = ((d + 1) * n) / m;
        const acc = [0, 0, 0, 0];
        for (let k = Math.floor(x0); k < Math.ceil(x1); k++) {
          const w = Math.min(x1, k + 1) - Math.max(x0, k);
          const i = at(line, k);
          for (let c = 0; c < 4; c++) acc[c] += from[i + c] * w;
        }
        const o = outAt(line, d);
        for (let c = 0; c < 4; c++) to[o + c] = acc[c] / (x1 - x0);
      }
    }
    return to;
  };
  const wide = pass(src, sw, dw, sh, (y, x) => (y * sw + x) * 4, (y, x) => (y * dw + x) * 4, dw * sh * 4);
  const out = pass(wide, sh, dh, dw, (x, y) => (y * dw + x) * 4, (x, y) => (y * dw + x) * 4, dw * dh * 4);
  const bytes = Buffer.alloc(dw * dh * 4);
  for (let i = 0; i < bytes.length; i += 4) {
    const a = out[i + 3];
    for (let c = 0; c < 3; c++) bytes[i + c] = a > 0 ? Math.min(255, Math.round((out[i + c] * 255) / a)) : 0;
    bytes[i + 3] = Math.round(a);
  }
  return bytes;
}

// Gaussian blur of straight-alpha RGBA (sigma in pixels), with alpha premultiplied so clear
// pixels don't darken the edges. The image's edges are extended.
function blur(rgba: Buffer, width: number, height: number, sigma: number) {
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  let src = new Float32Array(width * height * 4);
  for (let i = 0; i < src.length; i += 4) {
    const a = rgba[i + 3] / 255;
    src.set([rgba[i] * a, rgba[i + 1] * a, rgba[i + 2] * a, rgba[i + 3]], i);
  }
  for (const [n, lines, at] of [
    [width, height, (line: number, k: number) => (line * width + k) * 4],
    [height, width, (line: number, k: number) => (k * width + line) * 4],
  ] as const) {
    const out = new Float32Array(src.length);
    for (let line = 0; line < lines; line++) {
      for (let d = 0; d < n; d++) {
        const o = at(line, d);
        for (let j = -radius; j <= radius; j++) {
          const i = at(line, Math.min(n - 1, Math.max(0, d + j)));
          const w = kernel[j + radius];
          for (let c = 0; c < 4; c++) out[o + c] += src[i + c] * w;
        }
      }
    }
    src = out;
  }
  const bytes = Buffer.alloc(rgba.length);
  for (let i = 0; i < bytes.length; i += 4) {
    const a = src[i + 3];
    for (let c = 0; c < 3; c++) bytes[i + c] = a > 0 ? Math.min(255, Math.round((src[i + c] * 255) / a)) : 0;
    bytes[i + 3] = Math.round(a);
  }
  return bytes;
}

const rgbOf = (rgba: Buffer) => {
  const rgb = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) rgba.copy(rgb, o, i, i + 3);
  return rgb;
};

// Draws straight-alpha RGBA `top` over `under`, in place.
function over(under: Buffer, top: Buffer) {
  for (let i = 0; i < under.length; i += 4) {
    const a = top[i + 3] / 255, b = (under[i + 3] / 255) * (1 - a), out = a + b;
    for (let c = 0; c < 3; c++) under[i + c] = out > 0 ? Math.round((top[i + c] * a + under[i + c] * b) / out) : 0;
    under[i + 3] = Math.round(out * 255);
  }
  return under;
}

// A layered shot: each layer at every icon size (or the 4x3 upscale for a 3:2 shot), plus the
// layers stacked back together at the first size, as the icon looks at rest.
async function writeLayers(dir: string, shot: Shot, frame: ThumbnailFrame) {
  const layers = frame.layers ?? [];
  const sizes = shot.format === 'tv-icon' ? TV_ICON_SIZES : shot.format === 'app-icon' ? [[APP_ICON_SIZE, APP_ICON_SIZE] as const]
    : [[frame.width * UPSCALE[0], frame.height * UPSCALE[1]] as const];
  let flat: Buffer | null = null;
  for (const [width, height] of sizes) {
    const folder = path.join(dir, `${width}x${height}`);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    for (const [i, layer] of layers.entries()) {
      let rgba = resample(Buffer.from(layer.rgba, 'base64'), frame.width, frame.height, width, height);
      const sigma = shot.layers?.find((l) => l.name === layer.name)?.blur;
      if (sigma) rgba = blur(rgba, width, height, (sigma * width) / 1280);
      await writeFile(path.join(folder, `${i + 1}-${layer.name}.png`), encodePng(width, height, rgba, 4));
      if (width === sizes[0][0]) flat = flat ? over(flat, rgba) : Buffer.from(rgba);
    }
  }
  const [width, height] = sizes[0];
  if (!flat) return;
  // An app icon is the stack itself beside its layers' folder: opaque, as the stores want, unless
  // nothing opaque is at the back.
  const opaque = flat.every((v, i) => i % 4 !== 3 || v === 255);
  if (shot.format === 'app-icon') await writeFile(`${dir}.png`, opaque ? encodePng(width, height, rgbOf(flat)) : encodePng(width, height, flat, 4));
  else await writeFile(path.join(dir, 'flat.png'), encodePng(width, height, flat, 4));
}

// --- Capture ------------------------------------------------------------------------

const buildDir = await mkdtemp(path.join(tmpdir(), 'aerodance-thumbnails-'));
const config = path.join(ROOT, 'vite.config.ts');
await build({ configFile: config, logLevel: 'warn', build: { outDir: buildDir, emptyOutDir: true } });
const server = await preview({ configFile: config, logLevel: 'warn', build: { outDir: buildDir }, preview: { port: 0, host: '127.0.0.1' } });
const base = server.resolvedUrls?.local[0];
if (!base) throw new Error('The preview server has no local URL');

// CHROMIUM_PATH picks another Chromium build when Google Chrome isn't installed; on a Mac it
// needs ANGLE's Metal backend, or headless Chromium falls back to SwiftShader.
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-gpu', ...(executablePath && process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
const context = await browser.newContext({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });

let failed = 0;
let logged = false;
const queue = [...shots];
async function worker() {
  for (let shot = queue.shift(); shot; shot = queue.shift()) {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const started = performance.now();
    try {
      const query = spec ? `spec=${encodeURIComponent(JSON.stringify(shot))}` : `${tvIcons || appIcons ? 'icon' : 'shot'}=${encodeURIComponent(shot.id)}`;
      await page.goto(`${base}?${query}`);
      await page.waitForFunction(() => (window as ThumbnailWindow).__thumb, null, { timeout: 60000 });
      if (!logged) {
        logged = true;
        console.log(`WebGL: ${await page.evaluate(() => (window as ThumbnailWindow).__thumb?.renderer)}`);
      }
      const frame = await page.evaluate(() => {
        const thumb = (window as ThumbnailWindow).__thumb;
        if (!thumb) throw new Error('The capture page is not ready');
        return thumb.render();
      });
      if (frame.layers) {
        await writeLayers(path.join(outDir, shot.id), shot, frame);
      } else if (shot.format === 'app-icon') {
        // Opaque, as the stores require; with the wordmark if the icon has one.
        const rgba = resample(Buffer.from(frame.logo ?? frame.plain, 'base64'), frame.width, frame.height, APP_ICON_SIZE, APP_ICON_SIZE);
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, `${shot.id}.png`), encodePng(APP_ICON_SIZE, APP_ICON_SIZE, rgbOf(rgba)));
      } else {
        await writeImage(path.join(outDir, 'no-logo', `${shot.id}.png`), frame.plain, frame.width, frame.height);
        if (frame.logo) await writeImage(path.join(outDir, 'with-logo', `${shot.id}.png`), frame.logo, frame.width, frame.height);
      }
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`✓ ${shot.id} (${seconds}s)${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${shot.id}: ${e instanceof Error ? e.message : e}${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
    } finally {
      await page.close();
    }
  }
}
try {
  await Promise.all(Array.from({ length: Math.min(jobs, shots.length) }, worker));
} finally {
  await browser.close();
  await server.close();
  await rm(buildDir, { recursive: true, force: true });
}
if (failed) {
  console.error(`${failed} shot(s) failed`);
  process.exit(1);
}
