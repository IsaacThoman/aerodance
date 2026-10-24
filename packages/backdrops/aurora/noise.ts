import { makeRandom } from '../../stages/shared/random.ts';

export type Noise2 = (x: number, y: number) => number;

/** Seeded 2D gradient noise in about [-1, 1], for laying out the land on the CPU once. */
export function makeNoise2(seed: number): Noise2 {
  const rand = makeRandom(seed);
  const perm = new Uint8Array(512);
  const order = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = rand.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = order[i & 255];
  const gx = new Float32Array(256);
  const gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rand.range(0, Math.PI * 2);
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const corner = (ix: number, iy: number, dx: number, dy: number) => {
    const h = perm[perm[ix & 255] + (iy & 255)];
    return gx[h] * dx + gy[h] * dy;
  };
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fade(fx);
    const v = fade(fy);
    const a = corner(ix, iy, fx, fy) + (corner(ix + 1, iy, fx - 1, fy) - corner(ix, iy, fx, fy)) * u;
    const b = corner(ix, iy + 1, fx, fy - 1) + (corner(ix + 1, iy + 1, fx - 1, fy - 1) - corner(ix, iy + 1, fx, fy - 1)) * u;
    return (a + (b - a) * v) * 1.6;
  };
}

/** Octaves of noise summed, in about [-1, 1]. */
export function fbm2(noise: Noise2, x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x, y) * amp;
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 5.3;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Ridged octaves, 0 in the gullies to 1 along sharp crests. */
export function ridged2(noise: Noise2, x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x, y));
    const r = n * n * weight;
    weight = Math.min(1, r * 1.6);
    sum += r * amp;
    norm += amp;
    x = x * 2.07 + 31.7;
    y = y * 2.07 + 11.9;
    amp *= 0.5;
  }
  return sum / norm;
}
