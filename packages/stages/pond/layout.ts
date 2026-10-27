import type { Vec2, Vec3 } from '../catalog.ts';
import { makeRandom, smoothstep } from '../shared/random.ts';

// World layout of the pond. The water's surface is y = 0 and the dancers stand on the giant
// lily pad in its middle, facing the camera on +z. The far bank, the island with its bridge and
// the distant hills fill the top of the frame; the cherry trees on the side banks lean in over
// the water; the koi circle the pad and cruise the open water around it.

// The koi, pads, flowers and petals are out on the water, so they draw before the glass dancers
// (renderOrder 0), deepest first. The dancers don't write depth, so anything drawn after them
// paints over them.
export const ORDER = { koi: -60, pads: -50, flowers: -40, petals: -30, twinkles: -20 };

export const CAMERA = { position: [0, 4.4, 14] as Vec3, target: [0, 1.45, 0] as Vec3, fov: 40 };

/** Towards the sun: high behind the dancers on the right, so their shadows fall forwards on the pad and the sun's glitter lands in the near water. */
export const SUN_DIRECTION: Vec3 = [0.42, 0.66, -0.62];

/** The dancers' pad: a giant water lily (a Victoria), its rim turned up. `top` is the floor the dancers stand on. */
export const STAGE_PAD = { radius: 4.3, rim: 0.3, top: 0.07 };

/** Pond bed depth: shelving quickly from the shore to the flat bottom. */
export const POND_DEPTH = 2.4;

/** Where the drops that start ripple rings may land (x, z min / max). */
export const DROP_AREA = { min: [-12, -16] as Vec2, max: [12, 7] as Vec2 };

/** Where petals settle on the water (x, z min / max). */
export const PETAL_AREA = { min: [-13, -15] as Vec2, max: [13, 8] as Vec2 };

const TAU = Math.PI * 2;

/** Around the pond: 0 straight back (-z), growing to the right (+x). */
export const azimuth = (x: number, z: number): number => Math.atan2(x, -z);

/** The stream that feeds the pond, coming in at the back left under the bridge: its azimuth, length and width (radians). */
export const INLET = { azimuth: -0.42, length: 10, width: 0.1 };

/** The shoreline's distance from the pond's middle by azimuth, leaving out the inlet: furthest straight back, nearest behind the camera. */
const baseShore = (a: number): number =>
  21 + 5 * Math.cos(a) + 2 * Math.sin(2 * a + 0.7) + 1.3 * Math.sin(3 * a + 1.9) + 0.8 * Math.sin(5 * a + 0.3) + 0.4 * Math.sin(9 * a + 2.2);

/** The shoreline's distance from the pond's middle, by azimuth. */
export function shoreRadius(a: number): number {
  const inlet = (a - INLET.azimuth) / INLET.width;
  return baseShore(a) + INLET.length * Math.exp(-inlet * inlet);
}

/** A small island in the back right, with a pine. */
export const ISLAND = { at: [12.9, -13.9] as Vec2, radius: 2.3, height: 0.7 };

/** The bridge across the stream's mouth: its middle (x, z), heading (radians from +x, turning to -z), length, arch height and width. */
export const BRIDGE = (() => {
  const r = baseShore(INLET.azimuth) + 1.6;
  const a = INLET.azimuth;
  return { at: [Math.sin(a) * r, -Math.cos(a) * r] as Vec2, heading: -a, length: 8.4, rise: 1.6, width: 1.4 };
})();

// Smooth value noise (about -1..1) from a seeded lattice.
const LATTICE = 64;
const lattice = (() => {
  const random = makeRandom(97);
  return Float32Array.from({ length: LATTICE * LATTICE }, () => random.next() * 2 - 1);
})();
export function noise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const at = (i: number, j: number) => lattice[(((iz + j) % LATTICE) + LATTICE) % LATTICE * LATTICE + ((((ix + i) % LATTICE) + LATTICE) % LATTICE)];
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
}

