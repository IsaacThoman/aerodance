/** What covers a cutout's pixel: each of the dancer's parts, or nothing. */
export const CUTOUT = { none: 0, body: 1, head: 2, leftHand: 3, rightHand: 4, leftFoot: 5, rightFoot: 6, eye: 7 } as const;

/** A held pose: the bones it moves (by name), each its local [x, y, z] position and [x, y, z, w] rotation. */
export type CutoutPose = Readonly<Record<string, readonly number[]>>;

/** A thresholded cutout of the dancer (ui/dancerCutouts.ts), cropped to it. */
export interface Cutout {
  /** Pixels. */
  w: number;
  h: number;
  /** Pixels per character unit. */
  ppu: number;
  /** The body's middle, in pixels from the left: where it stands on its spot. */
  cx: number;
  /** CUTOUT values, row by row from the top. */
  part: Uint8Array;
  /** How near each pixel is, 255 nearest. */
  depth: Uint8Array;
}

// The eyes are part of the head.
const solid = (p: number) => p === CUTOUT.eye ? CUTOUT.head : p;

/**
 * The pixels within `gap` of a nearer, different part (a hand in front of the body, the head
 * over a hand): cut out, so each part reads on its own.
 */
export function seams(c: Cutout, gap: number) {
  const cut = new Uint8Array(c.w * c.h);
  const ring: [number, number][] = [];
  for (let y = -gap; y <= gap; y++) for (let x = -gap; x <= gap; x++) if ((x || y) && x * x + y * y <= gap * gap) ring.push([x, y]);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const i = y * c.w + x, p = solid(c.part[i]);
    if (!p) continue;
    for (const [dx, dy] of ring) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= c.w || ny >= c.h) continue;
      const j = ny * c.w + nx, q = solid(c.part[j]);
      if (q && q !== p && c.depth[j] > c.depth[i] + 2) { cut[i] = 1; break; }
    }
  }
  return cut;
}
