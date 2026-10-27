import * as THREE from 'three';
import type { Vec3 } from '../../stages/catalog.ts';

// The camera looks straight down -z, so a thing's place on screen is just its x and y over its
// distance. Everything is laid out in frame fractions at a distance.
export const CAMERA = { position: [0, 0, 10] as Vec3, target: [0, 0, 0] as Vec3, fov: 45 };

/** Half the 16:9 frame's height and width, per unit of distance from the camera. */
export const TAN_Y = Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2));
export const TAN_X = TAN_Y * (16 / 9);
/** Half the 4:3 frame's height per unit of distance (it keeps the width and shows more). */
export const TAN_Y_TALL = TAN_X * (3 / 4);

// World units the camera can wander off its base (sway plus the lean towards the pointer).
const WANDER = 0.55;

/** Where something rises and how, in frame terms. */
export interface RiserSpec {
  /** Frame fraction, 0 left to 1 right. */
  fx: number;
  distance: number;
  /** Radius as a fraction of the 16:9 frame's height. */
  size: number;
  /** 0..1 round its loop at time 0 (0: just below the frame). */
  start: number;
  /** About how long it takes to cross the frame. */
  seconds?: number;
  /**
   * Or how long its whole loop takes: risers sharing a loop keep their places in it relative to
   * each other, so they can take turns.
   */
  loop?: number;
  /** The margin kept beyond the frame's edges, in radii, for what draws round it (glow, wobble). */
  pad?: number;
}

/** Something that rises through the frame forever, wrapping out of sight. */
export interface Riser {
  x: number;
  z: number;
  /** World radius. */
  r: number;
  /** Bottom of its loop and the loop's height: it wraps beyond the tallest frame. */
  yMin: number;
  yRange: number;
  /** World units per second. */
  speed: number;
  /** Where in its loop it starts, in world units. */
  y0: number;
}

/** A riser's place in the world from its place in the frame. */
export function riser({ fx, distance, size, start, seconds = 60, loop, pad = 1.4 }: RiserSpec): Riser {
  const r = size * 2 * TAN_Y * distance;
  const half = TAN_Y_TALL * distance + r * pad + WANDER;
  const yRange = half * 2;
  return {
    x: (fx * 2 - 1) * TAN_X * distance,
    z: CAMERA.position[2] - distance,
    r,
    yMin: -half,
    yRange,
    speed: loop ? yRange / loop : (TAN_Y * 2 * distance) / seconds,
    y0: start * yRange,
  };
}