/** How far a point is from the shore: negative out on the water, positive up the bank. */
export function shoreDistance(x: number, z: number): number {
  const shore = Math.hypot(x, z) - shoreRadius(azimuth(x, z));
  const island = Math.hypot(x - ISLAND.at[0], z - ISLAND.at[1]) - ISLAND.radius * (1 + 0.08 * Math.sin(Math.atan2(z - ISLAND.at[1], x - ISLAND.at[0]) * 3 + 1));
  return Math.max(shore, -island);
}

/** Height of the ground, the pond bed under the water included. */
export function groundHeight(x: number, z: number): number {
  const d = shoreDistance(x, z);
  if (d < 0) {
    // The bed: a quick shelf, then the flat bottom with gentle undulations.
    return -POND_DEPTH * (1 - Math.exp(d / 1.5)) + 0.18 * noise2(x * 0.15 + 3.1, z * 0.15) * smoothstep(0, -4, d);
  }
  // The bank: a soft lip, then mossy mounds rising towards the hills behind.
  const ridge = Math.hypot(x, z);
  const mounds = (noise2(x * 0.09, z * 0.09 + 7) * 0.5 + 0.5) * 2.6 + noise2(x * 0.23 + 4, z * 0.23) * 0.5;
  const island = Math.max(0, 1 - Math.hypot(x - ISLAND.at[0], z - ISLAND.at[1]) / ISLAND.radius);
  return 0.45 * (1 - Math.exp(-d / 1.1)) + mounds * smoothstep(1.5, 9, d) + 3 * smoothstep(45, 90, ridge) + ISLAND.height * smoothstep(0, 0.7, island);
}

/** A lily pad: centre (x, z), radius, rotation of its notch. */
export interface Pad {
  at: Vec2;
  radius: number;
  turn: number;
  /** 0: fresh green, 1: deep green, 2: bronze-edged young pad. */
  tone: number;
}

/** The small pads around the pond, in clusters at the sides, behind the dancers and by the near corners. */
export const PADS: readonly Pad[] = [
  // Left of the dancers.
  { at: [-7.6, -1.6], radius: 1.05, turn: 2.2, tone: 0 },
  { at: [-9.4, -3.6], radius: 1.25, turn: 4.0, tone: 1 },
  { at: [-6.6, -4.4], radius: 0.7, turn: 0.6, tone: 2 },
  { at: [-11.4, -1.0], radius: 0.95, turn: 5.1, tone: 0 },
  { at: [-8.6, -6.6], radius: 0.85, turn: 1.4, tone: 0 },
  { at: [-12.0, -5.8], radius: 1.1, turn: 2.9, tone: 1 },
  // Right of the dancers.
  { at: [7.2, -3.0], radius: 1.15, turn: 3.1, tone: 0 },
  { at: [9.3, -1.2], radius: 0.9, turn: 5.6, tone: 2 },
  { at: [8.8, -5.4], radius: 1.0, turn: 0.9, tone: 1 },
  { at: [11.2, -3.8], radius: 1.2, turn: 3.6, tone: 0 },
  { at: [6.6, -6.8], radius: 0.65, turn: 4.6, tone: 0 },
  // Behind them.
  { at: [-2.8, -9.0], radius: 0.9, turn: 1.7, tone: 1 },
  { at: [-0.6, -10.8], radius: 1.1, turn: 2.0, tone: 0 },
  { at: [2.6, -9.6], radius: 0.75, turn: 0.2, tone: 2 },
  { at: [1.4, -13.4], radius: 1.2, turn: 1.1, tone: 1 },
  { at: [-4.4, -14.2], radius: 1.0, turn: 4.4, tone: 0 },
  { at: [5.6, -15.0], radius: 1.15, turn: 2.6, tone: 0 },
  // By the near corners, either side of the camera.
  { at: [-8.8, 4.2], radius: 1.1, turn: 5.3, tone: 0 },
  { at: [-10.6, 2.2], radius: 0.8, turn: 1.2, tone: 2 },
  { at: [8.4, 4.8], radius: 1.0, turn: 3.8, tone: 1 },
  { at: [10.6, 2.8], radius: 1.2, turn: 0.4, tone: 0 },
  // Behind the camera, for the preview's circle.
  { at: [-5.6, 9.6], radius: 1.0, turn: 2.4, tone: 1 },
  { at: [4.4, 10.4], radius: 1.1, turn: 4.9, tone: 0 },
  { at: [0.4, 12.6], radius: 0.8, turn: 3.3, tone: 2 },
];

