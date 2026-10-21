export type Rng = () => number;

export function mulberry32(a: number): Rng {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The world's seeded random stream. Builders draw from it in a fixed order, so the
 * order in which they run decides the layout. Later additions use their own streams
 * (withRng) so they never reshuffle the original layout.
 */
export interface WorldRandom {
  rnd(): number;
  /** Uniform in [a, b). */
  R(a: number, b: number): number;
  /** Integer in [a, b]. */
  RI(a: number, b: number): number;
  pick<T>(list: readonly T[]): T;
  gauss(): number;
  /** Runs fn with a fresh stream seeded by `seed`, then restores the current one. */
  withRng<T>(seed: number, fn: () => T): T;
}

export function createWorldRandom(seed: number): WorldRandom {
  let rng = mulberry32(seed);
  const rnd = () => rng();
  const R = (a: number, b: number) => a + (b - a) * rnd();
  return {
    rnd,
    R,
    RI: (a, b) => Math.floor(R(a, b + 1)),
    pick: (a) => a[Math.floor(rnd() * a.length)],
    gauss: () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2,
    withRng(s, fn) { const prev = rng; rng = mulberry32(s); try { return fn(); } finally { rng = prev; } },
  };
}
