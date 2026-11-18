import type { V3 } from '../../minigames/table-tennis/ball.ts';

/* Small vector sums on ball.ts's plain { x, y, z } points, and the easing the players move by. */

export const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
export const dist3 = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
export const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const lerp = (a: V3, b: V3, u: number): V3 => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u });
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const smooth = (u: number) => { const c = clamp(u, 0, 1); return c * c * (3 - 2 * c); };
export const mixN = (a: number, b: number, u: number) => a + (b - a) * u;

/** `d` made square to the unit `n` (and unit): Gram-Schmidt, falling back to up or across. */
export function squareTo(d: V3, n: V3): V3 {
  let v = sub(d, scale(n, dot(d, n)));
  if (len(v) < 1e-4) v = sub({ x: 0, y: 1, z: 0 }, scale(n, n.y));
  if (len(v) < 1e-4) v = { x: 1, y: 0, z: 0 };
  return unit(v);
}

/** A cubic Hermite curve from a (with velocity va) to b (vb) over `span` seconds, `u` (0-1) of the way. */
export function hermite(a: V3, va: V3, b: V3, vb: V3, span: number, u: number): V3 {
  const t = clamp(u, 0, 1), t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return {
    x: h00 * a.x + h10 * span * va.x + h01 * b.x + h11 * span * vb.x,
    y: h00 * a.y + h10 * span * va.y + h01 * b.y + h11 * span * vb.y,
    z: h00 * a.z + h10 * span * va.z + h01 * b.z + h11 * span * vb.z,
  };
}

/** A seeded random number generator (mulberry32): the same match from the same seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value eased towards a goal, critically damped (a spring), its speed held under `max`. */
export interface Spring { x: number; v: number; }
export function springTo(s: Spring, goal: number, omega: number, dt: number, max = Infinity) {
  const a = omega * omega * (goal - s.x) - 2 * omega * s.v;
  s.v = clamp(s.v + a * dt, -max, max);
  s.x += s.v * dt;
}