/** Open lotus flowers: position, size, spin. */
export const LOTUS: readonly { at: Vec2; size: number; turn: number }[] = [
  { at: [-8.8, -3.0], size: 1.9, turn: 0.4 },
  { at: [7.8, -3.8], size: 1.7, turn: 1.9 },
  { at: [-0.2, -12.0], size: 1.8, turn: 2.8 },
  { at: [9.4, 4.0], size: 1.6, turn: 5.0 },
  { at: [-6.0, 10.2], size: 1.6, turn: 3.6 },
];

/** Closed lotus buds. */
export const BUDS: readonly { at: Vec2; size: number; turn: number }[] = [
  { at: [-10.6, -1.6], size: 1.3, turn: 1.0 },
  { at: [10.4, -2.2], size: 1.2, turn: 2.2 },
  { at: [-8.2, 4.8], size: 1.2, turn: 0.3 },
  { at: [3.0, -14.6], size: 1.3, turn: 4.1 },
];

/** Every pad on the water, the dancers' first: what the pads' distance field and shade are made from. */
export const ALL_PADS: readonly Pad[] = [{ at: [0, 0], radius: STAGE_PAD.radius + 0.06, turn: 0, tone: 0 }, ...PADS];

/**
 * A koi's swim: an unhurried loop around a slowly wandering centre, with a smaller lobe
 * (lobes x the loop's angle) folding it into a rounded clover so no two laps look alike.
 */
export interface KoiSwim {
  /** 0 kohaku, 1 tancho, 2 orange, 3 gold ogon, 4 platinum, 5 sanke. */
  variant: number;
  /** Length scale (world units for the 1-long model). */
  size: number;
  /** Below the surface. */
  depth: number;
  centre: Vec2;
  radius: Vec2;
  lobe: number;
  lobes: number;
  /** Radians per second around the loop; negative swims clockwise (seen from above). */
  speed: number;
  phase: number;
  /** How far the centre wanders. */
  wander: number;
}

export const KOI: readonly KoiSwim[] = [
  // Circling the dancers' pad, one each way.
  { variant: 0, size: 1.9, depth: 0.42, centre: [0, 0.4], radius: [6.6, 6.0], lobe: 0.6, lobes: 3, speed: 0.075, phase: 0.3, wander: 0.5 },
  { variant: 3, size: 1.8, depth: 0.85, centre: [0.4, -0.6], radius: [7.8, 6.8], lobe: 0.7, lobes: 2, speed: -0.062, phase: 2.6, wander: 0.7 },
  // Across the near water, in front of the pad.
  { variant: 1, size: 1.7, depth: 0.38, centre: [-2.4, 6.6], radius: [5.2, 1.6], lobe: 0.35, lobes: 2, speed: 0.1, phase: 4.0, wander: 0.6 },
  { variant: 5, size: 1.85, depth: 0.55, centre: [2.8, 6.4], radius: [5.6, 1.7], lobe: 0.3, lobes: 2, speed: -0.092, phase: 1.0, wander: 0.6 },
  // Out to the sides.
  { variant: 4, size: 1.75, depth: 0.5, centre: [-9.4, -2.8], radius: [3.2, 4.4], lobe: 0.4, lobes: 2, speed: 0.12, phase: 5.2, wander: 0.8 },
  { variant: 2, size: 1.9, depth: 0.45, centre: [9.6, -2.2], radius: [3.0, 4.6], lobe: 0.4, lobes: 2, speed: -0.11, phase: 3.3, wander: 0.8 },
  // Further back, behind the dancers.
  { variant: 0, size: 2.0, depth: 0.7, centre: [-3.8, -12.0], radius: [6.4, 3.2], lobe: 0.5, lobes: 2, speed: 0.07, phase: 0.8, wander: 1.0 },
  { variant: 2, size: 1.8, depth: 0.6, centre: [4.6, -11.0], radius: [5.6, 3.4], lobe: 0.45, lobes: 2, speed: -0.075, phase: 2.1, wander: 1.0 },
  { variant: 3, size: 1.7, depth: 1.0, centre: [0.4, -17.0], radius: [7.0, 3.0], lobe: 0.4, lobes: 2, speed: 0.06, phase: 4.6, wander: 1.0 },
];

