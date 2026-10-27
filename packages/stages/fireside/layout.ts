import type { Vec3 } from '../catalog.ts';

// The glass A-frame, in world units (the dancers are about 2.6 tall, so a metre is about 1.5).
// The cabin stands on the shore a few units above the frozen lake, whose mirror is at y = 0
// (the polar kit's convention), so its floor is at FLOOR.
export const FLOOR = 3.2;

// The A: the roof planes meet the floor HALF either side of the ridge and the ridge at RIDGE
// above it. The front gable, all glass, is behind the dancers at GABLE; the room runs back
// past the camera to BACK.
export const HALF = 10.5;
export const RIDGE = 15.5;
export const GABLE = -7;
export const BACK = 30;

/** Where the inside of a roof plane is at height `y` above the floor (x = ±roofX(y)). */
export const roofX = (y: number): number => HALF * (1 - y / RIDGE);

// Rafter pairs, every RAFTER_STEP back from the gable's; collar ties cross between them at COLLAR.
export const RAFTER_STEP = 4;
export const RAFTERS = Array.from({ length: Math.ceil((BACK - GABLE) / RAFTER_STEP) }, (_, i) => GABLE + i * RAFTER_STEP);
export const COLLAR = 8.6;

// The gable's mullions (x) and its transom, which is the gable rafters' collar tie.
export const MULLIONS = [-5.6, 0, 5.6];

// The round hanging fireplace: off to the left and back, clear of the left dancer at every
// angle the preview swings to, its flue rising to the roof.
export const FIRE = { x: -6.65, z: -1.9, y: FLOOR + 1.55, radius: 1.05 };
/**
 * Where the fire's light comes from: out in front of the bowl's mouth, so the floor under the
 * bowl (which casts no shadow) isn't lit hardest.
 */
export const FIRE_LIGHT: Vec3 = [FIRE.x + 0.95, FIRE.y + 0.35, FIRE.z + 2.1];

// The lounge on the right: the sofa faces across the room towards the fire, a little turned
// to us, with a globe lamp behind its far end, a side table at its near end and a knitted
// pouf in front.
export const SOFA = { x: 6.6, z: -1.6, heading: -Math.PI / 2 + 0.38 };
export const SIDE_TABLE = { x: 5.4, z: 2.0, height: 0.78 };
/** The two mugs of cocoa on it: [x, z, colour, which way the handle points]. */
export const MUGS: readonly (readonly [x: number, z: number, color: string, turn: number])[] = [
  [SIDE_TABLE.x - 0.16, SIDE_TABLE.z + 0.14, '#f2ede6', 0.5],
  [SIDE_TABLE.x + 0.2, SIDE_TABLE.z + 0.08, '#c4562a', 2.4],
];
export const POUF = { x: 4.7, z: 4.0 };
export const LAMP = { x: 5.4, z: -4.6, height: 2.3 };

// The library on the left: a low bookcase under the slope, behind the fire.
export const SHELF = { x: -8.55, z0: -4.7, z1: 1.9, height: 1.75, depth: 0.8 };

// Potted plants: [x, z, size] (a fiddle-leaf fig either side of the window, smaller ones).
export const PLANTS: readonly (readonly [x: number, z: number, size: number])[] = [
  [-7.7, -5.7, 1.3],
  [7.25, -5.9, 1.35],
];

/** Candle flames, [x, y, z, size]: on the side table and along the top of the bookcase. */
export const CANDLES: readonly (readonly [x: number, y: number, z: number, size: number])[] = [
  [SIDE_TABLE.x - 0.12, FLOOR + SIDE_TABLE.height + 0.36, SIDE_TABLE.z - 0.2, 1],
  [SIDE_TABLE.x + 0.1, FLOOR + SIDE_TABLE.height + 0.26, SIDE_TABLE.z - 0.28, 0.85],
  [SHELF.x + 0.05, FLOOR + SHELF.height + 0.34, -0.2, 1],
  [SHELF.x + 0.1, FLOOR + SHELF.height + 0.26, 0.15, 0.85],
  [SHELF.x, FLOOR + SHELF.height + 0.3, -4.1, 0.9],
];

// The round rug the dancers stand on.
export const RUG = { radius: 4.6 };
