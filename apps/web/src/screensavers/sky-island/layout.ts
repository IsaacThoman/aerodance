/*
 * Where everything on the sky island stands: its outline and its ground, the pond and the stream
 * that pours off its edge, the greenhouse, the clock tower, the turbines, the trees and the little
 * islets drifting round it. Plain numbers (no three.js), so the shape can be checked in tests and
 * the geometry built from it in Island.tsx and Buildings.tsx.
 *
 * The world: the island's top is about y = 0, 22 units across its middle; +y up, -z ahead of the
 * hero view (north, in the sky's frame: atmosphere.ts). The sea of clouds lies at SEA_Y below.
 */

export type XZ = readonly [x: number, z: number];

/** The top of the sea of clouds the waterfall pours into. */
export const SEA_Y = -70;
/** The island's lowest point, the tip of its rock. */
export const TIP_Y = -34;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** How far the island's edge is from its middle, `angle` radians round from +x towards +z. */
export function rimRadius(angle: number): number {
  return 21.2 + 1.7 * Math.sin(3 * angle + 0.6) + 1.1 * Math.sin(5 * angle + 2.1) + 0.55 * Math.sin(9 * angle + 1.3);
}

/** The pond: its middle, radius and water level. */
export const POND = { x: 5.5, z: 6.5, r: 4.3, ground: 0.15, level: -0.12 } as const;

/** Where the stream leaves the island: the direction of the falls from the middle (front right, towards the hero view). */
export const FALLS_ANGLE = Math.atan2(0.84, 0.54);
/** The lip the stream pours over, just inside the edge. */
export const LIP: XZ = [Math.cos(FALLS_ANGLE) * rimRadius(FALLS_ANGLE) * 0.985, Math.sin(FALLS_ANGLE) * rimRadius(FALLS_ANGLE) * 0.985];
/** The stream's level at the lip. */
export const LIP_LEVEL = -0.95;

/** The glass greenhouse: middle and radius. */
export const GREENHOUSE = { x: -8.6, z: -2.6, r: 6.2 } as const;

/** The clock tower: where it stands, the middle of its clock (the block its four faces are on) and the faces' size. */
export const TOWER = {
  x: 8.6, z: -7.4,
  /** Height of the clock block's middle above the ground, its half-width, and the faces' radius. */
  clockY: 12.6, half: 2.5, faceR: 2.08,
  /** The top of the block, where the glass cupola sits, and the cupola's radius. */
  top: 15.1, cupola: 2.15,
} as const;

/** Wind turbines: where they stand and how big (1: a 13-unit tower). */
export const TURBINES: readonly { x: number; z: number; s: number }[] = [
  { x: -3.5, z: -16.2, s: 1 },
  { x: -16.2, z: -9.0, s: 0.82 },
];

/** Round trees: [x, z, size, kind] (kind 0 green, 1 blossom, 2 lime). */
export const TREES: readonly (readonly [x: number, z: number, size: number, kind: number])[] = [
  [-16.2, 5.2, 1.15, 0], [-12.4, 11.6, 0.95, 1], [-5.2, 14.6, 0.85, 0], [14.6, -1.2, 1.05, 2],
  [17.2, 5.8, 0.8, 0], [1.8, -3.2, 0.72, 1], [-17.2, -3.4, 0.95, 2], [11.4, -12.2, 0.9, 0],
  [-9.6, -14.6, 1.1, 0], [16.6, -7.4, 0.78, 1], [-1.6, 8.4, 0.62, 2], [4.2, -14.8, 0.8, 2],
];

/** Lamp posts with glowing globes, along the way from the greenhouse to the tower and the pond. */
export const LAMPS: readonly XZ[] = [[-2.4, 0.6], [2.6, -1.0], [9.8, 1.6], [0.4, 10.6], [-6.8, 5.6]];

/** Little islets drifting round the island: [x, y, z, radius]. */
export const ISLETS: readonly (readonly [x: number, y: number, z: number, r: number])[] = [
  [-41, -7, -8, 4.6], [37, 3, -27, 3.4], [-28, 9, -44, 2.7], [45, -15, 15, 3.8], [-35, -22, 30, 2.9], [22, -30, -40, 3.2],
];

