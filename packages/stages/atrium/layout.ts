import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';

// atrium: a round, sunlit eco-tech atrium. Curved white balconies dripping with plants ring a
// tall aquarium column standing in a reflecting pool, under a ribbed glass dome; on the right a
// full-height glass wall looks out over a green park where a maglev glides past. On the stage,
// the dancers dance on the stone floor in front of the pool.
//
// Positions around the atrium go by cylinder thetas about AXIS (x = r sin(theta), z = r cos(theta)):
// theta 0 faces the cameras, +pi/2 is right, pi the back, -pi/2 the left.

/** Foot of the aquarium column, the centre of everything. */
export const AXIS = new THREE.Vector3(0, 0, -8);
/** Radius of the balcony fronts around the void. */
export const VOID_R = 14.5;
/** How deep the balcony floors run back to the shop fronts. */
export const BALCONY_DEPTH = 5.5;
/** Balcony floor heights. */
export const LEVELS = [4.8, 9.6, 14.4] as const;
/** The dome's ring beam: its radius and height. */
export const DOME_R = VOID_R + BALCONY_DEPTH;
export const ROOF_Y = 19.2;
export const DOME_RISE = 6;
/**
 * The balconies run from the back round the left and the front; the glass wall fills the right.
 * Behind the aquarium, as the cameras see it, the column hides the pier where they meet.
 */
export const BALCONY_THETA: readonly [number, number] = [3.04, 1.45 + Math.PI * 2];
export const GLASS_THETA: readonly [number, number] = [1.45, 3.04];
export const GLASS_R = VOID_R + 2.5;
/** The aquarium column and its pool. */
export const TANK_R = 1.2;
export const TANK_TOP = ROOF_Y + DOME_RISE;
export const POOL_R = 6.2;
export const WATER_Y = 0.32;

/**
 * The way in, straight in front of the column: the ground floor's shop fronts open onto the
 * street there, with no pilotis, low hedge or long vines across it, so the stage's camera can
 * stand in it. Thetas either side of 0.
 */
export const ENTRANCE = 0.42;

/** A glass-railed gallery ringing the column at the middle balconies' level, bridged back to them. */
export const GALLERY = { y: LEVELS[1], r: 3.2, bridges: [3.5, 2.72] as const, width: 2.0 };

/**
 * Indoor trees: broadleaf ones in round white planters shade the left; palms and low cycads grow
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
  { theta: -1.72, r: 10.6, height: 12.5, kind: 'broad', seed: 1, planter: true },
  { theta: -1.2, r: 12.2, height: 10, kind: 'broad', seed: 2, planter: true },
  { theta: 3.62, r: 10.8, height: 9.5, kind: 'broad', seed: 3, planter: true },
  { theta: 2.0, r: 14.6, height: 8.5, kind: 'palm', seed: 4, planter: false },
  { theta: 2.42, r: 15.0, height: 10, kind: 'palm', seed: 5, planter: false },
  { theta: 1.72, r: 14.2, height: 1.6, kind: 'palm', seed: 6, planter: false },
  { theta: 2.22, r: 14.4, height: 1.2, kind: 'palm', seed: 7, planter: false },
  { theta: 2.66, r: 14.8, height: 1.8, kind: 'palm', seed: 8, planter: false },
];
export const PLANTER_R = 1.7;

/** Towards the sun: high, behind and to the right (just out of frame), so beams slant steeply down to the left. */
export const SUN_DIR = new THREE.Vector3(0.36, 0.84, -0.4).normalize();

export const MENU_CAMERA = {
  position: [AXIS.x - 1.3, 2.3, AXIS.z + 12.6] as Vec3,
  target: [AXIS.x - 1.3, 6.0, AXIS.z] as Vec3,
  fov: 56,
};

/** The stage's camera, in the entrance, looking in past the dancers at the column. */
export const STAGE_CAMERA = {
  position: [AXIS.x, 1.5, AXIS.z + 16.6] as Vec3,
  target: [AXIS.x, 2.3, AXIS.z + 8] as Vec3,
  fov: 56,
};

/** A point around the axis. */
export const polar = (r: number, theta: number, y = 0): THREE.Vector3 =>
  new THREE.Vector3(AXIS.x + r * Math.sin(theta), y, AXIS.z + r * Math.cos(theta));

// GLSL constants matching the above.
const f = (n: number) => n.toFixed(4);
export const LAYOUT_GLSL = /* glsl */ `
const vec3 AXIS = vec3(${f(AXIS.x)}, ${f(AXIS.y)}, ${f(AXIS.z)});
const float VOID_R = ${f(VOID_R)};
const float DOME_R = ${f(DOME_R)};
const float ROOF_Y = ${f(ROOF_Y)};
const float DOME_RISE = ${f(DOME_RISE)};
const float TANK_R = ${f(TANK_R)};
const float TANK_TOP = ${f(TANK_TOP)};
const float POOL_R = ${f(POOL_R)};
const float WATER_Y = ${f(WATER_Y)};
const vec2 GLASS_THETA = vec2(${f(GLASS_THETA[0])}, ${f(GLASS_THETA[1])});
const vec3 LEVELS = vec3(${f(LEVELS[0])}, ${f(LEVELS[1])}, ${f(LEVELS[2])});
const float ENTRANCE = ${f(ENTRANCE)};
`;
