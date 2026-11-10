// The shape of the land: a few broad, smooth bumps over a valley floor, with a river winding
// through the valley. The camera stands on a knoll looking down the valley (-z): a big hill rises
// on the left behind the menu, a turbine ridge on the right, and the valley opens in the middle.
import type { Vec3 } from '../../stages/catalog.ts';

export const CAMERA = { position: [0, 9, 0] as Vec3, target: [5, 5.2, -100] as Vec3, fov: 44 };

// The valley floor and the river's surface.
export const FLOOR = -9;
export const WATER = -8.85;
export const RIVER_HALF_WIDTH = 3.4;

// [x, z, radius x, radius z, height, angle]: smooth gaussian bumps.
const HILLS: readonly (readonly [number, number, number, number, number, number])[] = [
  // The knoll the camera stands on, falling away in front, with soft swells on its slope.
  [-6, 34, 46, 42, 14, 0],
  [-34, -26, 26, 16, 3.2, 0.3],
  [38, -30, 30, 18, 3.6, -0.25],
  [6, -46, 18, 10, 1.6, 0],
  // The big hill on the left, its crest rising out of frame.
  [-132, -112, 84, 62, 50, 0.35],
  [-62, -168, 40, 46, 18, 0],
  // The turbine ridge on the right, running away to the right.
  [118, -172, 120, 46, 34, -0.42],
  [64, -86, 34, 30, 9, 0],
  // Gentle swells along the valley.
  [-18, -260, 70, 40, 12, 0.2],
  [40, -330, 60, 50, 15, 0],
  // Far blue hills across the horizon.
  [-260, -620, 260, 120, 46, 0.1],
  [180, -760, 300, 140, 58, -0.15],
  [-40, -980, 380, 160, 44, 0],
  [520, -560, 220, 160, 70, 0.4],
  [-620, -900, 300, 220, 80, 0],
];

function hills(x: number, z: number): number {
  let y = FLOOR;
  for (const [hx, hz, rx, rz, h, a] of HILLS) {
    const dx = x - hx;
    const dz = z - hz;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const u = (dx * c - dz * s) / rx;
    const v = (dx * s + dz * c) / rz;
    y += h * Math.exp(-(u * u + v * v));
  }
  return y;
}

// The river, far to near: control points [x, z] of a Catmull-Rom path.
const RIVER_POINTS: readonly (readonly [number, number])[] = [
  [-150, -1300], [-60, -900], [40, -640], [-10, -470], [-50, -360], [10, -250],
  [44, -170], [20, -112], [-12, -78], [-40, -52], [-70, -34], [-120, -20],
];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** The river's centreline, sampled densely far to near: [x0, z0, x1, z1, ...]. */
export const RIVER_PATH: Float32Array = (() => {
  const steps = 14;
  const pts: number[] = [];
  const n = RIVER_POINTS.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = RIVER_POINTS[Math.max(0, i - 1)];
    const p1 = RIVER_POINTS[i];
    const p2 = RIVER_POINTS[i + 1];
    const p3 = RIVER_POINTS[Math.min(n - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      pts.push(catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t));
    }
  }
  pts.push(...RIVER_POINTS[n - 1]);
  return new Float32Array(pts);
})();

/** Distance from (x, z) to the river's centreline. */
export function riverDistance(x: number, z: number): number {
  let best = Infinity;
  const p = RIVER_PATH;
  for (let i = 0; i < p.length - 2; i += 2) {
    const ax = p[i];
    const az = p[i + 1];
    const bx = p[i + 2];
    const bz = p[i + 3];
    // Cheap reject: segments are short, so a far start point can't be closest.
    const dx0 = x - ax;
    const dz0 = z - az;
    if (Math.abs(dx0) > best + 60 || Math.abs(dz0) > best + 60) continue;
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.max(0, Math.min(1, (dx0 * ex + dz0 * ez) / (ex * ex + ez * ez)));
    const d = Math.hypot(dx0 - ex * t, dz0 - ez * t);
    if (d < best) best = d;
  }
  return best;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Ground height at (x, z). Every hill settles smoothly into a broad valley along the river, so
 * the river always runs on low ground and its banks never need carving (which the grid would
 * draw jagged); the water's own soft edges draw the shore.
 */
export function landHeight(x: number, z: number, river = riverDistance(x, z)): number {
  const valley = smooth(RIVER_HALF_WIDTH * 1.5, RIVER_HALF_WIDTH * 15, river);
  const bed = 1 - smooth(RIVER_HALF_WIDTH * 0.6, RIVER_HALF_WIDTH * 2.4, river);
  return FLOOR + (hills(x, z) - FLOOR) * valley - bed * 0.9;
}

/**
 * The point on the skyline seen at `azimuth` degrees right of straight ahead (-z): where the land
 * rises highest above the camera's eye line, searching `from`..`to` units out. Turbines stand a
 * little behind it, so their towers rise out of the crest.
 */
export function crestPoint(azimuth: number, from = 60, to = 700): [x: number, z: number, distance: number] {
  const [cx, cy, cz] = CAMERA.position;
  const a = (azimuth * Math.PI) / 180;
  let best: [number, number, number] = [cx, cz - from, from];
  let top = -Infinity;
  for (let r = from; r <= to; r += 2) {
    const x = cx + Math.sin(a) * r;
    const z = cz - Math.cos(a) * r;
    const e = (landHeight(x, z) - cy) / r;
    if (e > top) {
      top = e;
      best = [x, z, r];
    }
  }
  return best;
}

/**
 * Where the view ray at `azimuth` degrees right of ahead and `elevation` degrees above level
 * first meets the land: [x, z, distance]. Places things at a chosen spot in the frame.
 */
export function groundPoint(azimuth: number, elevation: number, to = 900): [x: number, z: number, distance: number] {
  const [cx, cy, cz] = CAMERA.position;
  const a = (azimuth * Math.PI) / 180;
  const slope = Math.tan((elevation * Math.PI) / 180);
  for (let r = 4; r <= to; r += 0.5) {
    const x = cx + Math.sin(a) * r;
    const z = cz - Math.cos(a) * r;
    if (cy + slope * r <= landHeight(x, z)) return [x, z, r];
  }
  return [cx + Math.sin(a) * to, cz - Math.cos(a) * to, to];
}
