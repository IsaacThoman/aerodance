import { encode } from 'uqr';
import { FONT, paragraph, text } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import { spacedCode } from '../../../packages/pairing/signals.ts';
import type { PhonePairing } from '../pose/PhonePoseSource.ts';

/*
 * Pairing a phone, drawn in-engine on the calibration screen: the QR code that opens the
 * phone page with the code, and beside it the page's address and the code to type in.
 *
 * drawPairing(g, rect, { code, url });
 */

// White modules around the code; scanners need a quiet zone to find it.
const QUIET = 2;
const DARK = '#04223d';
const codes = new Map<string, boolean[][]>();

function modules(link: string) {
  let data = codes.get(link);
  if (!data) {
    data = encode(link, { ecc: 'M', border: 0 }).data;
    codes.set(link, data);
  }
  return data;
}

/**
 * A QR code for `link`, centred in `box` and as large as fits. Every module is a whole number
 * of render-buffer pixels (anything else smears under the pixelated upscale and stops
 * scanning) and square on screen. Returns the rect it took, in design units.
 */
export function drawQr(g: CanvasRenderingContext2D, link: string, box: Rect): Rect {
  const data = modules(link);
  const n = data.length + QUIET * 2;
  const t = g.getTransform();
  // Design units to buffer pixels; square on screen means width : height = sx : sy pixels.
  const sx = t.a, sy = t.d;
  let mw = 1, mh = 1;
  for (let h = 16; h >= 1; h--) {
    const w = Math.max(1, Math.round(h * sx / sy));
    if ((n * w) / sx <= box.w && (n * h) / sy <= box.h) { mw = w; mh = h; break; }
  }
  const W = n * mw, H = n * mh;
  const bx = Math.round(t.e + (box.x + box.w / 2) * sx - W / 2);
  const by = Math.round(t.f + (box.y + box.h / 2) * sy - H / 2);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#ffffff';
  g.fillRect(bx, by, W, H);
  g.fillStyle = DARK;
  data.forEach((row, y) => row.forEach((dark, x) => { if (dark) g.fillRect(bx + (x + QUIET) * mw, by + (y + QUIET) * mh, mw, mh); }));
  g.restore();
  return { x: (bx - t.e) / sx, y: (by - t.f) / sy, w: W / sx, h: H / sy };
}

const local = (host: string) => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host);

// The largest size up to `max` at which `str` fits in `w`, with `spacing` (a fraction of the
// size) between letters.
function fit(g: CanvasRenderingContext2D, str: string, w: number, max: number, weight: number, spacing = 0) {
  g.save();
  g.font = `${weight} ${max}px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = `${max * spacing}px`;
  const size = Math.min(max, Math.floor(max * w / g.measureText(str).width));
  g.restore();
  return size;
}

/** The QR code, and beside it the address to open and the code to type, centred in `rect`. */
export function drawPairing(g: CanvasRenderingContext2D, rect: Rect, pairing: PhonePairing) {
  const k = Math.min(1.25, Math.max(0.8, rect.h / 260));
  const gap = 44 * k;
  const side = Math.min(rect.h, rect.w * 0.46);
  const url = new URL(pairing.url);
  const address = `${url.host}/pair`;
  const code = spacedCode(pairing.code);
  // The address and code share a column as wide as the wider of them, up to what's left.
  const room = rect.w - side - gap;
  const urlSize = fit(g, address, room, Math.round(26 * k), 800);
  const codeSize = fit(g, code, room, Math.round(72 * k), 800, 0.08);
  g.font = `800 ${urlSize}px ${FONT}`;
  const urlW = g.measureText(address).width;
  g.save();
  g.font = `800 ${codeSize}px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = `${codeSize * 0.08}px`;
  const codeW = g.measureText(code).width;
  g.restore();
  const left = rect.x + (rect.w - side - gap - Math.max(urlW, codeW)) / 2;
  const qr = drawQr(g, pairing.url, { x: left, y: rect.y + (rect.h - side) / 2, w: side, h: side });
  const x = qr.x + qr.w + gap;
  const mid = qr.y + qr.h / 2;
  const block = urlSize + 16 * k + codeSize;
  text(g, address, x, mid - block / 2 + urlSize / 2, { size: urlSize, weight: 800, color: '#bff4ff' });
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${codeSize * 0.08}px`;
  text(g, code, x, mid + block / 2 - codeSize / 2, { size: codeSize, weight: 800 });
  g.restore();
  // The phone can't open this computer's own loopback address.
  if (local(url.hostname)) {
    paragraph(g, 'Open aerodance by its network address (not localhost) so your phone can reach it.', x, mid + block / 2 + 22 * k, rect.x + rect.w - x, { size: Math.round(15 * k), lineH: 19 * k, color: '#ffe27a' });
  }
}
