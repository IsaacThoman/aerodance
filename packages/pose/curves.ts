// Keyframe curves: a channel's value at any time from its keys (format.ts Key).
//
// Each key's interp shapes the segment after it: smooth is a cubic Hermite, linear a straight
// line and hold a step at the next key. The tangent at a key comes from its ease: auto averages
// the neighbouring slopes (weighted for uneven spacing, as a non-uniform Catmull-Rom) but goes
// flat on any component where the key is a turning point and is limited where it would
// overshoot, so a smooth curve never swings past its keys; stop is flat, so the motion settles
// into the key; sharp keeps each side's own slope, a hit with a corner in the velocity. Before
// the first key and after the last the channel holds. Values are numeric vectors.
export type Interp = 'smooth' | 'linear' | 'hold';
export type Ease = 'auto' | 'stop' | 'sharp';

export interface CurveKey { t: number; v: readonly number[]; interp?: Interp; ease?: Ease; }

/** Slopes in value per ms. */
function slope(a: CurveKey, b: CurveKey, c: number) {
  return (b.v[c] - a.v[c]) / (b.t - a.t);
}
/** The tangent arriving at (side 'in') or leaving (side 'out') key i, per component. */
export function tangent(keys: readonly CurveKey[], i: number, side: 'in' | 'out', c: number): number {
  const key = keys[i], prev = keys[i - 1], next = keys[i + 1];
  const ease = key.ease ?? 'auto';
  if (ease === 'stop') return 0;
  const left = prev ? slope(prev, key, c) : null, right = next ? slope(key, next, c) : null;
  if (ease === 'sharp') return side === 'in' ? left ?? 0 : right ?? 0;
  // The ends start and finish at rest: a dancer's first and last poses are still. So does a
  // hold: motion settles into a held key and starts from rest after one.
  if (left === null || right === null) return 0;
  if ((key.interp ?? 'smooth') === 'hold' || (prev!.interp ?? 'smooth') === 'hold') return 0;
  if (left * right <= 0) return 0; // a turning point (or flat on one side): no overshoot
  // Fritsch-Carlson: a tangent at most three times either slope keeps both segments monotone.
  const limit = 3 * Math.min(Math.abs(left), Math.abs(right));
  const limited = (m: number) => Math.sign(m) * Math.min(Math.abs(m), limit);
  // A linear segment on one side: continue its slope into the curve on the other, as far as
  // that stays monotone.
  if ((prev!.interp ?? 'smooth') === 'linear' && (key.interp ?? 'smooth') !== 'linear') return limited(left);
  if ((key.interp ?? 'smooth') === 'linear' && (prev!.interp ?? 'smooth') !== 'linear') return limited(right);
  const dl = key.t - prev!.t, dr = next!.t - key.t;
  return limited((left * dr + right * dl) / (dl + dr));
}
/** The index of the last key at or before t (-1 before the first). */
export function keyIndexAt(keys: readonly { t: number }[], t: number): number {
  let lo = 0, hi = keys.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
/** The channel's value at t, with as many components as the keys' values (keys may not be empty). */
export function evaluate(keys: readonly CurveKey[], t: number, out: number[] = []): number[] {
  const n = keys.length;
  if (!n) throw Error('A curve needs at least one key');
  const size = keys[0].v.length;
  out.length = size;
  const i = keyIndexAt(keys, t);
  if (i < 0) { for (let c = 0; c < size; c++) out[c] = keys[0].v[c]; return out; }
  if (i >= n - 1 || t === keys[i].t) { for (let c = 0; c < size; c++) out[c] = keys[i].v[c]; return out; }
  const a = keys[i], b = keys[i + 1], interp = a.interp ?? 'smooth';
  const span = b.t - a.t, u = (t - a.t) / span;
  for (let c = 0; c < size; c++) {
    if (interp === 'hold') out[c] = a.v[c];
    else if (interp === 'linear') out[c] = a.v[c] + (b.v[c] - a.v[c]) * u;
    else {
      const m0 = tangent(keys, i, 'out', c) * span, m1 = tangent(keys, i + 1, 'in', c) * span;
      const u2 = u * u, u3 = u2 * u;
      out[c] = (2 * u3 - 3 * u2 + 1) * a.v[c] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b.v[c] + (u3 - u2) * m1;
    }
  }
  return out;
}
/** Value and velocity (per second) at t, by central difference over 1 ms. */
export function velocity(keys: readonly CurveKey[], t: number): number[] {
  const a = evaluate(keys, t - 0.5), b = evaluate(keys, t + 0.5);
  return a.map((v, c) => (b[c] - v) * 1000);
}
