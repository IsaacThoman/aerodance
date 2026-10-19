import { encode } from 'uqr';
import { FONT, drawCaps, ellipsize, paragraph, text } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import { spacedCode } from '../../../packages/pairing/signals.ts';
import type { PhonePairing } from '../pose/PhonePoseSource.ts';

/*
 * Pairing a phone, drawn in-engine on the calibration screen: the QR code
 * that opens the phone page with the code, and the code itself to type in.
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

/** The QR code on the left of `rect`, and how to pair without it on the right. */
export function drawPairing(g: CanvasRenderingContext2D, rect: Rect, pairing: PhonePairing) {
  const side = Math.min(rect.h, rect.w * 0.42);
  const qr = drawQr(g, pairing.url, { x: rect.x, y: rect.y + (rect.h - side) / 2, w: side, h: side });
  const x = qr.x + qr.w + 28;
  const w = rect.x + rect.w - x;
  const k = Math.min(1.25, Math.max(0.8, rect.h / 260));
  const url = new URL(pairing.url);
  let y = rect.y + (rect.h - 230 * k) / 2 + 12 * k;
  drawCaps(g, 'PAIR A PHONE', x, y, { size: Math.round(20 * k) });
  y += 38 * k;
  y += paragraph(g, 'Scan the code with your phone’s camera, or open', x, y, w, { size: Math.round(19 * k), lineH: 24 * k });
  g.font = `800 ${Math.round(23 * k)}px ${FONT}`;
  text(g, ellipsize(g, `${url.host}/phone`, w), x, y + 4 * k, { size: Math.round(23 * k), weight: 800, color: '#bff4ff' });
  y += 34 * k;
  text(g, 'and type:', x, y, { size: Math.round(19 * k), color: 'rgba(255,255,255,0.88)' });
  y += 44 * k;
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${Math.round(4 * k)}px`;
  text(g, spacedCode(pairing.code), x, y, { size: Math.round(48 * k), weight: 800 });
  g.restore();
  y += 44 * k;
  // The phone can't open this computer's own loopback address.
  if (local(url.hostname)) paragraph(g, 'Open aerodance here by its network address (not localhost) so your phone can reach it.', x, y, w, { size: Math.round(16 * k), lineH: 20 * k, color: '#ffe27a' });
  else paragraph(g, 'Same Wi-Fi as this computer works best.', x, y, w, { size: Math.round(16 * k), lineH: 20 * k, color: 'rgba(255,255,255,0.7)' });
}