/** A tree on the bank: foot (x, z), height, canopy radius, lean (radians, towards the water). */
export interface Tree {
  at: Vec2;
  height: number;
  crown: number;
  lean: number;
  seed: number;
}

/** A spot on the bank `d` up from the shore at azimuth a (radians). */
export function onBank(a: number, d: number): Vec2 {
  const r = shoreRadius(a) + d;
  return [Math.sin(a) * r, -Math.cos(a) * r];
}

export const CHERRIES: readonly Tree[] = [
  // Framing the view: leaning in over the water on either side.
  { at: onBank(-0.95, 1.6), height: 4.6, crown: 5.2, lean: 0.34, seed: 1 },
  { at: onBank(0.9, 1.6), height: 4.8, crown: 5.4, lean: 0.34, seed: 2 },
  { at: onBank(-0.66, 3.4), height: 4.2, crown: 4.4, lean: 0.2, seed: 3 },
  { at: onBank(0.6, 3.6), height: 4.4, crown: 4.6, lean: 0.18, seed: 4 },
  // Along the far bank.
  { at: onBank(0.16, 5.5), height: 4.6, crown: 4.8, lean: 0.1, seed: 5 },
  { at: onBank(-0.22, 4.2), height: 4.0, crown: 4.2, lean: 0.12, seed: 6 },
  // Round the sides and behind the camera, for the preview's circle.
  { at: onBank(-1.6, 2.0), height: 4.6, crown: 5.0, lean: 0.3, seed: 7 },
  { at: onBank(1.62, 2.2), height: 4.8, crown: 5.0, lean: 0.28, seed: 8 },
  { at: onBank(-2.4, 2.2), height: 4.4, crown: 4.8, lean: 0.26, seed: 9 },
  { at: onBank(2.35, 2.4), height: 4.6, crown: 5.0, lean: 0.26, seed: 10 },
  { at: onBank(3.05, 2.8), height: 4.8, crown: 5.2, lean: 0.22, seed: 11 },
];

/** Cloud-pruned pines: foot (x, z), height, spread. */
export const PINES: readonly Tree[] = [
  { at: [ISLAND.at[0] + 0.3, ISLAND.at[1] - 0.2], height: 3.4, crown: 2.4, lean: 0.3, seed: 21 },
  { at: onBank(-0.08, 2.6), height: 4.4, crown: 3.0, lean: 0.28, seed: 22 },
  { at: onBank(-1.25, 4.8), height: 5.4, crown: 3.2, lean: 0.12, seed: 23 },
  { at: onBank(1.28, 4.6), height: 5.2, crown: 3.2, lean: 0.14, seed: 24 },
  { at: onBank(2.8, 2.6), height: 4.4, crown: 3.0, lean: 0.24, seed: 25 },
  { at: onBank(-2.95, 3.2), height: 4.8, crown: 3.2, lean: 0.2, seed: 26 },
];

/** Stone lanterns: foot (x, z), height, turn. */
export const LANTERNS: readonly { at: Vec2; height: number; turn: number }[] = [
  { at: onBank(-0.78, 0.8), height: 1.8, turn: 0.4 },
  { at: onBank(0.5, 1.0), height: 1.5, turn: 1.2 },
  { at: [ISLAND.at[0] - 1.0, ISLAND.at[1] + 0.9], height: 1.1, turn: 2.0 },
  { at: onBank(2.05, 0.9), height: 1.7, turn: 0.8 },
  { at: onBank(-2.0, 0.9), height: 1.6, turn: 2.6 },
];

/** A seeded scatter of points along the shore: azimuth, distance up the bank, size, seed. */
export function shoreScatter(seed: number, count: number, band: Vec2, size: Vec2): { at: Vec2; size: number; seed: number }[] {
  const random = makeRandom(seed);
  return Array.from({ length: count }, (_, i) => {
    const a = ((i + random.range(0.1, 0.9)) / count) * TAU - Math.PI;
    return { at: onBank(a, random.range(band[0], band[1])), size: random.range(size[0], size[1]), seed: random.next() };
  });
}
