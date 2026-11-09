import * as THREE from 'three';
import { extrude, lathe, loft, place } from '../../shared/geometry.ts';
import type { Vec3 } from '../../../stages/catalog.ts';
import { PADDLE } from '../../layout.ts';
import { cylinderDecal, decal } from './decals.ts';
import { DIM } from './kinematics.ts';
import { Parts, bolts, box, greaseNipple, latheX, latheZ, loftX, motor, puck, toNegX, toX, toZ } from './kit.ts';

// The arm's moving links, each in its own joint frame (kinematics.ts): the J1 turret, the J2
// upper arm, the J3 elbow housing with the wrist motors at its back, the J4 forearm tube ending
// in the wrist's fork, the J5 wrist, and the J6 flange with its wedge adapter and gripper. Cast
// housings are lofted (drafted, filleted sections), reducers and covers turned, with bolt
// circles, grease points and axis labels.

/** The balancer's plane (J1 frame z), its pivot on the turret, and its pin on the upper arm. */
export const BALANCER = {
  z: -0.372,
  pivot: [DIM.a1 - 0.4, DIM.h1 + 0.04] as const,
  /** Along the upper arm from J2. */
  pin: 0.19,
} as const;

/** The upper arm's slab: its centre plane and depth (J2 frame z). */
const UA_Z = -0.235;
const UA_D = 0.15;

/** z-sorted profile for latheZ between two z's (either order). */
function drum(radius: number, z0: number, z1: number, chamfer = 0.006): [number, number][] {
  const a = Math.min(z0, z1);
  const b = Math.max(z0, z1);
  const c = Math.min(chamfer, (b - a) / 3);
  return [[0, a], [radius - c, a], [radius, a + c], [radius, b - c], [radius - c, b], [0, b]];
}

/** A ring clamp round a conduit running along `axis` at `at`, on a post down `post` metres. */
function clamp(p: Parts, at: Vec3, axis: 'x' | 'y', radius: number, post: Vec3) {
  const ring = new THREE.TorusGeometry(radius + 0.005, 0.0055, 8, 20);
  if (axis === 'x') ring.rotateY(Math.PI / 2);
  else ring.rotateX(Math.PI / 2);
  p.add('black', ring, { position: at });
  const mid: Vec3 = [(at[0] + post[0]) / 2, (at[1] + post[1]) / 2, (at[2] + post[2]) / 2];
  const len = Math.hypot(at[0] - post[0], at[1] - post[1], at[2] - post[2]);
  const dir = new THREE.Vector3(at[0] - post[0], at[1] - post[1], at[2] - post[2]).normalize();
  const g = box(0.022, len, 0.03, 0.004, [0, 0, 0]);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  p.add('black', g, { position: mid });
  p.add('oxide', puck(0.005, 0.008, 0.001, 6), { position: [at[0] + dir.x * (radius + 0.012), at[1] + dir.y * (radius + 0.012), at[2] + dir.z * (radius + 0.012)] });
}

