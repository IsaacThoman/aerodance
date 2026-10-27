import * as THREE from 'three';
import { makeRandom } from '../shared/random.ts';

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

/**
 * A 256x256 tileable noise texture for the shaders, in place of per-pixel simplex noise: four
 * independent gradient-noise fields (RGBA), each `cells` lattice cells across so that one cell
 * is one unit of `texture2D(uNoise, p / cells)`. Mipmapped, so noise squeezed into a few pixels
 * (a curtain seen edge-on) blurs instead of shimmering.
 */
export function makeNoiseTexture(cells = 32, size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let ch = 0; ch < 4; ch++) {
    const rand = makeRandom(311 + ch * 131);
    const gx = new Float32Array(cells * cells);
    const gy = new Float32Array(cells * cells);
    for (let i = 0; i < cells * cells; i++) {
      const a = rand.range(0, Math.PI * 2);
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    const field = new Float32Array(size * size);
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    // Lattice corners wrap around, so the texture tiles seamlessly.
    const corner = (ix: number, iy: number, dx: number, dy: number) => {
      const i = (iy % cells) * cells + (ix % cells);
      return gx[i] * dx + gy[i] * dy;
    };
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = (x / size) * cells;
        const py = (y / size) * cells;
        const ix = Math.floor(px);
        const iy = Math.floor(py);
        const fx = px - ix;
        const fy = py - iy;
        const u = fade(fx);
        const a = corner(ix, iy, fx, fy) + (corner(ix + 1, iy, fx - 1, fy) - corner(ix, iy, fx, fy)) * u;
        const b = corner(ix, iy + 1, fx, fy - 1) + (corner(ix + 1, iy + 1, fx - 1, fy - 1) - corner(ix, iy + 1, fx, fy - 1)) * u;
        const v = a + (b - a) * fade(fy);
        field[y * size + x] = v;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round(((field[i] - lo) / (hi - lo)) * 255);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
