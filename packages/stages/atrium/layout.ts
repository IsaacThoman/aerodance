import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';

// atrium: a round, sunlit eco-tech atrium. Curved white balconies dripping with plants ring a
// tall aquarium column standing in a reflecting pool, under a ribbed glass dome; at the back right
// a full-height glass wall looks out over a green park where a maglev glides past. The dancers
// stand on a round white stage reaching into the pool in front of the column.
//
// Positions around the atrium go by cylinder thetas about AXIS (x = r sin(theta), z = r cos(theta)):
// theta 0 faces the camera, +pi/2 is right, pi the back, -pi/2 the left.

/** Foot of the aquarium column, the centre of everything; the dancers stand at the origin in front of it. */
export const AXIS = new THREE.Vector3(0, 0, -8);
/** Radius of the balcony fronts around the void. */
export const VOID_R = 19;
/** How deep the balcony floors run back to the shop fronts. */
export const BALCONY_DEPTH = 5.5;
/** Balcony floor heights. */
export const LEVELS = [5.2, 10.4, 15.6] as const;
/** The dome's ring beam: its radius and height. */
export const DOME_R = VOID_R + BALCONY_DEPTH;
export const ROOF_Y = 20.8;
export const DOME_RISE = 7.5;
/**
 * The glass wall fills the back right, meeting the balconies at a white pier on each side. The
 * shop fronts run the rest of the way round (BALCONY_THETA), but the balconies leave a gap over
 * the camera (OPEN_THETA either side of theta 0), so it never looks through their plants as it
 * swings round the dancers.
 */
export const GLASS_THETA: readonly [number, number] = [1.45, 3.04];
export const BALCONY_THETA: readonly [number, number] = [GLASS_THETA[1], GLASS_THETA[0] + Math.PI * 2];
export const OPEN_THETA = 0.78;
export const BALCONY_ARCS: readonly (readonly [number, number])[] = [
  [GLASS_THETA[1], Math.PI * 2 - OPEN_THETA],
  [OPEN_THETA, GLASS_THETA[0]],
];
export const GLASS_R = VOID_R + 2.5;
/** The aquarium column and its pool. */
export const TANK_R = 1.5;
export const TANK_TOP = ROOF_Y + DOME_RISE;
export const POOL_R = 11.6;
export const WATER_Y = 0.32;

/** The dancers' stage: a round white platform at the origin, its front edge over the pool's rim. */
export const PLATFORM = { r: 4.6, top: 0.62 };

/** A glass-railed gallery ringing the column at the middle balconies' level, bridged back to them. */
export const GALLERY = { y: LEVELS[1], r: 3.6, bridges: [3.5, 2.72] as const, width: 2.0 };

/**
 * Indoor trees: broadleaf ones in round white planters shade both sides; palms and low cycads grow
 * from the planted bed along the glass wall.
 */
export interface TreeSpot {
  theta: number;
  r: number;
  height: number;
  kind: 'broad' | 'palm';
  seed: number;
  planter: boolean;
}
export const TREES: readonly TreeSpot[] = [
  { theta: -1.72, r: 14.2, height: 13, kind: 'broad', seed: 1, planter: true },
  { theta: -1.18, r: 15.8, height: 10.5, kind: 'broad', seed: 2, planter: true },
  { theta: -2.45, r: 14.6, height: 11, kind: 'broad', seed: 9, planter: true },
  { theta: 3.62, r: 14.4, height: 10, kind: 'broad', seed: 3, planter: true },
  { theta: 1.05, r: 15.6, height: 10.5, kind: 'broad', seed: 10, planter: true },
  { theta: 2.0, r: 18.8, height: 9.5, kind: 'palm', seed: 4, planter: false },
  { theta: 2.42, r: 19.4, height: 11, kind: 'palm', seed: 5, planter: false },
  { theta: 1.72, r: 18.4, height: 1.6, kind: 'palm', seed: 6, planter: false },
  { theta: 2.22, r: 18.6, height: 1.2, kind: 'palm', seed: 7, planter: false },
  { theta: 2.66, r: 19.0, height: 1.8, kind: 'palm', seed: 8, planter: false },
];
export const PLANTER_R = 1.7;

/** The camera, looking past the dancers to the column, a little up into the balconies. */
export const CAMERA = {
  position: [0, 2.7, 12.6] as Vec3,
  target: [0, 3.3, 0] as Vec3,
  fov: 46,
};

/** A point around the axis. */
export const polar = (r: number, theta: number, y = 0): THREE.Vector3 =>
  new THREE.Vector3(AXIS.x + r * Math.sin(theta), y, AXIS.z + r * Math.cos(theta));

/** theta wrapped to -pi..pi. */
export const wrapTheta = (theta: number): number => Math.atan2(Math.sin(theta), Math.cos(theta));

// GLSL constants matching the above.
const f = (n: number) => n.toFixed(4);
export const LAYOUT_GLSL = /* glsl */ `
const vec3 AXIS = vec3(${f(AXIS.x)}, ${f(AXIS.y)}, ${f(AXIS.z)});
const float VOID_R = ${f(VOID_R)};
const float DOME_R = ${f(DOME_R)};
const float GLASS_R = ${f(GLASS_R)};
const float ROOF_Y = ${f(ROOF_Y)};
const float DOME_RISE = ${f(DOME_RISE)};
const float TANK_R = ${f(TANK_R)};
const float TANK_TOP = ${f(TANK_TOP)};
const float POOL_R = ${f(POOL_R)};
const float WATER_Y = ${f(WATER_Y)};
const vec2 GLASS_THETA = vec2(${f(GLASS_THETA[0])}, ${f(GLASS_THETA[1])});
const float OPEN_THETA = ${f(OPEN_THETA)};
const vec3 LEVELS = vec3(${f(LEVELS[0])}, ${f(LEVELS[1])}, ${f(LEVELS[2])});
const vec3 PLATFORM = vec3(0.0, ${f(PLATFORM.top)}, ${f(PLATFORM.r)});
`;