/** The J1 turret, in the J1 frame: the mounting face at y = 0, J2 at (a1, h1). */
export function turretParts(): Parts {
  const p = new Parts();
  const { a1, h1 } = DIM;
  // The drum on the J1 bearing.
  p.add('orange', lathe([[0, 0.255], [0.236, 0.255], [0.246, 0.262], [0.25, 0.272], [0.25, 0.334], [0.246, 0.349], [0.234, 0.36], [0, 0.36]], 64));
  // The shoulder: a drafted tower rising forward into the J2 bearing housing.
  p.add('orange', loft([
    { y: 0.355, w: 0.38, d: 0.31, r: 0.12, x: 0.05 },
    { y: 0.45, w: 0.352, d: 0.302, r: 0.12, x: 0.112 },
    { y: 0.54, w: 0.332, d: 0.3, r: 0.13, x: 0.16 },
    { y: h1, w: 0.322, d: 0.3, r: 0.14, x: a1 },
  ], 8));
  p.add('orange', latheZ(drum(0.166, -0.158, 0.158, 0.01), 64), { position: [a1, h1, 0] });
  // The J2 reducer's ring and motor on the right, its cover on the left under the upper arm.
  p.add('alu', latheZ(drum(0.136, 0.156, 0.172, 0.002), 48), { position: [a1, h1, 0] });
  p.add('oxide', bolts(12, 0.122, 0.011, { axis: 'z', position: [a1, h1, 0.172] }));
  p.include(motor({ size: 0.15, length: 0.25, box: Math.PI / 2 }), { position: [a1, h1, 0.172], rotation: toZ });
  // A cast boss behind for the J1 motor, which stands on it.
  const mx = -0.15;
  const mz = 0.165;
  p.add('orange', lathe([[0.074, 0.268], [0.074, 0.352], [0.07, 0.362], [0, 0.362]], 32), { position: [mx, 0, mz] });
  p.include(motor({ size: 0.098, length: 0.2, box: Math.PI }), { position: [mx, 0.362, mz] });
  // The balancer's ear: a cast arm up from the drum's back left to a clevis.
  const [ax, ay] = BALANCER.pivot;
  const bz = BALANCER.z;
  p.add('orange', loft([
    { y: 0.355, w: 0.13, d: 0.11, r: 0.04, x: -0.09, z: -0.16 },
    { y: 0.48, w: 0.105, d: 0.075, r: 0.032, x: -0.15, z: -0.255 },
    { y: ay - 0.01, w: 0.09, d: 0.05, r: 0.024, x: ax, z: bz + 0.045 },
  ], 6));
  p.add('orange', latheZ(drum(0.045, bz + 0.022, bz + 0.07, 0.004), 32), { position: [ax, ay, 0] });
  p.add('orange', latheZ(drum(0.045, bz - 0.036, bz - 0.022, 0.003), 32), { position: [ax, ay, 0] });
  p.add('orange', box(0.03, 0.06, 0.06, 0.008, [ax - 0.05, ay, bz + 0.004]));
  p.add('steel', latheZ(drum(0.014, bz - 0.044, bz + 0.076, 0.002), 16), { position: [ax, ay, 0] });
  p.add('oxide', place(new THREE.CylinderGeometry(0.019, 0.019, 0.01, 6), { rotation: toZ, position: [ax, ay, bz - 0.044] }));
  // The dress pack leaves through a gland in the shoulder's back.
  p.add('black', latheX([[0.0, -0.03], [0.028, -0.03], [0.028, -0.012], [0.024, -0.008], [0.024, 0.0], [0, 0]], 24), { position: [0.012, 0.565, -0.075] });
  // Labels: the J1 tag round the drum, the model on the shoulder's side, a crush warning.
  p.add('decal', cylinderDecal('axisJ1', 0.2508, 0.105, 'around', { position: [0, 0.304, 0], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', cylinderDecal('crush', 0.2508, 0.055, 'around', { position: [0, 0.303, 0], rotation: [0, Math.PI / 2 + 0.55, 0] }));
  p.add('decal', decal('model', 0.12, { position: [0.085, 0.405, 0.1532] }));
  return p;
}

/** The J2 upper arm, in the J2 frame: J2 at the origin, J3 at (0, a2), the link at z = UA_Z. */
export function upperArmParts(): Parts {
  const p = new Parts();
  const { a2 } = DIM;
  const zc = UA_Z;
  const outer = zc - UA_D / 2;
  p.add('orange', latheZ(drum(0.172, outer, zc + UA_D / 2, 0.012), 64));
  p.add('orange', latheZ(drum(0.132, outer + 0.004, zc + UA_D / 2 - 0.004, 0.01), 56), { position: [0, a2, 0] });
  p.add('orange', loft([
    { y: 0.0, w: 0.3, d: UA_D, r: 0.05, z: zc },
    { y: 0.16, w: 0.256, d: UA_D - 0.004, r: 0.05, z: zc },
    { y: 0.42, w: 0.19, d: UA_D - 0.01, r: 0.05, z: zc },
    { y: 0.68, w: 0.2, d: UA_D - 0.014, r: 0.05, z: zc },
    { y: a2, w: 0.226, d: UA_D - 0.012, r: 0.05, z: zc },
  ], 8));
  // A raised rib round the outer face, as cast.
  p.add('orange', loft([
    { y: 0.13, w: 0.2, d: 0.01, r: 0.004, z: outer + 0.003 },
    { y: 0.42, w: 0.135, d: 0.01, r: 0.004, z: outer + 0.002 },
    { y: 0.7, w: 0.145, d: 0.01, r: 0.004, z: outer + 0.002 },
  ], 2));
  // The J2 reducer cover, bolted, with its grease point; the balancer's pin boss above it.
  p.add('orange', latheZ(drum(0.13, outer - 0.014, outer, 0.004), 56));
  p.add('oxide', bolts(10, 0.113, 0.012, { axis: '-z', position: [0, 0, outer - 0.014] }, 0.3));
  p.add('alu', latheZ(drum(0.04, outer - 0.02, outer - 0.012, 0.002), 32));
  p.add('brass', greaseNipple(0.013), { position: [0.07, 0.05, outer - 0.014], rotation: [-Math.PI / 2, 0, 0] });
  p.add('decal', decal('axisJ2', 0.08, { position: [0, -0.073, outer - 0.0142], rotation: [0, Math.PI, 0] }));
  const pinY = BALANCER.pin;
  const bz = BALANCER.z;
  p.add('orange', latheZ(drum(0.038, bz + 0.024, outer, 0.004), 32), { position: [0, pinY, 0] });
  p.add('steel', latheZ(drum(0.012, bz - 0.03, bz + 0.03, 0.002), 16), { position: [0, pinY, 0] });
  p.add('oxide', latheZ(drum(0.018, bz - 0.036, bz - 0.026, 0.002), 6), { position: [0, pinY, 0] });
  // The J3 end's outer cover.
  p.add('orange', latheZ(drum(0.1, outer - 0.006, outer + 0.004, 0.003), 48), { position: [0, a2, 0] });
  p.add('oxide', bolts(8, 0.086, 0.011, { axis: '-z', position: [0, a2, outer - 0.006] }));
  p.add('brass', greaseNipple(0.012), { position: [-0.05, a2 + 0.03, outer - 0.006], rotation: [-Math.PI / 2, 0, 0] });
  // Labels along the outer face: the maker's mark, read upwards, and a crush warning.
  p.add('decal', decal('logoBlack', 0.34, { position: [0, 0.43, outer - 0.0035], rotation: [0, Math.PI, Math.PI / 2] }));
  p.add('decal', decal('crush', 0.06, { position: [0, 0.655, outer - 0.0035], rotation: [0, Math.PI, 0] }));
  p.add('decal', decal('maxLoad', 0.075, { position: [0.0, 0.56, zc + UA_D / 2 - 0.0063] }));
  // The dress pack up its back: two clamps and the conduit between them.
  const cx = -0.172;
  clamp(p, [cx, 0.3, zc], 'y', 0.018, [-0.108, 0.3, zc]);
  clamp(p, [cx + 0.004, 0.72, zc], 'y', 0.018, [-0.1, 0.72, zc]);
  return p;
}

/** Where the dress pack is anchored on each link (each link's frame), and which way it runs. */
export const DRESS = {
  turret: { at: [-0.02, 0.565, -0.075] as Vec3, dir: [-1, 0.25, 0] as THREE.Vector3Tuple },
  upperLow: { at: [-0.172, 0.262, UA_Z] as Vec3, dir: [0, 1, 0] as THREE.Vector3Tuple },
  upperHigh: { at: [-0.168, 0.758, UA_Z] as Vec3, dir: [0, 1, 0] as THREE.Vector3Tuple },
  housingRear: { at: [-0.1, 0.272, -0.03] as Vec3, dir: [1, 0, 0] as THREE.Vector3Tuple },
  housingFront: { at: [0.145, 0.262, -0.01] as Vec3, dir: [1, -0.05, 0] as THREE.Vector3Tuple },
  tube: { at: [0.47, 0.095, -0.095] as Vec3, dir: [1, 0, 0] as THREE.Vector3Tuple },
  /** Where the conduit ends: into the hose junction on the tube's left side (J4 frame). */
  junctionIn: { at: [0.594, 0, -0.112] as Vec3, dir: [1, 0, 0] as THREE.Vector3Tuple },
  /** The junction's outlets: two air lines and the sensor's cable. */
  junction: [[0.648, 0.013, -0.112], [0.648, -0.013, -0.112], [0.648, 0, -0.124]] as Vec3[],
} as const;

/** The J3 elbow housing, in the J3 frame: the forearm's roll axis along +X at y = a3. */
export function housingParts(): Parts {
  const p = new Parts();
  p.add('orange', latheZ(drum(0.136, -0.158, 0.138, 0.01), 56));
  p.add('orange', loftX([
    { x: -0.34, h: 0.25, d: 0.235, y: 0.12, r: 0.07 },
    { x: -0.2, h: 0.3, d: 0.262, y: 0.095, r: 0.08 },
    { x: -0.05, h: 0.33, d: 0.276, y: 0.06, r: 0.09 },
    { x: 0.08, h: 0.29, d: 0.26, y: 0.09, r: 0.1 },
    { x: 0.18, h: 0.216, d: 0.216, y: 0.13, r: 0.108 },
    { x: 0.2, h: 0.21, d: 0.21, y: 0.13, r: 0.105 },
  ], 8));
  // The J3 motor on the right of the elbow, its reducer ring between.
  p.add('alu', latheZ(drum(0.078, 0.136, 0.15, 0.002), 40));
  p.include(motor({ size: 0.12, length: 0.21, box: Math.PI / 2 }), { position: [0, 0, 0.15], rotation: toZ });
  // The wrist motors at the back: J4 above, J5 and J6 below, driving through the forearm.
  p.include(motor({ size: 0.094, length: 0.2, box: 0 }), { position: [-0.34, 0.19, 0], rotation: toNegX });
  p.include(motor({ size: 0.078, length: 0.17, box: -Math.PI / 2 }), { position: [-0.34, 0.056, 0.064], rotation: toNegX });
  p.include(motor({ size: 0.078, length: 0.17, box: Math.PI / 2 }), { position: [-0.34, 0.056, -0.064], rotation: toNegX });
  // The J4 bearing at the front: a machined face round the roll axis.
  p.add('alu', latheX([[0.098, 0.192], [0.107, 0.192], [0.107, 0.2], [0.098, 0.2]], 48), { position: [0, 0.13, 0] });
  p.add('oxide', bolts(12, 0.1, 0.009, { axis: 'x', position: [0.2, 0.13, 0] }));
  // Labels: the maker's mark both sides, the J3 tag, a hand warning by the motors.
  // (The sides taper towards the back: the decals lean in with them.)
  p.add('decal', decal('logoBlack', 0.2, { position: [-0.205, 0.145, 0.1309], rotation: [0, -0.096, 0] }));
  p.add('decal', decal('axisJ3', 0.072, { position: [-0.205, 0.072, 0.1309], rotation: [0, -0.096, 0] }));
  p.add('decal', decal('logoBlack', 0.2, { position: [-0.205, 0.125, -0.1309], rotation: [0, Math.PI + 0.096, 0] }));
  p.add('decal', decal('hand', 0.05, { position: [-0.3, 0.2, -0.1185], rotation: [0, Math.PI, 0] }));
  p.add('decal', decal('serialTag', 0.08, { position: [0.06, 0.02, -0.1312], rotation: [0, Math.PI, 0] }));
  // The dress pack along the top.
  const r = DRESS.housingRear.at;
  const f = DRESS.housingFront.at;
  clamp(p, r, 'x', 0.018, [r[0], 0.226, r[2]]);
  clamp(p, f, 'x', 0.018, [f[0], 0.232, f[2]]);
  return p;
}

/** The J4 forearm tube, in the J4 frame: along +X from J3's plane, the wrist centre at d4. */
export function tubeParts(): Parts {
  const p = new Parts();
  const { d4 } = DIM;
  p.add('rubber', latheX([[0.102, 0.2], [0.106, 0.203], [0.106, 0.215], [0.102, 0.218]], 48));
  p.add('orange', latheX([[0, 0.212], [0.099, 0.212], [0.101, 0.22], [0.101, 0.25], [0.097, 0.272], [0.09, 0.42], [0.083, 0.6], [0.082, 0.66], [0, 0.66]], 56));
  // The fork: the tube flattens into a yoke whose floor stops just short of the wrist's sweep.
  p.add('orange', loftX([
    { x: 0.62, h: 0.164, d: 0.164, r: 0.082 },
    { x: 0.71, h: 0.14, d: 0.198, r: 0.058 },
    { x: 0.8, h: 0.13, d: 0.204, r: 0.04 },
    { x: 0.818, h: 0.124, d: 0.2, r: 0.036 },
  ], 8));
  for (const s of [-1, 1]) {
    p.add('orange', loftX([
      { x: 0.79, h: 0.13, d: 0.034, z: s * 0.085, r: 0.012 },
      { x: d4, h: 0.128, d: 0.034, z: s * 0.085, r: 0.012 },
    ], 4));
    p.add('orange', latheZ(drum(0.064, s * 0.068, s * 0.102, 0.005), 40), { position: [d4, 0, 0] });
  }
  // A saddle between the prongs, hollowed round the wrist's sweep (its nose's corners reach
  // 75 mm from J5), so there's no slot to see through behind the wrist.
  const saddle = new THREE.Shape();
  const sr = 0.078;
  const sy = 0.061;
  saddle.moveTo(0.8, -sy);
  saddle.lineTo(d4 - Math.sqrt(sr * sr - sy * sy), -sy);
  saddle.absarc(d4, 0, sr, Math.PI + Math.asin(sy / sr), Math.PI - Math.asin(sy / sr), true);
  saddle.lineTo(0.8, sy);
  saddle.closePath();
  p.add('orange', extrude(saddle, 0.138, 0, 16));
  // The J5 drive's cover on the right prong.
  p.add('orange', latheZ(drum(0.05, 0.1, 0.11, 0.003), 40), { position: [d4, 0, 0] });
  p.add('oxide', bolts(6, 0.04, 0.009, { axis: 'z', position: [d4, 0, 0.11] }));
  p.add('alu', latheZ(drum(0.016, 0.11, 0.114, 0.001), 24), { position: [d4, 0, 0] });
  // Labels: J4 along the tube, J5 on the prong.
  // J4's tag on the tube's taper, read along it (the decal's axis turned to X, its face to +Z).
  const j4 = cylinderDecal('axisJ4', 0.0957, 0.074, 'axis', {}, 0.0922);
  j4.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)));
  p.add('decal', j4, { position: [0.345, 0, 0] });
  p.add('decal', decal('axisJ5', 0.06, { position: [0.81, 0.0, 0.1023] }));
  // The dress pack: a swivel clamp, the last of the conduit, the hose junction.
  p.add('black', latheX([[0.089, 0.457], [0.096, 0.46], [0.096, 0.486], [0.089, 0.489]], 40));
  const t = DRESS.tube.at;
  clamp(p, t, 'x', 0.018, [t[0], t[1] * 0.68, t[2] * 0.68]);
  // The hose junction, banded to the tube's left side by the fork.
  p.add('black', latheX([[0.084, 0.6], [0.088, 0.602], [0.088, 0.618], [0.084, 0.62]], 40));
  p.add('black', box(0.05, 0.048, 0.034, 0.006, [0.618, 0, -0.112]));
  p.add('black', box(0.03, 0.03, 0.02, 0.004, [0.61, 0, -0.092]));
  for (const j of DRESS.junction) p.add('alu', latheX([[0.0055, -0.004], [0.0055, 0.005], [0.0042, 0.008], [0.0042, 0.012], [0, 0.012]], 10), { position: [j[0] - 0.006, j[1], j[2]] });
  return p;
}

