import * as THREE from 'three';
import type { Vec2, Vec3 } from '../../stages/catalog.ts';
import { ASPECT } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';

export const CAMERA = { position: [0, 0.6, 14] as Vec3, target: [0, 2.2, 0] as Vec3, fov: 45 };

/** Strands each jelly trails: long tentacles from the margin, then frilly oral arms from the middle. */
export const TENTACLES = 14;
export const ARMS = 4;
export const STRANDS = TENTACLES + ARMS;

interface JellySpec {
  /** Where it sits in the 16:9 frame, 0..1 from the top left. Drifting ones only use x. */
  frame: Vec2;
  /** From the camera, along that line of sight. */
  distance: number;
  radius: number;
  /** jellyPal: 0 cyan, 1/3 pink, 2/3 violet. */
  hue: number;
  /** Units a second it drifts up, wrapping round unseen (0: bobs in place). */
  rise?: number;
  /** Radians; + leans the top right, so it swims up and right. */
  lean?: number;
  /** Units it wanders about its place. */
  roam?: number;
  /** Tentacle length, in bell radii. */
  tentacles?: number;
  /** Oral arm length, in bell radii. */
  arms?: number;
  /** Bell height: 1 a full dome, about 0.5 a moon jelly's saucer. */
  height?: number;
  /** Radians the apex tips towards the camera (more shows a flat bell's top). */
  tip?: number;
  /** How brightly its four gonads glow. */
  gonads?: number;
}

// Bell shapes: a sea nettle's full dome, a crystal jelly's taller bell, and a moon jelly's saucer
// tipped to show its four glowing gonads, with a short fringe of tentacles.
const MOON = { height: 0.5, tip: 1.0, gonads: 4, tentacles: 1.1, arms: 1.1 };
const CRYSTAL = { height: 1.15, tentacles: 3.8, arms: 1.5 };

// The showpiece trio bob in place where the menu leaves room (above the title, above and
// beside the dancers); the rest drift up through the open water at a distance, in lanes clear
// of the title and buttons.
const JELLIES: readonly JellySpec[] = [
  { frame: [0.61, 0.2], distance: 13, radius: 1.35, hue: 0.4, lean: 0.12, roam: 0.3, tentacles: 3.6 },
  { frame: [0.88, 0.16], distance: 17, radius: 1.0, hue: 0.02, lean: -0.2, roam: 0.35, ...CRYSTAL },
  { frame: [0.25, 0.13], distance: 19, radius: 1.0, hue: 0.7, lean: 0.2, roam: 0.4, ...MOON },
  { frame: [0.48, 0.5], distance: 30, radius: 0.9, hue: 0.9, rise: 0.14, lean: 0.08, roam: 0.4 },
  { frame: [0.97, 0.5], distance: 23, radius: 0.95, hue: 0.36, rise: 0.11, lean: -0.1 },
  { frame: [0.02, 0.5], distance: 27, radius: 0.9, hue: 0.05, rise: 0.13, lean: 0.12, roam: 0.25, ...MOON },
  { frame: [0.74, 0.5], distance: 32, radius: 0.9, hue: 0.62, rise: 0.12, lean: -0.06, ...CRYSTAL },
  { frame: [0.15, 0.5], distance: 44, radius: 1.1, hue: 0.3, rise: 0.2, lean: 0.1 },
  { frame: [0.33, 0.5], distance: 52, radius: 1.3, hue: 0.0, rise: 0.22, lean: -0.08, ...MOON },
  { frame: [0.57, 0.5], distance: 47, radius: 1.0, hue: 0.75, rise: 0.18, lean: 0.14 },
  { frame: [0.66, 0.5], distance: 58, radius: 1.3, hue: 0.45, rise: 0.24, lean: -0.12, ...CRYSTAL },
  { frame: [0.78, 0.5], distance: 42, radius: 0.9, hue: 0.12, rise: 0.17, lean: 0.06 },
  { frame: [0.92, 0.5], distance: 55, radius: 1.3, hue: 0.85, rise: 0.21, lean: -0.1, ...MOON },
  { frame: [0.42, 0.5], distance: 62, radius: 1.3, hue: 0.55, rise: 0.25, lean: 0.05 },
];

