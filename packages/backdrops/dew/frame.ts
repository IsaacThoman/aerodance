// The camera the scene is composed for, and a helper to place things in frame at a depth.
import type { Vec3 } from '../../stages/catalog.ts';

export const CAMERA_POSITION: Vec3 = [0, 0, 10];
export const CAMERA_TARGET: Vec3 = [0, 0, 0];
export const FOV = 40;

const TAN = Math.tan(((FOV / 2) * Math.PI) / 180);

/**
 * World [x, y, z] for a point of the 16:9 frame at depth z: fx and fy run -1..1 from the
 * left and bottom edges to the right and top ones (4:3 shows fy out to about ±1.33).
 */
export function inFrame(fx: number, fy: number, z: number): Vec3 {
  const h = (CAMERA_POSITION[2] - z) * TAN;
  return [fx * h * (16 / 9), fy * h, z];
}

/** World units across one 16:9 frame half height at depth z. */
export function halfHeightAt(z: number): number {
  return (CAMERA_POSITION[2] - z) * TAN;
}