/** The J5 wrist, in the J5 frame: J5 along Z, the J6 axis along +X. */
export function wristParts(): Parts {
  const p = new Parts();
  p.add('orange', latheZ(drum(0.064, -0.066, 0.066, 0.006), 48));
  p.add('orange', loftX([
    { x: 0.0, h: 0.124, d: 0.128, r: 0.05 },
    { x: 0.045, h: 0.114, d: 0.116, r: 0.054 },
    { x: 0.078, h: 0.104, d: 0.104, r: 0.052 },
  ], 8));
  p.add('alu', latheX([[0, 0.077], [0.049, 0.077], [0.0505, 0.08], [0.0505, 0.09], [0, 0.09]], 48));
  // The J6 tag on the nose's +Y side, read along the tool axis: the decal's axis (Y) turned to
  // X and its face (+Z) to +Y.
  const tag = cylinderDecal('axisJ6', 0.0585, 0.052, 'axis');
  tag.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
  p.add('decal', tag, { position: [0.04, 0, 0] });
  return p;
}

/** A disc along +X from x0 whose far face is cut by the plane through (cx, 0, 0) square to `normal` (in XY). */
function wedge(radius: number, x0: number, cx: number, tilt: number, segments = 40): THREE.BufferGeometry {
  const tan = Math.tan(tilt);
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const y = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    positions.push(x0, y, z, cx - y * tan, y, z);
    normals.push(0, Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a));
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // The cut face: a fan round its centre.
  const base = positions.length / 3;
  const n = new THREE.Vector3(Math.cos(tilt), Math.sin(tilt), 0);
  positions.push(cx, 0, 0);
  normals.push(n.x, n.y, n.z);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const y = Math.cos(a) * radius;
    positions.push(cx - y * tan, y, Math.sin(a) * radius);
    normals.push(n.x, n.y, n.z);
  }
  for (let i = 0; i < segments; i++) index.push(base, base + 1 + i + 1, base + 1 + i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(index);
  return g;
}