// Flat pads under the buildings (and round the pond), so they stand level: [x, z, radius].
const PADS: readonly (readonly [number, number, number])[] = [
  [GREENHOUSE.x, GREENHOUSE.z, GREENHOUSE.r + 0.6], [TOWER.x, TOWER.z, 3.4], [POND.x, POND.z, POND.r + 1.6],
  ...TURBINES.map((t) => [t.x, t.z, 1.6] as const),
];

const hill = (x: number, z: number, cx: number, cz: number, r: number, h: number) => h * smooth(1, 0, Math.hypot(x - cx, z - cz) / r);

/** The ground's shape before the pads and the water are cut into it. */
export function baseHeight(x: number, z: number): number {
  let h = 0.5 * Math.sin(x * 0.21 + 0.4) * Math.cos(z * 0.18 - 0.3) + 0.32 * Math.sin(x * 0.11 - z * 0.13 + 1.7);
  // A rise at the back for the turbines, and a smaller one on the left.
  h += hill(x, z, -7, -14, 13, 1.7) + hill(x, z, -15, 7, 7.5, 0.7) + hill(x, z, 15, -6, 8, 0.6);
  // Falling away gently to the edge.
  const edge = Math.hypot(x, z) / rimRadius(Math.atan2(z, x));
  return h - 1.0 * smooth(0.72, 1.0, edge);
}

// Distance from (x, z) to the segment a-b, and how far along it the nearest point is (0..1).
function toSegment(x: number, z: number, a: XZ, b: XZ): [number, number] {
  const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
  const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
  return [Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t), t];
}

/** Where the stream leaves the pond. */
export const OUTLET: XZ = (() => {
  const dx = LIP[0] - POND.x, dz = LIP[1] - POND.z, len = Math.hypot(dx, dz);
  return [POND.x + (dx / len) * POND.r * 0.85, POND.z + (dz / len) * POND.r * 0.85];
})();

/** The water's level along the stream (0 at the pond's outlet, 1 at the lip). */
export const streamLevel = (t: number) => mix(POND.level, LIP_LEVEL, smooth(0.15, 1, t));

/** The ground's height at (x, z): the base shape, levelled under the buildings, with the pond's basin and the stream's bed. */
export function groundHeight(x: number, z: number): number {
  let h = baseHeight(x, z);
  for (const [px, pz, r] of PADS) {
    const level = px === POND.x ? POND.ground : baseHeight(px, pz);
    h = mix(h, level, smooth(r * 1.35, r * 0.85, Math.hypot(x - px, z - pz)));
  }
  // The pond's basin, its banks just above the water.
  const dp = Math.hypot(x - POND.x, z - POND.z);
  h = mix(h, POND.level - 0.75, smooth(POND.r * 1.02, POND.r * 0.5, dp));
  // The stream's bed, a little below its water.
  const [ds, t] = toSegment(x, z, OUTLET, LIP);
  h = mix(h, Math.min(h, streamLevel(t) - 0.3), smooth(1.6, 0.6, ds));
  return h;
}

/** The stream's course: points from the pond's outlet to the lip, at the water's level. */
export function streamPath(steps = 14): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([mix(OUTLET[0], LIP[0], t), streamLevel(t), mix(OUTLET[1], LIP[1], t)]);
  }
  return out;
}

/**
 * The island's underside, `t` from its edge (0) to its tip (1): how far out the rock is as a share
 * of the edge's radius, and how far down. Bulging a little, narrowing to a point.
 */
export function undersideProfile(t: number, angle: number): { radius: number; y: number } {
  const lumps = 1 + 0.09 * Math.sin(angle * 7 + t * 9) * Math.sin(t * Math.PI) + 0.06 * Math.sin(angle * 13 - t * 15 + 1.1) * Math.sin(t * Math.PI);
  // (Rounding off at the tip rather than coming to a point.)
  const radius = Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.max(0, t)), 1.6)), 0.55) * (1 - 0.35 * t) * lumps;
  const y = -1.6 - (Math.abs(TIP_Y) - 1.6) * Math.pow(t, 1.25);
  return { radius: Math.max(0, radius), y };
}

/** A tree's canopy as a shadow caster: centre height above its foot, and radius. */
export const treeCanopy = (size: number) => ({ y: 3.1 * size, r: 1.75 * size });
