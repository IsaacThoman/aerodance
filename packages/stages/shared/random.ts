// Deterministic randomness so every scene lays out the same way on each load.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Random {
  /** 0 <= x < 1. */
  next: () => number;
  range: (min: number, max: number) => number;
  /** An integer from min to max inclusive. */
  int: (min: number, max: number) => number;
  pick: <T>(list: readonly T[]) => T;
  sign: () => 1 | -1;
  chance: (p: number) => boolean;
}

export function makeRandom(seed = 1): Random {
  const rand = mulberry32(seed);
  return {
    next: rand,
    range: (min, max) => min + (max - min) * rand(),
    int: (min, max) => Math.floor(min + (max - min + 1) * rand()),
    pick: (list) => list[Math.floor(rand() * list.length)],
    sign: () => (rand() < 0.5 ? -1 : 1),
    chance: (p) => rand() < p,
  };
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, min = 0, max = 1): number => Math.min(max, Math.max(min, v));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential approach.
export const damp = (current: number, target: number, lambda: number, delta: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * delta));