/** The J6 flange and the wedge adapter on it, in the J6 frame (the flange face at d6). */
export function flangeParts(): Parts {
  const p = new Parts();
  const { d6, wedge: w, wedgeTilt } = DIM;
  p.add('alu', latheX([[0, 0.088], [0.05, 0.088], [0.05, d6 - 0.002], [0.048, d6], [0, d6]], 48));
  p.add('oxide', latheX([[0, d6], [0.05, d6], [0.05, d6 + 0.007], [0.048, d6 + 0.009], [0, d6 + 0.009]], 48));
  p.add('oxide', wedge(0.037, d6 + 0.008, d6 + w, wedgeTilt, 40));
  p.add('oxide', bolts(6, 0.0435, 0.0085, { axis: 'x', position: [d6 + 0.009, 0, 0] }, Math.PI / 6));
  p.add('steel', puck(0.004, 0.006, 0.001, 8), { position: [d6 + 0.011, 0.0, 0.043], rotation: toX });
  return p;
}

/** The handle's width at `y` (the paddle's frame), from the paddle's own handle profile. */
function handleHalfWidth(y: number): number {
  const ys = [PADDLE.handleTop, -0.0756, -0.113, -0.1524, -0.1682, PADDLE.handleEnd];
  const ws = [0.82, 0.86, 0.92, 1, 1.02, 0.9];
  for (let i = 0; i < ys.length - 1; i++) {
    if (y <= ys[i] && y >= ys[i + 1]) {
      const s = (y - ys[i]) / (ys[i + 1] - ys[i]);
      return (PADDLE.handleWidth * (ws[i] + (ws[i + 1] - ws[i]) * s)) / 2;
    }
  }
  return PADDLE.handleWidth / 2;
}

