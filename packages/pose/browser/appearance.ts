/*
 * What a person looks like, for telling players apart when where they stand can't: the colours
 * of their clothes on the chest, the waist and the thighs, sampled from a small copy of the
 * camera picture. Each part is its chromaticity (r and g of r+g+b, so lighting matters less)
 * and its brightness, quarter-weighted: how much of a white shirt or a dark jacket shows
 * changes as somebody moves.
 */

/** The picture's pixels, as ImageData has them. */
export interface Pixels { data: ArrayLike<number>; width: number; height: number; }
interface Point { x: number; y: number; visibility?: number | null; presence?: number | null; }

/** The width of the picture copy looks are sampled from. */
export const LOOKS_WIDTH = 128;
const RELIABLE = 0.5;
/** Whether the model is sure of a landmark (visible, and in the picture). */
export const reliable = (p: Point) => (p.visibility ?? 0) >= RELIABLE && (p.presence ?? 1) >= RELIABLE;
const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The mean colour around some points (picture fractions), or null when none fall inside. */
function mean(pixels: Pixels, points: readonly { x: number; y: number }[]) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const p of points) {
    const cx = Math.round(p.x * pixels.width), cy = Math.round(p.y * pixels.height);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
      const o = (y * pixels.width + x) * 4;
      r += pixels.data[o]; g += pixels.data[o + 1]; b += pixels.data[o + 2]; n++;
    }
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  const sum = r + g + b || 1;
  return [r / sum, g / sum, (r + g + b) / 765 / 4];
}

/** A person's looks from their landmarks (picture fractions), or null when their torso isn't clear. */
export function describeLooks(pixels: Pixels, landmarks: readonly Point[]): number[] | null {
  const [ls, rs, lh, rh, lk, rk] = [11, 12, 23, 24, 25, 26].map(i => landmarks[i]);
  if (![ls, rs, lh, rh].every(reliable)) return null;
  // Points across the torso, some way down from the shoulders (v) and in from the sides (u).
  const torso = (v: number) => [0.3, 0.5, 0.7].map(u => lerp(lerp(ls, rs, u), lerp(lh, rh, u), v));
  const chest = mean(pixels, [...torso(0.25), ...torso(0.4)]);
  const waist = mean(pixels, [...torso(0.7), ...torso(0.85)]);
  const thighs = [[lh, lk], [rh, rk]].filter(([, k]) => reliable(k)).flatMap(([h, k]) => [lerp(h, k, 0.3), lerp(h, k, 0.6)]);
  const legs = thighs.length ? mean(pixels, thighs) : waist;
  return chest && waist && legs ? [...chest, ...waist, ...legs] : null;
}
