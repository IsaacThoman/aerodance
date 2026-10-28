import * as THREE from 'three';

// Where everything sits, and the uniforms every material shares. The camera hangs near the
// origin looking down -z. The planet fills the lower right: its limb rises from the bottom of the
// frame to the top right, so the menu dancers stand in front of its sunlit oceans while the title
// floats over open space, and the sun crests the limb up in the top right.

export const PLANET_RADIUS = 100;
export const PLANET_CENTER = new THREE.Vector3(81, -71, -137);
/** The planet's spin axis in the world: nearly upright, so the tropics and mid-latitudes face the camera. */
export const PLANET_AXIS = new THREE.Vector3(0.35, 0.92, 0.05).normalize();
/** Radians per second the ground turns, and the clouds a little faster. */
export const SPIN_SPEED = (Math.PI * 2) / 1500;
export const CLOUD_SPEED = SPIN_SPEED * 1.35;

/** Where on the limb the sun rises: radians clockwise from the top of the planet's disc. */
export const SUN_CLOCK = -0.3;
/** Radians of sky between the sun's centre and the limb, and how far it rises and sinks. */
export const SUN_LIFT = 0.008;
export const SUN_BOB = 0.006;
/** Seconds the sun takes to rise a little and sink back. */
export const SUN_PERIOD = 84;
/** The sun's angular radius. */
export const SUN_SIZE = 0.011;

/** How far the planet's light swings round towards the camera, so its face is day, not night. */
export const KEY_TOWARDS_CAMERA = 0.75;

export const ORIGIN = new THREE.Vector3();
/** The camera's vertical field of view at 16:9. */
export const FOV = 40;

/** The direction from the camera at rest through a point of the 16:9 frame (0-1 from the top left). */
export function frameDirection(x: number, y: number): THREE.Vector3 {
  const tanY = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  return new THREE.Vector3((x * 2 - 1) * tanY * (16 / 9), (1 - y * 2) * tanY, -1).normalize();
}

/** Uniforms shared by reference across the materials, moved on by the backdrop clock. */
export const world = {
  uTime: { value: 0 },
  /** Towards the sun. */
  uSunDir: { value: new THREE.Vector3(0, 0, -1) },
  /** Towards the light the planet is shaded by: the sun swung round towards the camera. */
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  uCenter: { value: PLANET_CENTER },
  uRadius: { value: PLANET_RADIUS },
};

const toCenter = new THREE.Vector3();
const up = new THREE.Vector3();
const right = new THREE.Vector3();

/** The direction to the sun, `lift` radians above the planet's limb as seen from `eye`. */
export function sunDirection(eye: THREE.Vector3, lift: number, out: THREE.Vector3): THREE.Vector3 {
  toCenter.subVectors(PLANET_CENTER, eye);
  const distance = toCenter.length();
  toCenter.divideScalar(distance);
  const angle = Math.asin(PLANET_RADIUS / distance) + lift;
  // Screen-ish axes across the planet's disc: its top, and its right.
  up.set(0, 1, 0).addScaledVector(toCenter, -toCenter.y).normalize();
  right.crossVectors(toCenter, up);
  out.copy(up).multiplyScalar(Math.cos(SUN_CLOCK)).addScaledVector(right, Math.sin(SUN_CLOCK));
  return out.multiplyScalar(Math.sin(angle)).addScaledVector(toCenter, Math.cos(angle)).normalize();
}

/** The planet's key light: the sun swung round towards `eye`. */
export function keyDirection(sun: THREE.Vector3, eye: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  toCenter.subVectors(eye, PLANET_CENTER).normalize();
  return out.copy(sun).addScaledVector(toCenter, KEY_TOWARDS_CAMERA).normalize();
}

/** Seen from `eye`, how much of the sun shows over the limb (0 hidden, 1 clear). */
export function sunVisibility(eye: THREE.Vector3, sun: THREE.Vector3): number {
  toCenter.subVectors(PLANET_CENTER, eye);
  const distance = toCenter.length();
  const limb = Math.asin(PLANET_RADIUS / distance);
  const apart = Math.acos(THREE.MathUtils.clamp(toCenter.dot(sun) / distance, -1, 1));
  return THREE.MathUtils.smoothstep(apart, limb - SUN_SIZE, limb + SUN_SIZE * 1.5);
}
