// The remote page's layout, in design units. Like the phone camera page (phone/layout.ts) the
// short side of the screen is 600 units, so the long side follows the screen: an iPhone shows
// the remote upright, an iPad either way up.
import type { Circle, Rect } from '../ui/draw.ts';
import type { DesignSize } from '../ui/useCanvasUI.ts';

const M = 28;
// The arrows (ARROW_R) around OK (OK_R), at full size.
const ARROW_R = 78;
const OK_R = 96;
const GAP = 14;
const REACH = OK_R + GAP + ARROW_R;
/** The pad's width and height at full size. */
export const PAD_SIZE = 2 * (REACH + ARROW_R);
const BACK_H = 96;
// The pad to Back, and Back's bottom to the hint's baseline.
const PAD_GAP = 48;
const HINT_GAP = 46;

export type RemoteButton = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';

export interface RemoteLayout {
  w: number; h: number; landscape: boolean;
  /** The wordmark's left end and baseline. */
  title: { x: number; y: number; size: number };
  /** The status line under the wordmark. */
  status: { x: number; y: number; w: number };
  /** Top right: where the game plays (the app lays its AirPlay picker over it). */
  airplay: Circle;
  up: Circle; down: Circle; left: Circle; right: Circle; ok: Circle;
  /** Back, or Pause / Resume during a song. */
  back: Rect;
  /** A line about the volume buttons: its centre and baseline. */
  hint: { x: number; y: number; w: number };
}

/** The pad of arrows around OK, centred on (cx, cy), `size` across. */
function pad(cx: number, cy: number, size: number) {
  const k = size / PAD_SIZE;
  const reach = REACH * k, r = ARROW_R * k;
  return {
    up: { x: cx, y: cy - reach, r }, down: { x: cx, y: cy + reach, r },
    left: { x: cx - reach, y: cy, r }, right: { x: cx + reach, y: cy, r },
    ok: { x: cx, y: cy, r: OK_R * k },
  };
}

export function remoteLayout({ w, h }: DesignSize): RemoteLayout {
  const landscape = w > h;
  const title = { x: M, y: 76, size: 50 };
  const airplay = { x: w - M - 30, y: 56, r: 30 };

  if (landscape) {
    // The wordmark, status and Back on the left; the pad on the right, under the AirPlay button.
    const colW = Math.round(w * 0.46) - M;
    const hint = { x: M + colW / 2, y: h - M - 6, w: colW };
    const back = { x: M, y: hint.y - HINT_GAP - BACK_H, w: colW, h: BACK_H };
    const area = { x: M + colW + 24, y: airplay.y + airplay.r + 12, w: 0, h: 0 };
    area.w = w - M - area.x;
    area.h = h - M - area.y;
    const size = Math.min(PAD_SIZE, area.w, area.h);
    return { w, h, landscape, title, airplay, status: { x: M, y: 124, w: colW }, back, hint,
      ...pad(area.x + area.w / 2, area.y + area.h / 2, size) };
  }

  // Upright: the pad and Back together, centred between the status line and the hint.
  const hint = { x: w / 2, y: h - M - 6, w: w - M * 2 };
  const top = 160, bottom = hint.y - HINT_GAP;
  const size = Math.min(PAD_SIZE, w - M * 2, bottom - top - PAD_GAP - BACK_H);
  const y = top + (bottom - top - (size + PAD_GAP + BACK_H)) / 2;
  const backW = Math.max(size, 360);
  const back = { x: (w - backW) / 2, y: y + size + PAD_GAP, w: backW, h: BACK_H };
  return { w, h, landscape, title, airplay, status: { x: M, y: 124, w: w - M * 2 - airplay.r * 2 - 16 }, back, hint,
    ...pad(w / 2, y + size / 2, size) };
}
