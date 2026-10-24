import * as THREE from 'three';
import type { Vec3 } from '../../stages/catalog.ts';
import { ASPECT } from '../../stages/shared/hooks.ts';

// The camera hangs high over the cloud tops (the deck lies around y = 0), pitched a little down
// towards the sunrise, so the horizon sits about a quarter of the way down a 16:9 frame. The
// target is far off, so the camera's sway slides the deck beneath a steady sky rather than
// swinging the whole view.
const PITCH = THREE.MathUtils.degToRad(10.8);
export const CAMERA_POSITION: Vec3 = [0, 42, 60];
export const CAMERA_TARGET: Vec3 = [0, 42 - Math.sin(PITCH) * 1000, 60 - Math.cos(PITCH) * 1000];
export const CAMERA_FOV = 45;

// Where the sun sits in a 16:9 frame, in NDC: right of the title, above the dancers' heads.
const SUN_NDC: readonly [number, number] = [0.27, 0.66];

// The camera at rest, for laying things out where they land in the frame.
const restCamera = new THREE.PerspectiveCamera(CAMERA_FOV, ASPECT, 1, 100);
restCamera.position.set(...CAMERA_POSITION);
restCamera.lookAt(...CAMERA_TARGET);
restCamera.updateMatrixWorld();

/** The unit direction from the resting camera through a point of a 16:9 frame, in NDC. */
export function viewDirection(x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, 0.5).unproject(restCamera).sub(restCamera.position).normalize();
}

/** The point `distance` away from the resting camera that lands at [x, y] (NDC) in a 16:9 frame. */
export function viewPoint(x: number, y: number, distance: number): THREE.Vector3 {
  return viewDirection(x, y).multiplyScalar(distance).add(restCamera.position);
}

/** Unit vector towards the sun, a few degrees above the horizon. */
export const SUN_DIR = viewDirection(...SUN_NDC);

// The light the clouds are shaded by: from the sun's side but higher, so the tops catch gold
// while the faces towards the camera stay lavender (a sun this low would leave them all in shade).
const KEY_DIR = new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.35);
KEY_DIR.y = Math.tan(THREE.MathUtils.degToRad(16));
KEY_DIR.normalize();

// Sunrise palette (sRGB hex; THREE.Color converts to linear).
export const COLORS = {
  zenith: '#4f8ae0',
  high: '#8cacec',
  mid: '#dca6d2',
  low: '#ffa898',
  horizonWarm: '#ffc274',
  horizonCool: '#f5a8bc',
  sun: '#ffcf94',
  // Cloud light: warm sun, cool lavender sky fill, pink bounce from the deck below.
  cloudLit: '#ffb688',
  skyFill: '#8c8ee0',
  bounce: '#e898b8',
  crease: '#5c60b2',
};

const color = (hex: string) => new THREE.Color(hex);

// Uniforms shared by every shader in the scene (the same objects, so one write updates all).
export const atmos = {
  uTime: { value: 0 },
  uSunDir: { value: SUN_DIR.clone() },
  uKeyDir: { value: KEY_DIR },
  uZenith: { value: color(COLORS.zenith) },
  uHigh: { value: color(COLORS.high) },
  uMid: { value: color(COLORS.mid) },
  uLow: { value: color(COLORS.low) },
  uHorizonWarm: { value: color(COLORS.horizonWarm) },
  uHorizonCool: { value: color(COLORS.horizonCool) },
  uSunCol: { value: color(COLORS.sun) },
  uSkyFill: { value: color(COLORS.skyFill) },
  uBounce: { value: color(COLORS.bounce) },
  uCrease: { value: color(COLORS.crease) },
  uCloudLit: { value: color(COLORS.cloudLit) },
  uFogDensity: { value: 1 / 2000 },
};
