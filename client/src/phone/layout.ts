// The phone camera page's layout, in design units: the short side of the screen is 600
// units, so the long side follows the phone (portrait, or landscape when it's turned).
import type { Circle, Rect } from '../ui/draw.ts';
import type { DesignSize } from '../ui/useCanvasUI.ts';

export const SHORT_SIDE = 600;
const M = 28;
const GAP = 14;
const ROW = 64;

/** Design units for the page's CSS size. */
export const phoneDesign = (cssW: number, cssH: number): DesignSize => (cssW >= cssH
  ? { w: Math.round(SHORT_SIDE * cssW / cssH), h: SHORT_SIDE }
  : { w: SHORT_SIDE, h: Math.round(SHORT_SIDE * cssH / cssW) });

/** The render buffer's long side, at most (never more than the page's CSS pixels). */
export const PHONE_LONG_SIDE = 640;

/** The buffer for a page of this CSS size: the same shape, at most PHONE_LONG_SIDE long. */
export function phoneBuffer(cssW: number, cssH: number) {
  const scale = Math.min(1, PHONE_LONG_SIDE / Math.max(cssW, cssH, 1));
  return { w: Math.max(1, Math.round(cssW * scale)), h: Math.max(1, Math.round(cssH * scale)) };
}

export interface PhoneLayout {
  w: number; h: number; landscape: boolean;
  /** The wordmark's left end and baseline. */
  title: { x: number; y: number; size: number };
  /** Top right: leave the game. */
  leave: Circle;
  /** The status line under the wordmark. */
  status: { x: number; y: number; w: number };
  /** Setup: the camera preview. */
  preview: Rect;
  /** Setup: which camera (PhoneApp lays the page's camera list over it). */
  camera: Rect;
  /** Setup and the waiting screens: what's happening. */
  message: { x: number; y: number; w: number };
  /** The main button along the bottom (Done, Start camera, Cancel, Enter a code). */
  primary: Rect;
  /** Code entry: the six digits, and the keypad (1-9, delete, 0, join). */
  digits: Rect;
  keys: Rect[];
}

const row = (x: number, y: number, w: number, n: number, h = ROW): Rect[] => {
  const each = (w - GAP * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: x + i * (each + GAP), y, w: each, h }));
};

export function phoneLayout({ w, h }: DesignSize): PhoneLayout {
  const landscape = w > h;
  // Portrait: everything in one column. Landscape: the preview (and digits) on the left, the
  // controls (and keypad) on the right.
  const left = landscape ? { x: M, w: Math.round(w * 0.52) - M } : { x: M, w: w - M * 2 };
  const right = landscape ? { x: left.x + left.w + 32, w: w - left.x - left.w - 32 - M } : left;
  const title = { x: landscape ? right.x : M, y: 76, size: 50 };
  const leave = { x: w - M - 30, y: 56, r: 30 };
  const status = { x: title.x, y: 124, w: (landscape ? right.w : left.w) };

  const primary = { x: right.x, y: h - M - 80, w: right.w, h: 80 };
  const message = { x: right.x, y: primary.y - 64, w: right.w };
  const camera = { x: right.x, y: message.y - 26 - ROW, w: right.w, h: ROW };
  const top = landscape ? M : status.y + 30;
  const preview = { x: left.x, y: top, w: left.w, h: (landscape ? h - M : camera.y - 20) - top };

  // Code entry.
  const digits = landscape ? { x: left.x, y: h / 2 - 40, w: left.w, h: 96 } : { x: M, y: 300, w: left.w, h: 96 };
  // The keypad sits at the bottom, under the thumb.
  const padBottom = h - M;
  const keyH = Math.min(120, (padBottom - (landscape ? 170 : digits.y + digits.h + 40) - GAP * 3) / 4);
  const padTop = padBottom - keyH * 4 - GAP * 3;
  const keys = [0, 1, 2, 3].flatMap((r) => row(right.x, padTop + r * (keyH + GAP), right.w, 3, keyH));

  return { w, h, landscape, title, leave, status, preview, camera, message, primary, digits, keys };
}
