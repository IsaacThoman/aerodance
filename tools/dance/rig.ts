// The dance rig: the 13 body points and 4 angles a dancer is animated with (format.ts), and
// the MediaPipe pose-33 landmarks the game plays and scores, derived from them.
//
// The points are the joints the scorer compares (shoulders, elbows, wrists, hips, knees,
// ankles) plus the head, all in the frame's image space. Everything else follows: the face from
// the head point and angles, the hand knuckles from the forearm, the heel and toes from the
// ankle and the body's turn. Lengths are measured in "metric" frame-height units, x scaled by
// the frame's aspect, so a limb has the same length whichever way it points.
import type { Landmark } from '../../packages/pose/choreography.ts';
import { POINTS, defaultBody, round } from './format.ts';
import type { Body, MidJoint, PointControl } from './format.ts';

export type Vec3 = [number, number, number];
/** Every control's value at one instant: points in the frame (z resolved), angles in degrees. */
export interface RigPose {
  points: Record<PointControl, Vec3>;
  turn: number; headYaw: number; headPitch: number; headRoll: number;
}

/** MediaPipe pose-33 indices. */
export const LM = {
  nose: 0, leftEyeInner: 1, leftEye: 2, leftEyeOuter: 3, rightEyeInner: 4, rightEye: 5, rightEyeOuter: 6,
  leftEar: 7, rightEar: 8, mouthLeft: 9, mouthRight: 10, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftPinky: 17, rightPinky: 18, leftIndex: 19, rightIndex: 20, leftThumb: 21, rightThumb: 22,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28, leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
} as const;
/** The landmarks each point control produces (its derived detail included). */
export const LANDMARKS_OF: Readonly<Record<PointControl, readonly number[]>> = {
  head: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  leftShoulder: [11], rightShoulder: [12], leftElbow: [13], rightElbow: [14],
  leftWrist: [15, 17, 19, 21], rightWrist: [16, 18, 20, 22],
  leftHip: [23], rightHip: [24], leftKnee: [25], rightKnee: [26],
  leftAnkle: [27, 29, 31], rightAnkle: [28, 30, 32],
};
/** The landmark a point control sits on. */
export const LANDMARK_OF: Readonly<Record<Exclude<PointControl, 'head'>, number>> = {
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
};
/** Left/right pairs; the dancer's left is image right in an unmirrored frontal view. */
export const PAIRS: readonly (readonly [PointControl, PointControl])[] = [
  ['leftShoulder', 'rightShoulder'], ['leftElbow', 'rightElbow'], ['leftWrist', 'rightWrist'],
  ['leftHip', 'rightHip'], ['leftKnee', 'rightKnee'], ['leftAnkle', 'rightAnkle'],
];
export const mirrorControl = (c: PointControl): PointControl => {
  for (const [l, r] of PAIRS) { if (c === l) return r; if (c === r) return l; }
  return c;
};
/** +1 for the dancer's left side (image right), -1 for the right, 0 for the head. */
export const sideOf = (c: PointControl) => c.startsWith('left') ? 1 : c.startsWith('right') ? -1 : 0;