/** Per-instance data for every jelly, farthest first so they blend back to front. */
export interface JellyData {
  count: number;
  /** aJ0..aJ3 (see shaders.ts jellyMotionGLSL), 4 floats a jelly each. */
  j0: Float32Array;
  j1: Float32Array;
  j2: Float32Array;
  j3: Float32Array;
  /** Tentacle and oral arm lengths (radii) of each jelly, 2 floats a jelly. */
  lengths: Float32Array;
}

const camera = (aspect: number) => {
  // BackdropCamera keeps the 16:9 horizontal view, so 4:3 sees more above and below.
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(CAMERA.fov) / 2) * Math.max(1, ASPECT / aspect)));
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 500);
  cam.position.set(...CAMERA.position);
  cam.lookAt(...CAMERA.target);
  cam.updateMatrixWorld();
  return cam;
};

// The point `distance` from the camera through frame point (x, y).
function along(cam: THREE.PerspectiveCamera, x: number, y: number, distance: number): THREE.Vector3 {
  const dir = new THREE.Vector3(x * 2 - 1, 1 - y * 2, 0.5).unproject(cam).sub(cam.position).normalize();
  return cam.position.clone().addScaledVector(dir, distance);
}

// The heights the frame's top and bottom edges reach at depth z, through frame column x.
function visibleY(cam: THREE.PerspectiveCamera, x: number, z: number): [bottom: number, top: number] {
  const edge = (ndcY: number) => {
    const dir = new THREE.Vector3(x * 2 - 1, ndcY, 0.5).unproject(cam).sub(cam.position);
    return cam.position.y + (dir.y * (z - cam.position.z)) / dir.z;
  };
  return [edge(-1), edge(1)];
}

export function makeJellies(): JellyData {
  const rand = makeRandom(2718);
  const wide = camera(ASPECT);
  const tall = camera(4 / 3);
  const rows = JELLIES.map((spec) => {
    const p = along(wide, spec.frame[0], spec.frame[1], spec.distance);
    const r = spec.radius;
    const length = spec.tentacles ?? 3.6;
    const rise = spec.rise ?? 0;
    const seed = rand.next();
    let bottom = 0;
    let span = 0;
    if (rise > 0) {
      // Out of sight in 4:3 (the taller view) at either end: bell below the bottom edge, tentacle
      // tips above the top, with room for its bob, wander and the camera's drift.
      const [low, high] = visibleY(tall, spec.frame[0], p.z);
      bottom = low - r * 1.6 - 1.5;
      span = high + r * (length + 1.2) + 1.5 - bottom;
      p.y = bottom + rand.range(0.1, 0.9) * span;
    }
    return {
      distance: p.distanceTo(wide.position),
      j0: [p.x, p.y, p.z, seed],
      j1: [r, spec.hue, rise, rand.range(3.6, 4.8)],
      j2: [bottom, span, spec.lean ?? 0, spec.roam ?? 0.6],
      j3: [spec.height ?? 1, spec.tip ?? 0.2, spec.gonads ?? 1, 0],
      lengths: [length, spec.arms ?? length * 0.6],
    };
  });
  rows.sort((a, b) => b.distance - a.distance);
  return {
    count: rows.length,
    j0: new Float32Array(rows.flatMap((row) => row.j0)),
    j1: new Float32Array(rows.flatMap((row) => row.j1)),
    j2: new Float32Array(rows.flatMap((row) => row.j2)),
    j3: new Float32Array(rows.flatMap((row) => row.j3)),
    lengths: new Float32Array(rows.flatMap((row) => row.lengths)),
  };
}

/** Drifting motes and sparkles: the volume they fill and wrap round in. */
export const SNOW_BOX = { center: [0, 3, -10] as Vec3, size: [44, 30, 44] as Vec3 };
