import type { Vec2, Vec3 } from '../../stages/catalog.ts';

// World layout of the pond. The water surface is y = 0 and the camera looks steeply down on it
// from the near (+z) bank, so +x is screen right and -z is up the screen. At 16:9 the frame spans
// about x -9.4..9.4 at its top edge (z -5.7) and x -6.2..6.2 at its bottom edge (z 4.3); 4:3 adds
// about 3 units above and 1 below. The title and buttons cover roughly x -6.7..-0.7, z -1.2..2.9
// and the dancers x 0.8..5.7, z -0.7..3.6, so the lily pads ring the corners and the top edge,
// and the koi mostly cruise the upper half and the open middle.

export const CAMERA = { position: [0, 10, 6] as Vec3, target: [0, -0.6, 0] as Vec3, fov: 40 };

/** Pond floor depth below the surface: shallow on the right, shelving deep (and dark) under the menu. */
export const FLOOR_DEPTH = { base: 1.6, deep: 1.9 };

/** Towards the sun (above the far bank), so its glitter lands on the open water up and right of the title. */
export const SUN_DIRECTION: Vec3 = [0.235, 0.67, -0.704];

/** Where the drops that start ripple rings may land (x, z min / max). */
export const DROP_AREA = { min: [-3.5, -6.5] as Vec2, max: [8.5, 2.5] as Vec2 };

/** Where petals settle on the water (x, z min / max). */
export const PETAL_AREA = { min: [-10, -8] as Vec2, max: [9, 4.5] as Vec2 };

/** A lily pad: centre (x, z), radius, rotation of its notch. */
export interface Pad {
  at: Vec2;
  radius: number;
  turn: number;
  /** 0: fresh green, 1: deep green, 2: bronze-edged young pad. */
  tone: number;
}

export const PADS: readonly Pad[] = [
  // Top right corner, beside the sun's glitter: the showpiece cluster, running off the frame.
  { at: [8.0, -4.5], radius: 1.3, turn: 2.2, tone: 0 },
  { at: [5.9, -5.6], radius: 0.95, turn: 4.0, tone: 1 },
  { at: [9.3, -2.4], radius: 1.05, turn: 0.6, tone: 0 },
  { at: [6.3, -3.4], radius: 0.62, turn: 5.1, tone: 1 },
  { at: [4.6, -7.4], radius: 1.0, turn: 1.4, tone: 0 },
  { at: [8.2, -7.2], radius: 1.15, turn: 2.6, tone: 1 },
  // Down the right edge, above the dancers.
  { at: [7.5, -0.9], radius: 0.85, turn: 3.1, tone: 2 },
  // Top left corner, above the title.
  { at: [-8.3, -4.6], radius: 1.25, turn: 5.6, tone: 1 },
  { at: [-6.2, -5.5], radius: 0.95, turn: 0.9, tone: 0 },
  { at: [-9.3, -2.6], radius: 0.9, turn: 3.6, tone: 0 },
  { at: [-6.9, -3.4], radius: 0.6, turn: 4.6, tone: 2 },
  { at: [-4.3, -6.2], radius: 0.8, turn: 1.7, tone: 1 },
  { at: [-5.8, -7.8], radius: 1.0, turn: 2.0, tone: 0 },
  { at: [-8.9, -7.1], radius: 1.1, turn: 0.2, tone: 1 },
  // Bottom left corner, under the buttons.
  { at: [-5.4, 4.0], radius: 1.15, turn: 1.1, tone: 0 },
  { at: [-3.3, 4.8], radius: 0.85, turn: 4.4, tone: 1 },
  { at: [-6.9, 2.6], radius: 0.7, turn: 2.9, tone: 2 },
  // Bottom right corner, just past the dancers' stand.
  { at: [6.3, 4.4], radius: 0.95, turn: 5.3, tone: 1 },
];

/** Open lotus flowers: position, size, spin. */
export const LOTUS: readonly { at: Vec2; size: number; turn: number }[] = [
  { at: [6.9, -4.2], size: 2.7, turn: 0.4 },
  { at: [-7.4, -4.2], size: 2.3, turn: 1.9 },
  { at: [7.3, -1.5], size: 1.9, turn: 2.8 },
];

/** Closed lotus buds. */
export const BUDS: readonly { at: Vec2; size: number; turn: number }[] = [
  { at: [9.0, -3.8], size: 1.6, turn: 1.0 },
  { at: [-4.8, 3.5], size: 1.5, turn: 2.2 },
  { at: [-5.3, -4.9], size: 1.3, turn: 0.3 },
];

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
  { variant: 0, size: 2.6, depth: 0.45, centre: [1.6, -3.0], radius: [4.6, 3.3], lobe: 0.45, lobes: 2, speed: 0.1, phase: 0.3, wander: 1.0 },
  { variant: 3, size: 2.4, depth: 1.05, centre: [-0.8, -3.2], radius: [4.0, 2.8], lobe: 0.4, lobes: 2, speed: -0.105, phase: 2.1, wander: 0.9 },
  { variant: 1, size: 2.3, depth: 0.38, centre: [4.6, 0.2], radius: [3.3, 3.4], lobe: 0.35, lobes: 2, speed: 0.12, phase: 4.0, wander: 0.8 },
  { variant: 2, size: 2.5, depth: 1.15, centre: [-4.2, 1.6], radius: [4.2, 3.0], lobe: 0.4, lobes: 2, speed: -0.095, phase: 1.2, wander: 1.0 },
  { variant: 4, size: 2.35, depth: 0.55, centre: [0.4, 2.4], radius: [4.8, 3.3], lobe: 0.4, lobes: 2, speed: 0.09, phase: 5.2, wander: 0.9 },
  { variant: 5, size: 2.5, depth: 0.42, centre: [6.0, -3.4], radius: [3.4, 2.7], lobe: 0.3, lobes: 2, speed: -0.11, phase: 3.3, wander: 0.7 },
  { variant: 0, size: 2.2, depth: 1.2, centre: [-5.0, -4.8], radius: [3.4, 2.6], lobe: 0.35, lobes: 2, speed: 0.105, phase: 0.8, wander: 0.9 },
];
