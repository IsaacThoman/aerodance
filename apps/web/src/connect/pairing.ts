import { encode } from 'uqr';
import { FONT, ICONS, text } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import { spacedCode } from '../../../../packages/pairing/signals.ts';
import { pairingOrigin } from '../pose/PhonePoseSource.ts';
import type { PhonePairing } from '../pose/PhonePoseSource.ts';

/*
 * Pairing a phone, drawn in-engine on the calibration screen: the QR code that opens the
 * phone page with the code, and beside it Pair phone, the page's address and the code to type in.
 * Until the code comes, the same card with a QR code for the page itself (to type the code in)
 * and dashes for the digits.
 *
 * drawPairing(g, rect, { code, url });  drawPairing(g, rect, null);
 */

// White modules around the code; scanners need a quiet zone to find it.
const QUIET = 2;
const DARK = '#04223d';
const codes = new Map<string, ReturnType<typeof encode>>();

function qrCode(link: string, minVersion = 1) {
  const key = `${minVersion} ${link}`;
  let qr = codes.get(key);
  if (!qr) {
    qr = encode(link, { ecc: 'M', border: 0, minVersion });
    codes.set(key, qr);
  }
  return qr;
}

/**
 * A QR code for `link`, centred in `box` and as large as fits. Every module is a whole number
 * of render-buffer pixels (anything else smears under the pixelated upscale and stops
 * scanning) and square on screen. Returns the rect it took, in design units. `minVersion` keeps
 * a shorter link's code as many modules across as a longer one's.
 */
export function drawQr(g: CanvasRenderingContext2D, link: string, box: Rect, { minVersion = 1 } = {}): Rect {
  const { data } = qrCode(link, minVersion);
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

// The widest six-digit code in this font (its digits needn't be one width), so the card is laid
// out the same whichever code it shows, or none yet.
function widestCode(g: CanvasRenderingContext2D) {
  g.save();
  g.font = `800 72px ${FONT}`;
  const digits = [...'0123456789'].map(d => [d, g.measureText(d).width] as const);
  g.restore();
  const [digit] = digits.reduce((a, b) => (b[1] > a[1] ? b : a));
  return spacedCode(digit.repeat(6));
}

/**
 * The QR code, and beside it Pair phone, the address to open and the code to type, centred in
 * `rect`. Without a pairing yet, the same card with the page's own link in the QR code (as many
 * modules across as a code's link) and a dash for each digit: it's laid out around the widest
 * code, so nothing moves when the code comes.
 */
export function drawPairing(g: CanvasRenderingContext2D, rect: Rect, pairing: PhonePairing | null) {
  const k = Math.min(1.25, Math.max(0.8, rect.h / 260));
  const gap = 44 * k;
  const side = Math.min(rect.h, rect.w * 0.46);
  const url = new URL(pairing?.url ?? `${pairingOrigin()}/pair/`);
  const link = pairing?.url ?? `${url.origin}/pair/`;
  // A code's link, for how many modules across the QR code is.
  const { version } = qrCode(`${url.origin}/pair/#000000`);
  const address = `${url.host}/pair`;
  const code = pairing ? spacedCode(pairing.code) : '';
  const widest = widestCode(g);
  // The address and code share a column as wide as the wider of them, up to what's left.
  const room = rect.w - side - gap;
  const urlSize = fit(g, address, room, Math.round(26 * k), 800);
  const codeSize = fit(g, widest, room, Math.round(72 * k), 800, 0.08);
  g.font = `800 ${urlSize}px ${FONT}`;
  const urlW = g.measureText(address).width;
  g.save();
  g.font = `800 ${codeSize}px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = `${codeSize * 0.08}px`;
  const codeW = g.measureText(widest).width;
  g.restore();
  // Over them, the phone icon and Pair phone side by side.
  const iconR = 36 * k;
  const iconW = iconR * 0.6;
  const labelSize = Math.round(26 * k);
  g.font = `800 ${labelSize}px ${FONT}`;
  const headingW = iconW + 14 * k + g.measureText('Pair phone').width;
  const left = rect.x + (rect.w - side - gap - Math.max(urlW, codeW, headingW)) / 2;
  const qr = drawQr(g, link, { x: left, y: rect.y + (rect.h - side) / 2, w: side, h: side }, { minVersion: version });
  const x = qr.x + qr.w + gap;
  const mid = qr.y + qr.h / 2;
  const block = iconR + 22 * k + urlSize + 12 * k + codeSize;
  let y = mid - block / 2 + iconR / 2;
  g.save();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3 * k;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  ICONS.phone(g, x + iconW / 2, y, iconR);
  g.restore();
  text(g, 'Pair phone', x + iconW + 14 * k, y + 1, { size: labelSize, weight: 800 });
  y += iconR / 2 + 22 * k + urlSize / 2;
  text(g, address, x, y, { size: urlSize, weight: 800, color: '#bff4ff' });
  y += urlSize / 2 + 12 * k + codeSize / 2;
  g.save();
  if (pairing) {
    if ('letterSpacing' in g) g.letterSpacing = `${codeSize * 0.08}px`;
    text(g, code, x, y, { size: codeSize, weight: 800 });
  } else {
    // A dash where each digit will be, three and three as the code is.
    g.font = `800 ${codeSize}px ${FONT}`;
    const spacing = codeSize * 0.08;
    const digitW = g.measureText('0').width + spacing;
    const spaceW = g.measureText(' ').width + spacing;
    for (let i = 0; i < 6; i++) {
      const cx = x + i * digitW + (i >= 3 ? spaceW : 0) + (digitW - spacing) / 2;
      text(g, '–', cx, y, { size: codeSize, weight: 800, align: 'center' });
    }
  }
  g.restore();
}
