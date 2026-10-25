/** What covers a cutout's pixel. */
export const CUTOUT = { none: 0, body: 1, head: 2, hand: 3, eye: 4 } as const;

/** A moment of the menu capture (packages/character/assets/dance.adpose): its dancer and time. */
export interface CutoutPose { take: number; seconds: number; }

/** A thresholded cutout of the dancer (ui/dancerCutouts.ts), cropped to it. */
export interface Cutout {
  /** Pixels. */
  w: number;
  h: number;
  /** The body's middle, in whole pixels from the left: where it stands on its spot. */
  cx: number;
  /** CUTOUT values, row by row from the top. */
  part: Uint8Array;
}

/**
 * How many whole pixels `moving` must slide along x (`dir` 1 right, -1 left) to keep at least
 * `gap` pixels clear of `fixed` all round: 0 if it's clear already, or null if sliding it `limit`
 * pixels doesn't clear it. Both are W×H coverage masks, row by row from the top.
 */
export function clearShift(fixed: Uint8Array, moving: Uint8Array, W: number, H: number, dir: 1 | -1, gap = 1, limit = W): number | null {
  // Everywhere within `gap` of the fixed pixels.
  const near = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!fixed[y * W + x]) continue;
    for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) near[ny * W + nx] = 1;
    }
  }
  const pixels: number[] = [];
  for (let i = 0; i < moving.length; i++) if (moving[i]) pixels.push(i);
  for (let k = 0; k <= limit; k++) {
    const touches = pixels.some((i) => {
      const x = (i % W) + k * dir;
      return x >= 0 && x < W && near[i - (i % W) + x] === 1;
    });
    if (!touches) return k;
  }
  return null;
}
