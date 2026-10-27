import * as THREE from 'three';

// Where everything sits, and the uniforms the stage's materials share. The dancers stand on the
// deck at the origin facing +z, the camera in front of them looking back down -z. The planet is
// far below and behind them: its limb arcs across the lower half of the frame behind the dancers,
// with the sun cresting it, and open space, the Moon and the station's hardware above.

/** The deck's top surface (the dancers' feet) and its radius. */
export const DECK_Y = 0;
export const DECK_RADIUS = 8;

export const CAMERA = { position: [0, 1.9, 15.5], target: [0, 1.35, 0], fov: 38 } as const;
/** Under the dome the camera stands back a little and higher, to take in its crown and garden. */
export const DOME_CAMERA = { position: [0, 2.1, 15], target: [0, 1.6, 0], fov: 40 } as const;

// --- The deck, the station and the dome ---------------------------------------------------------
// The deck is the top of a saucer-shaped module; under it the station's spine runs back along +z,
// behind the front camera, to its core: trusses out and up carrying two pairs of solar wings over
// the deck's sides, a habitat ring turning about the spine, and a docking port at its far end.

/** The deck slab's depth under its top surface. */
export const DECK_THICKNESS = 0.36;
/** The ring of glass windows in the deck: inner and outer radius, and how many. */
export const DECK_WINDOWS = { inner: 5.45, outer: 6.85, count: 8 } as const;
/** The low glass rail round the deck's edge: its radius and height. */
export const DECK_RAIL = { radius: DECK_RADIUS - 0.24, height: 0.5 } as const;
/** The spine's height (it runs along +z from under the deck) and length. */
export const SPINE = { y: -4.3, length: 52 } as const;
/** The node where the wing trusses leave the spine. */
export const WING_NODE_Z = 22;
/**
 * Each side's solar wings: their height, x span of the pair, and z span. The right-hand pair
 * reaches less far forward (`fore`) so it stays clear of the Moon from the front camera.
 */
export const WINGS = { y: 8.5, x: [12, 28], z: [-22, 56], fore: { left: -22, right: -8 } } as const;
/** The habitat ring round the spine. */
export const HABITAT = { z: 38, radius: 13, tube: 1.15 } as const;
/** The garden dome on orbitdome: radius at its foot and height. */
export const DOME = { radius: 7.55, height: 6.6 } as const;

// ---------------------------------------------------------------------------------------------
// The planet and the sky (Planet.tsx, Space.tsx).
//
// Seen from the default camera the planet's centre lies 55° below the view, 2950 away, so its
// limb tops out just under eye level (behind the dancers' waists) and falls away to either side,
// a third of the frame lower at its edges. Everything in the sky is in world space; the camera
// only ever moves a few units, nothing next to the planet's size.

export const PLANET_RADIUS = 2400;
export const PLANET_CENTER = new THREE.Vector3(0, -2416, -1678);
/** The planet's spin axis in the world, lying nearly level so the tropics and mid-latitudes are below the deck. */
export const PLANET_AXIS = new THREE.Vector3(0.93, 0.35, 0.11).normalize();
/** Radians per second the ground turns, and the clouds a little faster. */
export const SPIN_SPEED = (Math.PI * 2) / 2400;
export const CLOUD_SPEED = SPIN_SPEED * 1.4;

/** The sun's angular radius. */
export const SUN_SIZE = 0.011;

/** The default camera, the eye the sun and the planet's lighting are set up for. */
const EYE = new THREE.Vector3(...CAMERA.position);
const toCenter = new THREE.Vector3();
const discUp = new THREE.Vector3();
const discRight = new THREE.Vector3();

/**
 * The direction from the default camera to a point `lift` radians above the planet's limb, `clock`
 * radians round from the top of its disc (negative: to the left).
 */
function overLimb(clock: number, lift: number): THREE.Vector3 {
  toCenter.subVectors(PLANET_CENTER, EYE);
  const distance = toCenter.length();
  toCenter.divideScalar(distance);
  const angle = Math.asin(PLANET_RADIUS / distance) + lift;
  discUp.set(0, 1, 0).addScaledVector(toCenter, -toCenter.y).normalize();
  discRight.crossVectors(toCenter, discUp);
  const out = discUp.clone().multiplyScalar(Math.cos(clock)).addScaledVector(discRight, Math.sin(clock));
  return out.multiplyScalar(Math.sin(angle)).addScaledVector(toCenter, Math.cos(angle)).normalize();
}

/** Seen from `eye`, how much of the sun shows over the limb (0 hidden, 1 clear). */
export function sunVisibility(eye: THREE.Vector3, sun: THREE.Vector3): number {
  toCenter.subVectors(PLANET_CENTER, eye);
  const distance = toCenter.length();
  const limb = Math.asin(PLANET_RADIUS / distance);
  const apart = Math.acos(THREE.MathUtils.clamp(toCenter.dot(sun) / distance, -1, 1));
  return THREE.MathUtils.smoothstep(apart, limb - SUN_SIZE, limb + SUN_SIZE * 1.5);
}

/** Towards the sun, cresting the limb left of the dancers. It's low: light the deck from higher. */
export const SUN_DIR = overLimb(-0.36, 0.013);
/** On the night side the sun has set behind the planet: just under the limb, left of centre. */
export const NIGHT_SUN_DIR = overLimb(-0.22, -0.03);

/** Towards the Moon: high on the right, behind the dancers. */
export const MOON_DIR = new THREE.Vector3(0.39, 0.2, -0.9).normalize();

/** The directions the planet's day and night faces are shaded from (see Planet.tsx). */
const fromCenter = EYE.clone().sub(PLANET_CENTER).normalize();
/** By day the sun swung round towards the camera, so the face it sees is sunlit, not night. */
export const DAY_KEY_DIR = SUN_DIR.clone().addScaledVector(fromCenter, 0.8).normalize();
/** By night the real set sun, so dusk only touches the limb by the sunset. */
export const NIGHT_KEY_DIR = NIGHT_SUN_DIR.clone();

// ---------------------------------------------------------------------------------------------

/** The three looks of the stage. */
export interface OrbitVariant {
  /** Over the night side: city lights, the aurora, the sun set behind the planet. */
  night: boolean;
  /** The deck closed under a glass dome, with planters. */
  dome: boolean;
}

/** Uniforms shared by reference across the stage's materials, moved on by the stage clock. */
export const world = {
  uTime: { value: 0 },
  /** 1 on the beat, decaying (shared/hooks.ts beat.pulse). */
  uBeat: { value: 0 },
  /** Towards the sun (SUN_DIR or NIGHT_SUN_DIR). */
  uSunDir: { value: SUN_DIR.clone() },
  /** 0 on the day side, 1 on the night side. */
  uNight: { value: 0 },
  uCenter: { value: PLANET_CENTER },
  uRadius: { value: PLANET_RADIUS },
};
