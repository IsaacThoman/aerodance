import * as THREE from 'three';

// Where everything sits, and the uniforms the stage's materials share. The dancers stand on the
// deck at the origin facing +z, the camera in front of them looking back down -z. The planet is
// far below and behind them: its limb arcs across the lower half of the frame behind the dancers,
// with the sun cresting it, and open space, the Moon and the station's hardware above.

/** The deck's top surface (the dancers' feet) and its radius. */
export const DECK_Y = 0;
export const DECK_RADIUS = 7.5;

export const PLANET_RADIUS = 2400;
export const PLANET_CENTER = new THREE.Vector3(0, -2480, -1900);

/** Towards the sun over the limb: ahead of the camera, a little left, low over the planet. */
export const SUN_DIR = new THREE.Vector3(-0.38, 0.12, -1).normalize();
/** On the night side the sun has set behind the planet: just under the limb. */
export const NIGHT_SUN_DIR = new THREE.Vector3(-0.3, -0.16, -1).normalize();

/** Towards the Moon: high on the right, behind the dancers. */
export const MOON_DIR = new THREE.Vector3(0.55, 0.42, -0.72).normalize();

export const CAMERA = { position: [0, 1.9, 15.5], target: [0, 1.35, 0], fov: 38 } as const;
/** Inside the dome the camera stands closer. */
export const DOME_CAMERA = { position: [0, 1.75, 13], target: [0, 1.4, 0], fov: 40 } as const;

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
