import * as THREE from 'three';
import type { PaddleTarget } from '../../shared/rally.ts';

// The six-axis arm's kinematics, in its station frame (metres, radians): plain maths, so it can be
// checked outside the browser. Seven axes: a floor track carrying the arm across the station
// (along Z), then a classic articulated arm: J1 turret about +Y, J2 shoulder and J3 elbow about
// the turret's horizontal axis, J4 forearm roll, J5 wrist bend and J6 flange roll meeting at the
// wrist centre (a spherical wrist), so the wrist centre fixes J1–J3 and the paddle's
// orientation then fixes J4–J6.
//
// The paddle is held "penhold": its handle in a gripper, the blade hanging below the flange. The
// gripper sits on a wedge adapter that tilts the handle WEDGE off the J6 axis, so a face tilted
// up the usual amount for a stroke has the tool axis straight down: across every stroke the wrist
// centre stays above and a little behind the blade, clear of the table, and the wrist stays well
// bent (it is singular when straight).

/** The arm's dimensions. */
export const DIM = {
  /** The track's axis (J1's x) and the carriage's top (the arm's mounting face). */
  trackX: -1.62,
  mountY: 0.5,
  /** How far the carriage may travel either way along Z. */
  travel: 0.62,
  /** J2 from J1: forward and up from the mounting face. */
  a1: 0.18,
  h1: 0.6,
  /** J2 to J3. */
  a2: 0.85,
  /** J3 to the forearm's roll axis (up), and along it to the wrist centre. */
  a3: 0.13,
  d4: 0.9,
  /** The wrist centre to the flange face. */
  d6: 0.11,
  /** The wedge adapter's thickness on the J6 axis, and its tilt. */
  wedge: 0.03,
  wedgeTilt: THREE.MathUtils.degToRad(28),
  /** From the wedge's face to the paddle's hitting centre, along the handle (gripper plus handle). */
  grip: 0.27,
};

export interface Pose {
  /** Carriage position along Z. */
  track: number;
  /** J1..J6. */
  q: [number, number, number, number, number, number];
}

export const makePose = (): Pose => ({ track: 0, q: [0, 0, 0, 0, 0, 0] });

/**
 * The paddle's frame in the flange frame. The flange frame: +X the tool axis (out of the flange),
 * +Y towards the red face, +Z along the blade's width. The paddle's tip (+Y) leans WEDGE off the
 * tool axis towards the red face, and its hitting centre sits `grip` along it past the wedge.
 */