/** Where the gripper's air and sensor lines plug in (the paddle's frame), and which way they go in. */
export const GRIPPER_PORTS = {
  air: [[-0.064, -0.236, -0.012], [-0.064, -0.236, 0.012]] as Vec3[],
  sensor: [-0.07, -0.2, 0.017] as Vec3,
};

/**
 * A pneumatic parallel gripper holding the paddle by its handle, in the paddle's frame (the
 * hitting centre at the origin, the handle down -Y): an adapter on the wedge, the body, its jaw
 * guide, two jaws and fingers with rubber pads shaped to the handle, air fittings and a sensor.
 */
export function gripperParts(): Parts {
  const p = new Parts();
  const base = -DIM.grip;
  p.add('alu', box(0.112, 0.012, 0.07, 0.004, [0, base + 0.006, 0]));
  p.add('oxide', box(0.1, 0.07, 0.058, 0.006, [0, base + 0.047, 0]));
  p.add('alu', box(0.104, 0.008, 0.062, 0.003, [0, base + 0.016, 0]));
  p.add('steel', box(0.104, 0.008, 0.022, 0.002, [0, -0.186, 0]));
  for (const s of [-1, 1]) {
    // A jaw, and a finger rising from it along the handle with a pad on its inside.
    p.add('steel', box(0.03, 0.016, 0.036, 0.003, [s * 0.031, -0.176, 0]));
    const ys = [-0.172, -0.164, -0.15, -0.13, -0.11, -0.09, -0.078];
    p.add('alu', loft(ys.map((y, i) => ({ y, w: 0.01, d: i === ys.length - 1 ? 0.018 : 0.028, r: 0.003, x: s * (handleHalfWidth(y) + 0.0085) })), 2));
    p.add('rubber', loft(ys.slice(0, -1).map((y) => ({ y, w: 0.0034, d: 0.024, r: 0.0012, x: s * (handleHalfWidth(y) + 0.0017) })), 1));
    for (const y of [-0.172, -0.16]) p.add('oxide', puck(0.0035, 0.004, 0.0008, 8), { position: [s * 0.046, y - 0.004, 0.009], rotation: [0, 0, s * Math.PI / 2] });
    // Body screws on the faces.
    for (const z of [-1, 1]) p.add('oxide', puck(0.0035, 0.003, 0.0006, 8), { position: [s * 0.036, base + 0.05, z * 0.0295], rotation: [z * Math.PI / 2, 0, 0] });
  }
  // Push-in fittings for the two air lines on the left (-X) end.
  for (const [, y, z] of GRIPPER_PORTS.air) {
    p.add('alu', puck(0.0055, 0.008, 0.001, 10), { position: [-0.054, y, z], rotation: [0, 0, Math.PI / 2] });
    p.add('blue', puck(0.0064, 0.008, 0.0015, 10), { position: [-0.061, y, z], rotation: [0, 0, Math.PI / 2] });
  }
  // The jaw sensor in its slot on the front, its cable out of the left end.
  p.add('steel', latheX([[0, 0], [0.004, 0], [0.004, 0.024], [0.003, 0.028], [0, 0.028]], 10), { position: [-0.07, -0.2, 0.017] });
  p.add('greenLed', puck(0.0016, 0.004, 0.0004, 6), { position: [-0.03, -0.1955, 0.017] });
  // The label, upright as it hangs.
  p.add('decal', decal('gripper', 0.062, { position: [0, base + 0.048, 0.0294], rotation: [0, 0, Math.PI] }));
  return p;
}