const DEG = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const toMetric = (p: readonly number[], aspect: number): Vec3 => [p[0] * aspect, p[1], (p[2] ?? 0) * aspect];
export const fromMetric = (m: readonly number[], aspect: number): Vec3 => [m[0] / aspect, m[1], m[2] / aspect];
const add = (a: readonly number[], b: readonly number[], k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const len2 = (v: readonly number[]) => Math.hypot(v[0], v[1]);
const len3 = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

/** A dancer standing still at `home` (the hip midpoint), arms relaxed, facing the camera. */
export function neutralPose(body: Body, home: readonly [number, number], aspect: number): RigPose {
  const H: Vec3 = [home[0] * aspect, home[1], 0];
  const S = add(H, [0, -body.torso, 0]);
  const points = {} as Record<PointControl, Vec3>;
  const set = (c: PointControl, m: Vec3) => { points[c] = fromMetric(m, aspect); };
  set('head', add(S, [0, -body.neck, 0]));
  for (const side of [1, -1]) {
    const name = side > 0 ? 'left' : 'right';
    // Arms hang a little out from the body, the legs straight down.
    const shoulder = add(S, [side * body.shoulderWidth / 2, 0, 0]);
    const elbow = add(shoulder, [Math.sin(10 * DEG) * side, Math.cos(10 * DEG), 0], body.upperArm);
    const wrist = add(elbow, [Math.sin(6 * DEG) * side, Math.cos(6 * DEG), 0], body.forearm);
    const hip = add(H, [side * body.hipWidth / 2, 0, 0]);
    const knee = add(hip, [Math.sin(2 * DEG) * side, Math.cos(2 * DEG), 0], body.thigh);
    const ankle = add(knee, [0, 1, 0], body.shin);
    const c = (part: string) => `${name}${part}` as PointControl;
    set(c('Shoulder'), shoulder); set(c('Wrist'), wrist); set(c('Hip'), hip); set(c('Ankle'), ankle);
    // Elbows and knees where an unkeyed limb puts them, so a dancer with no keys and the
    // neutral stance agree.
    points[c('Elbow')] = autoLimb(c('Elbow') as MidJoint, points[c('Shoulder')], points[c('Wrist')], body, aspect);
    points[c('Knee')] = autoLimb(c('Knee') as MidJoint, points[c('Hip')], points[c('Ankle')], body, aspect);
  }
  return { points, turn: 0, headYaw: 0, headPitch: 0, headRoll: 0 };
}

/** Depth for points without a keyed z: the shoulders and hips turn with `turn`; limbs follow their shoulder or hip. */
export function turnDepth(control: PointControl, turnDeg: number, body: Body, aspect: number, points: Partial<Record<PointControl, Vec3>>): number {
  const side = sideOf(control), s = Math.sin(turnDeg * DEG);
  switch (control) {
    case 'leftShoulder': case 'rightShoulder': return side * s * body.shoulderWidth / 2 / aspect;
    case 'leftHip': case 'rightHip': return side * s * body.hipWidth / 2 / aspect;
    case 'leftWrist': case 'leftElbow': return points.leftShoulder?.[2] ?? 0;
    case 'rightWrist': case 'rightElbow': return points.rightShoulder?.[2] ?? 0;
    case 'leftAnkle': case 'leftKnee': return points.leftHip?.[2] ?? 0;
    case 'rightAnkle': case 'rightKnee': return points.rightHip?.[2] ?? 0;
    default: return ((points.leftShoulder?.[2] ?? 0) + (points.rightShoulder?.[2] ?? 0)) / 2;
  }
}

// ---- Limbs ----

/**
 * An elbow or knee relative to its limb: the apparent (on-screen) lengths of the two segments,
 * which side of the shoulder-wrist (hip-ankle) line it bends to (+1/-1, 0 on the line), and its
 * depth off that line. Interpolating this instead of the joint's position keeps the limb whole
 * while its ends move, and reproduces the keyed joint exactly at the key.
 */
export interface LimbRel { l1: number; l2: number; side: number; dz: number; }
export function limbRel(start: readonly number[], joint: readonly number[], end: readonly number[], aspect: number): LimbRel {
  const S = toMetric(start, aspect), J = toMetric(joint, aspect), E = toMetric(end, aspect);
  const se = sub(E, S), sj = sub(J, S);
  const d = len2(se), cross = se[0] * sj[1] - se[1] * sj[0];
  const along = d > 1e-9 ? (se[0] * sj[0] + se[1] * sj[1]) / (d * d) : 0;
  return { l1: len2(sj), l2: len2(sub(E, J)), side: Math.abs(cross) < 1e-12 ? 0 : Math.sign(cross),
    dz: J[2] - (S[2] + se[2] * clamp(along, 0, 1)) };
}
/** Places an elbow or knee for a limb from start to end (frame coordinates, z resolved). */
export function limbIK(start: readonly number[], end: readonly number[], rel: LimbRel, aspect: number): Vec3 {
  const S = toMetric(start, aspect), E = toMetric(end, aspect);
  const se = sub(E, S), d = len2(se);
  const l1 = Math.max(0, rel.l1), l2 = Math.max(0, rel.l2);
  if (d < 1e-9) return fromMetric([S[0], S[1] + l1, S[2] + rel.dz], aspect);
  const u = [se[0] / d, se[1] / d], p = [-u[1], u[0]];
  let along: number, h: number;
  if (l1 + l2 <= d) { along = l1 + l2 > 0 ? d * l1 / (l1 + l2) : d / 2; h = 0; } // straight: share the stretch
  else {
    along = clamp((l1 * l1 - l2 * l2 + d * d) / (2 * d), -l1, l1);
    h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  }
  const side = clamp(rel.side, -1, 1);
  return fromMetric([S[0] + u[0] * along + p[0] * h * side, S[1] + u[1] * along + p[1] * h * side,
    S[2] + se[2] * clamp(along / d, 0, 1) + rel.dz], aspect);
}
/** The torso's direction on screen (hip midpoint to shoulder midpoint), as an angle in radians. */
export function torsoAngle(points: Record<'leftShoulder' | 'rightShoulder' | 'leftHip' | 'rightHip', readonly number[]>, aspect: number): number {
  const s = mid(points.leftShoulder, points.rightShoulder), h = mid(points.leftHip, points.rightHip);
  return Math.atan2(s[1] - h[1], (s[0] - h[0]) * aspect);
}
/**
 * A joint as a bone from its limb's start: its direction relative to the torso's, and its
 * on-screen length. Stable however the limb's far end moves, where limbRel turns with it.
 */
export interface LimbBone { angle: number; length: number; }
export function limbBone(start: readonly number[], joint: readonly number[], torso: number, aspect: number): LimbBone {
  const dx = (joint[0] - start[0]) * aspect, dy = joint[1] - start[1];
  return { angle: Math.atan2(dy, dx) - torso, length: Math.hypot(dx, dy) };
}
export function boneEnd(start: readonly number[], bone: LimbBone, torso: number, aspect: number, z: number): Vec3 {
  const a = bone.angle + torso;
  return [start[0] + Math.cos(a) * bone.length / aspect, start[1] + Math.sin(a) * bone.length, z];
}
/**
 * How far a limb's two-bone solve can be trusted: 1 with its ends well apart, falling to 0 as
 * they come together, where the direction between them (and so the bend) spins wildly.
 */
export function ikTrust(start: readonly number[], end: readonly number[], reach: number, aspect: number): number {
  const d = Math.hypot((end[0] - start[0]) * aspect, end[1] - start[1]);
  const u = Math.min(1, Math.max(0, (d / Math.max(reach, 1e-9) - 0.18) / 0.32));
  return u * u * (3 - 2 * u);
}
const lerp3 = (a: readonly number[], b: readonly number[], w: number): Vec3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
export { lerp3 };

/** The bend side a limb takes by default: elbows out and down, knees out. */
export function autoSide(joint: MidJoint, start: readonly number[], end: readonly number[], aspect: number): number {
  const side = sideOf(joint), knee = joint.endsWith('Knee');
  const pole = [side, knee ? 0 : 0.6];
  const u = [(end[0] - start[0]) * aspect, end[1] - start[1]];
  const cross = u[0] * pole[1] - u[1] * pole[0];
  return cross === 0 ? side : Math.sign(cross);
}
/**
 * An unkeyed elbow or knee: the body's segment lengths, bent partly on screen (to its default
 * side) and the rest toward the camera, as real elbows and knees mostly bend forward.
 */
export function autoLimb(joint: MidJoint, start: readonly number[], end: readonly number[], body: Body, aspect: number, torso = -Math.PI / 2): Vec3 {
  const knee = joint.endsWith('Knee');
  const l1 = knee ? body.thigh : body.upperArm, l2 = knee ? body.shin : body.forearm;
  const S = toMetric(start, aspect), E = toMetric(end, aspect), d = len2(sub(E, S));
  const along = d >= l1 + l2 ? d * l1 / (l1 + l2) : clamp((l1 * l1 - l2 * l2 + d * d) / (2 * Math.max(d, 1e-9)), -l1, l1);
  const h = d >= l1 + l2 ? 0 : Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const share = knee ? 0.35 : 0.45, onScreen = h * share;
  const a1 = Math.hypot(along, onScreen), a2 = Math.hypot(d - along, onScreen);
  const dz = -h * Math.sqrt(1 - share * share);
  const solved = limbIK(start, end, { l1: a1, l2: a2, side: autoSide(joint, start, end, aspect), dz }, aspect);
  // With the ends close together the bend is undefined: let the joint hang from its start
  // instead (down the body, elbows a little out), toward the camera.
  const trust = ikTrust(start, end, l1 + l2, aspect);
  if (trust >= 1) return solved;
  const out = sideOf(joint) * (knee ? 0.12 : 0.35);
  const hanging = boneEnd(start, { angle: Math.PI - out, length: l1 * 0.6 }, torso, aspect, solved[2]);
  return lerp3(hanging, solved, trust);
}

// ---- Derived landmarks ----

/** Head-local points as fractions of head width (x to the dancer's left, y down, z away). */
const FACE: readonly (readonly [number, number, number])[] = [
  [0, 0.12, -0.55], // nose
  [0.1, -0.08, -0.48], [0.18, -0.08, -0.45], [0.27, -0.08, -0.4], // left eye inner, eye, outer
  [-0.1, -0.08, -0.48], [-0.18, -0.08, -0.45], [-0.27, -0.08, -0.4], // right eye
  [0.5, 0, 0], [-0.5, 0, 0], // ears
  [0.12, 0.3, -0.45], [-0.12, 0.3, -0.45], // mouth left, right
];
/** A head-local point rotated by yaw (to the dancer's left), pitch (up) and roll (toward the left shoulder). */
function rotateHead(p: readonly number[], yaw: number, pitch: number, roll: number): Vec3 {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const x1 = p[0] * cy - p[2] * sy, z1 = p[0] * sy + p[2] * cy, y1 = p[1];
  const y2 = y1 * cp + z1 * sp, z2 = -y1 * sp + z1 * cp;
  return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2];
}
/** The 33 landmarks of a rig pose; every joint is fully confident. */
export function rigToLandmarks(pose: RigPose, body: Body, aspect: number): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, confidence: 1 }));
  const put = (i: number, p: readonly number[]) => { out[i].x = p[0]; out[i].y = p[1]; out[i].z = p[2]; };
  const P = pose.points;
  for (const [control, i] of Object.entries(LANDMARK_OF)) put(i, P[control as PointControl]);
  // Face.
  const H = toMetric(P.head, aspect), w = body.head;
  FACE.forEach((local, i) => {
    const r = rotateHead(local, pose.headYaw * DEG, pose.headPitch * DEG, pose.headRoll * DEG);
    put(i, fromMetric(add(H, r, w), aspect));
  });
  // Hands: knuckles along the forearm, the pinky on the outer side.
  for (const side of [1, -1]) {
    const name = side > 0 ? 'left' : 'right';
    const E = toMetric(P[`${name}Elbow` as PointControl], aspect), W = toMetric(P[`${name}Wrist` as PointControl], aspect);
    const f = sub(W, E), fl = len3(f) || 1, u: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
    // The pinky side turns with the forearm (outward while the arm hangs), so the knuckles move
    // continuously however the arm swings.
    const pl = len2(u) || 1;
    const n: Vec3 = [side * u[1] / pl, -side * u[0] / pl, 0];
    const h = body.hand;
    const at = (along: number, out: number) => fromMetric(add(add(W, u, along * h), n, out * h), aspect);
    put(side > 0 ? LM.leftPinky : LM.rightPinky, at(0.85, 0.32));
    put(side > 0 ? LM.leftIndex : LM.rightIndex, at(1, -0.12));
    put(side > 0 ? LM.leftThumb : LM.rightThumb, at(0.55, -0.42));
  }
  // Feet: toes forward along the body's facing, turned out a little; the heel behind.
  for (const side of [1, -1]) {
    const A = toMetric(P[side > 0 ? 'leftAnkle' : 'rightAnkle'], aspect);
    const yaw = (pose.turn + side * 12) * DEG, f: Vec3 = [Math.sin(yaw), 0, -Math.cos(yaw)];
    const L = body.foot, lift = 0.25 * L;
    put(side > 0 ? LM.leftHeel : LM.rightHeel, fromMetric(add(add(A, [0, lift * 0.55, 0]), f, -0.25 * L), aspect));
    put(side > 0 ? LM.leftFootIndex : LM.rightFootIndex, fromMetric(add(add(A, [0, lift, 0]), f, 0.75 * L), aspect));
  }
  return out;
}

