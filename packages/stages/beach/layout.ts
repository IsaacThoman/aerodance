import { sandHeight } from './terrain.ts';
import type { Vec3 } from '../catalog.ts';

export const ground = (x: number, z: number): Vec3 => [x, sandHeight(x, z), z];

export const SURF_RACK = { at: [7.4, 0.8] as const, heading: -0.4 };

// Tiki torches flanking the dancers.
export const TORCHES: ReadonlyArray<readonly [x: number, z: number]> = [
  [-5.8, 3.3],
  [5.9, 3.1],
];

// The one coconut palm, leaning in over the left of the shot.
export const PALM = { x: -7.8, z: 1.4, height: 5.6, lean: 2.5, heading: -0.25, fronds: 12 };