export function paddleInFlange(out = new THREE.Matrix4()): THREE.Matrix4 {
  const c = Math.cos(DIM.wedgeTilt);
  const s = Math.sin(DIM.wedgeTilt);
  const tip = new THREE.Vector3(c, s, 0);
  const red = new THREE.Vector3(-s, c, 0);
  out.makeBasis(new THREE.Vector3(0, 0, 1), tip, red);
  out.setPosition(DIM.wedge + tip.x * DIM.grip, tip.y * DIM.grip, 0);
  return out;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _a = new THREE.Vector3();
const _x = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _rp = new THREE.Matrix4();
const _rf = new THREE.Matrix4();
const _r3 = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
let _pif: THREE.Matrix4 | null = null;
let _fip: THREE.Matrix4 | null = null;
let _tilt = NaN;

function tool() {
  if (!_pif || !_fip || _tilt !== DIM.wedgeTilt + DIM.grip + DIM.wedge) {
    _pif = paddleInFlange();
    _fip = _pif.clone().invert();
    _tilt = DIM.wedgeTilt + DIM.grip + DIM.wedge;
  }
  return { pif: _pif, fip: _fip };
}

/** The blade's tip direction for a face normal: in the face's plane, as near straight down as it goes. */
export function tipAxis(normal: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(DOWN).addScaledVector(normal, normal.y);
  // A face flat up or down has no "down" in it: hang the tip back towards the arm instead.
  if (out.lengthSq() < 1e-8) out.set(-1, 0, 0).addScaledVector(normal, normal.x);
  return out.normalize();
}

/**
 * The forearm frame's rotation in the station frame, after the track, J1, J2 and J3: +X along
 * the forearm (towards the wrist), +Y up off it, +Z along the J2/J3 axes.
 */
function forearmRotation(q1: number, q2: number, q3: number, out: THREE.Matrix4): THREE.Matrix4 {
  return out.makeRotationY(q1).multiply(_m.makeRotationZ(-(q2 + q3)));
}

/**
 * Solves the arm for a paddle target, given the carriage's place on the track. `prev` (the last
 * solution) keeps J4 and J6 on the same turn.
 */
export function solve(target: PaddleTarget, track: number, out: Pose, prev?: Pose): Pose {
  const { a1, h1, a2, a3, d4, d6, trackX, mountY } = DIM;
  const { fip } = tool();
  // Red face forward: it meets whichever of ±normal points towards the net.
  _n.copy(target.normal);
  if (_n.x < 0) _n.negate();
  const tip = tipAxis(_n, _a);
  // The paddle's whole frame, then the flange's, then the wrist centre behind the flange.
  _x.crossVectors(tip, _n);
  _rp.makeBasis(_x, tip, _n).setPosition(target.position);
  _rf.multiplyMatrices(_rp, fip);
  const e = _rf.elements;
  const w = _w.set(e[12] - e[0] * d6, e[13] - e[1] * d6, e[14] - e[2] * d6);
  // J1 turns the arm's plane through the wrist centre.
  const dx = w.x - trackX;
  const dz = w.z - track;
  const q1 = Math.atan2(-dz, dx);
  const r = Math.hypot(dx, dz) - a1;
  const h = w.y - mountY - h1;
  // J2 and J3: two links in the plane, the elbow up.
  const l3 = Math.hypot(d4, a3);
  const delta = Math.atan2(a3, d4);
  const dist = Math.min(Math.hypot(r, h), a2 + l3 - 1e-6);
  const gamma = Math.atan2(r, h);
  const alpha = Math.acos(THREE.MathUtils.clamp((a2 * a2 + dist * dist - l3 * l3) / (2 * a2 * dist), -1, 1));
  const q2 = gamma - alpha;
  const er = a2 * Math.sin(q2);
  const eh = a2 * Math.cos(q2);
  const psi = delta - Math.atan2(h - eh, r - er);
  const q3 = psi - q2;
  // The wrist: the flange's rotation relative to the forearm, as roll (J4), bend (J5), roll (J6).
  forearmRotation(q1, q2, q3, _r3);
  _rf.setPosition(0, 0, 0);
  _rel.copy(_r3).transpose().multiply(_rf);
  const k = _rel.elements;
  // Column-major: R(row, col) = k[col * 4 + row]. R = Rx(q4) Rz(q5) Rx(q6), the wrist bent down
  // (q5 < 0): the first column is (cos q5, sin q5 cos q4, sin q5 sin q4).
  const q5 = -Math.acos(THREE.MathUtils.clamp(k[0], -1, 1));
  let q4 = Math.atan2(-k[2], -k[1]);
  let q6 = Math.atan2(-k[8], k[4]);
  if (prev) {
    q4 = nearest(q4, prev.q[3]);
    q6 = nearest(q6, prev.q[5]);
  }
  out.track = track;
  out.q[0] = q1;
  out.q[1] = q2;
  out.q[2] = q3;
  out.q[3] = q4;
  out.q[4] = q5;
  out.q[5] = q6;
  return out;
}

/** `angle` moved by whole turns to lie nearest `ref`. */
function nearest(angle: number, ref: number): number {
  return angle + Math.round((ref - angle) / (Math.PI * 2)) * Math.PI * 2;
}

export interface JointPoints {
  j2: THREE.Vector3;
  j3: THREE.Vector3;
  wrist: THREE.Vector3;
  flange: THREE.Vector3;
}

/** Forward kinematics, for checking: the paddle frame (station frame) for a pose, and the joints' places. */
export function forward(pose: Pose, out: THREE.Matrix4, points?: JointPoints): THREE.Matrix4 {
  const { a1, h1, a2, a3, d4, d6, trackX, mountY } = DIM;
  const [q1, q2, q3, q4, q5, q6] = pose.q;
  const t = new THREE.Matrix4();
  const m = new THREE.Matrix4().makeTranslation(trackX, mountY, pose.track).multiply(t.makeRotationY(q1));
  m.multiply(t.makeTranslation(a1, h1, 0));
  points?.j2.setFromMatrixPosition(m);
  m.multiply(t.makeRotationZ(-q2)).multiply(t.makeTranslation(0, a2, 0));
  points?.j3.setFromMatrixPosition(m);
  m.multiply(t.makeRotationZ(-q3)).multiply(t.makeTranslation(d4, a3, 0));
  points?.wrist.setFromMatrixPosition(m);
  m.multiply(t.makeRotationX(q4)).multiply(t.makeRotationZ(q5)).multiply(t.makeRotationX(q6));
  m.multiply(t.makeTranslation(d6, 0, 0));
  points?.flange.setFromMatrixPosition(m);
  m.multiply(tool().pif);
  return out.copy(m);
}