// ---- From landmarks (tracking) ----

type Points33 = readonly { x: number; y: number; z: number; confidence?: number | null }[];
const xyz = (l: { x: number; y: number; z: number }): Vec3 => [l.x, l.y, l.z];
const usable = (l: { confidence?: number | null }) => l.confidence === undefined || l.confidence === null || l.confidence >= 0.5;

/** The rig pose that best explains tracked landmarks (head angles and turn are fitted). */
export function landmarksToRig(landmarks: Points33, body: Body, aspect: number): RigPose {
  const points = {} as Record<PointControl, Vec3>;
  for (const [control, i] of Object.entries(LANDMARK_OF)) points[control as PointControl] = xyz(landmarks[i]);
  const le = toMetric(xyz(landmarks[LM.leftEar]), aspect), re = toMetric(xyz(landmarks[LM.rightEar]), aspect);
  const nose = toMetric(xyz(landmarks[LM.nose]), aspect);
  const earsUsable = usable(landmarks[LM.leftEar]) && usable(landmarks[LM.rightEar]);
  const head = earsUsable ? mid(le, re) : add(nose, [0, -0.12 * body.head, 0.55 * body.head]);
  points.head = fromMetric(head, aspect);
  const w = body.head;
  let roll = earsUsable ? Math.atan2(le[1] - re[1], le[0] - re[0]) : 0;
  // A first guess: undo the roll on the nose's offset from the head, read yaw and pitch from it.
  const off = sub(nose, head), cr = Math.cos(-roll), sr = Math.sin(-roll);
  const vx = off[0] * cr - off[1] * sr, vy = off[0] * sr + off[1] * cr;
  let yaw = Math.asin(clamp(vx / (0.55 * w), -0.97, 0.97));
  const A = 0.12 * w, B = 0.55 * w * Math.cos(yaw), R = Math.hypot(A, B);
  let pitch = Math.acos(clamp(vy / R, -1, 1)) - Math.atan2(B, A);
  // Then fit all three to the face points on screen (Gauss-Newton on the head model).
  const used = [LM.nose, LM.leftEye, LM.rightEye, LM.mouthLeft, LM.mouthRight, ...(earsUsable ? [LM.leftEar, LM.rightEar] : [])]
    .filter(i => usable(landmarks[i]));
  const measured = used.map(i => sub(toMetric(xyz(landmarks[i]), aspect), head));
  const residuals = (a: readonly number[]) => used.flatMap((i, k) => {
    const r = rotateHead(FACE[i], a[0], a[1], a[2]);
    return [r[0] * w - measured[k][0], r[1] * w - measured[k][1]];
  });
  let angles = [yaw, pitch, roll];
  for (let iteration = 0; iteration < 12 && used.length >= 3; iteration++) {
    const r0 = residuals(angles), h = 1e-5;
    const J = [0, 1, 2].map(j => { const a = [...angles]; a[j] += h; return residuals(a).map((v, k) => (v - r0[k]) / h); });
    // Solve (JᵀJ + λI) δ = -Jᵀr for the three angles.
    const M = [0, 1, 2].map(a => [0, 1, 2].map(b => J[a].reduce((s, v, k) => s + v * J[b][k], 0) + (a === b ? 1e-9 : 0)));
    const g = [0, 1, 2].map(a => -J[a].reduce((s, v, k) => s + v * r0[k], 0));
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-30) break;
    const delta = [0, 1, 2].map(c => det(M.map((row, i) => row.map((v, j) => j === c ? g[i] : v))) / D);
    angles = angles.map((v, j) => v + clamp(delta[j], -0.3, 0.3));
    if (Math.hypot(...delta) < 1e-7) break;
  }
  [yaw, pitch, roll] = [clamp(angles[0], -1.4, 1.4), clamp(angles[1], -1.05, 1.05), clamp(angles[2], -1.2, 1.2)];
  const ls = toMetric(points.leftShoulder, aspect), rs = toMetric(points.rightShoulder, aspect);
  const turn = Math.asin(clamp((ls[2] - rs[2]) / Math.max(body.shoulderWidth, 1e-6), -0.97, 0.97));
  return { points, turn: round(turn / DEG, 2), headYaw: round(yaw / DEG, 2), headPitch: round(clamp(pitch / DEG, -60, 60), 2), headRoll: round(roll / DEG, 2) };
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
/**
 * Body proportions from tracked or keyed poses. Limbs foreshorten on screen, so each segment
 * takes a high percentile of its measured length; segments that are never seen whole fall back
 * to typical proportions scaled by the torso.
 */
