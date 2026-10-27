import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';

// Where everything stands. The dancers are at the origin facing +z (the camera); the cabin is
// behind them on the left, its glass gable turned to look at them, so it frames them from the
// side instead of hiding behind them.

/** The glass A-frame, in its own frame: x across the gable, y up from the snow, z out of the glass. */
export const CABIN = {
  /** Where the foot of the glass gable meets the snow, and which way the glass faces. */
  x: -13.6,
  z: -17.5,
  heading: 0.68,
  /** Half the A's span and its apex, measured on the inside of the roof from the cabin floor. */
  halfWidth: 5.6,
  height: 9.4,
  /** The cabin floor (and the deck in front) above the snow. */
  floor: 1.3,
  /** Glass to the back wall. */
  depth: 11,
  /** The roof's thickness, and how far it reaches out over the glass and the deck. */
  roof: 0.42,
  overhang: 1.1,
  /** The deck's reach in front of the glass. */
  deck: 3.4,
} as const;

/** Cabin space to world space. */
export const CABIN_MATRIX = new THREE.Matrix4().compose(
  new THREE.Vector3(CABIN.x, 0, CABIN.z),
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), CABIN.heading),
  new THREE.Vector3(1, 1, 1),
);
export const CABIN_INVERSE = CABIN_MATRIX.clone().invert();

/** A point in the cabin's frame, in the world. */
export function cabinPoint(x: number, y: number, z: number): Vec3 {
  const p = new THREE.Vector3(x, y, z).applyMatrix4(CABIN_MATRIX);
  return [p.x, p.y, p.z];
}

/** How far (x, z) is outside the cabin and its deck (negative inside). */
export function cabinClearance(x: number, z: number): number {
  const p = new THREE.Vector3(x, 0, z).applyMatrix4(CABIN_INVERSE);
  const halfX = CABIN.halfWidth + 0.8;
  const front = CABIN.deck + 1.6;
  const back = -CABIN.depth - 0.8;
  const dx = Math.abs(p.x) - halfX;
  const dz = Math.max(back - p.z, p.z - front);
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
}

/** The foot of the deck's steps, where the path to the dancers starts. */
export const STEPS = cabinPoint(0, 0, CABIN.deck + 1.4);

/** Lantern posts either side of the dancers, a little in front. */
export const LANTERN_POSTS: ReadonlyArray<readonly [x: number, z: number]> = [
  [-7.0, 3.6],
  [6.6, 3.2],
];

/** Lanterns on the deck: on the posts either side of the steps (cabin frame). */
export const DECK_LANTERNS: ReadonlyArray<readonly [x: number, z: number]> = [
  [-1.45, CABIN.deck - 0.15],
  [1.45, CABIN.deck - 0.15],
];

/** Outside the preview camera's circle, so it never stands between the camera and the dancers. */
export const SNOWMAN = { x: 11.5, z: -16.5, heading: -0.5, scale: 1.3 };
/** Stood on end, leaning back against the right-hand lantern post. */
export const SLED = { x: 6.0, z: 3.75, heading: -0.3 };
export const WOODPILE = { x: -CABIN.halfWidth - 1.3, z: -4.2 };

/** The stovepipe through the roof's left slope (cabin frame, x and z). */
export const STOVEPIPE = { x: -2.6, z: -7.6 };