/** The gripper's lines arrive at its ports travelling along +X (paddle frame). */
export const HOSE_DIR: THREE.Vector3Tuple = [1, 0, 0];

/** The balancer's cylinder, in its own frame: its eye on the pivot, +Y towards the pin. */
export function balancerBodyParts(): Parts {
  const p = new Parts();
  p.add('graphite', latheZ(drum(0.03, -0.018, 0.018, 0.003), 28));
  p.add('graphite', box(0.034, 0.04, 0.03, 0.006, [0, 0.03, 0]));
  p.add('alu', lathe([[0, 0.04], [0.046, 0.04], [0.048, 0.044], [0.048, 0.062], [0.044, 0.066], [0, 0.066]], 32));
  p.add('black', lathe([[0, 0.064], [0.042, 0.064], [0.042, 0.272], [0, 0.272]], 32));
  p.add('alu', lathe([[0, 0.27], [0.046, 0.27], [0.048, 0.274], [0.048, 0.292], [0.042, 0.297], [0.026, 0.3], [0.022, 0.31], [0, 0.31]], 32));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    p.add('oxide', puck(0.004, 0.006, 0.001, 8), { position: [Math.cos(a) * 0.04, 0.298, Math.sin(a) * 0.04] });
  }
  p.add('decal', cylinderDecal('hand', 0.0425, 0.05, 'around', { position: [0, 0.2, 0], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', cylinderDecal('hand', 0.0425, 0.05, 'around', { position: [0, 0.2, 0], rotation: [0, -Math.PI / 2, 0] }));
  return p;
}

/** The balancer's rod, in its own frame: its eye on the arm's pin, +Y towards the pivot. */
export function balancerRodParts(): Parts {
  const p = new Parts();
  p.add('steel', latheZ(drum(0.026, -0.016, 0.016, 0.003), 24));
  p.add('steel', lathe([[0, 0.02], [0.018, 0.02], [0.018, 0.04], [0, 0.04]], 20));
  p.add('chrome', lathe([[0, 0.038], [0.0165, 0.038], [0.0165, 0.34], [0, 0.34]], 28));
  return p;
}