export function fitBody(poses: readonly Points33[], aspect: number): Body {
  const seg = (a: number | readonly number[], b: number | readonly number[]) => {
    const values: number[] = [];
    for (const lm of poses) {
      const ends = [a, b].map(e => typeof e === 'number' ? [e] : e);
      if (!ends.flat().every(i => usable(lm[i]))) continue;
      const [p, q] = ends.map(e => e.map(i => toMetric(xyz(lm[i]), aspect)).reduce((s, v) => add(s, v, 1 / e.length), [0, 0, 0] as Vec3));
      values.push(len2(sub(p, q)));
    }
    return values;
  };
  const both = (l: [number, number], r: [number, number], p = 0.92) => percentile([...seg(...l), ...seg(...r)], p);
  const torso = percentile(seg([11, 12], [23, 24]), 0.6);
  const typical = defaultBody(Number.isFinite(torso) ? torso / 0.29 : 0.72);
  const pick = (v: number, fallback: number, low = 0.7, high = 1.5) => Number.isFinite(v) ? clamp(v, fallback * low, fallback * high) : fallback;
  const r = (v: number) => round(v, 5);
  return {
    shoulderWidth: r(pick(percentile(seg(11, 12), 0.9), typical.shoulderWidth, 0.6)),
    hipWidth: r(pick(percentile(seg(23, 24), 0.9), typical.hipWidth, 0.6)),
    torso: r(pick(torso, typical.torso)),
    neck: r(pick(percentile(seg([11, 12], [7, 8]), 0.6), typical.neck)),
    head: r(pick(percentile(seg(7, 8), 0.9), typical.head)),
    upperArm: r(pick(both([11, 13], [12, 14]), typical.upperArm)),
    forearm: r(pick(both([13, 15], [14, 16]), typical.forearm)),
    thigh: r(pick(both([23, 25], [24, 26]), typical.thigh)),
    shin: r(pick(both([25, 27], [26, 28]), typical.shin)),
    // Hands and feet are mostly seen end-on, and only shape the derived knuckles, heels and toes.
    hand: r(typical.hand),
    foot: r(typical.foot),
  };
}

/** A rig pose reflected about the vertical line x = about, left and right swapped. */
export function mirrorRig(pose: RigPose, about: number): RigPose {
  const points = {} as Record<PointControl, Vec3>;
  for (const c of POINTS) {
    const p = pose.points[mirrorControl(c)];
    points[c] = [2 * about - p[0], p[1], p[2]];
  }
  return { points, turn: -pose.turn, headYaw: -pose.headYaw, headPitch: pose.headPitch, headRoll: -pose.headRoll };
}
/** The hip midpoint. */
export const hipCenter = (pose: RigPose): Vec3 => mid(pose.points.leftHip, pose.points.rightHip);
export const shoulderCenter = (pose: RigPose): Vec3 => mid(pose.points.leftShoulder, pose.points.rightShoulder);
/** On-screen segment length in frame heights. */
export const screenLength = (a: readonly number[], b: readonly number[], aspect: number) => Math.hypot((b[0] - a[0]) * aspect, b[1] - a[1]);
