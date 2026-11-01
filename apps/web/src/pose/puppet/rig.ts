import type { FrameSize } from '../../../../../packages/pose/choreography.ts';

/*
 * The puppet's body: a pose described the way a game reads one (pose API, minigames/pose/body.ts)
 * turned into the 33 landmarks MediaPipe Pose would report for a person standing like that.
 *
 * Body space is the minigames' body space: torso lengths (shoulder centre to hip centre, at rest)
 * from the hip centre, x towards the right of the mirrored screen (the player's own right), y up
 * and z towards the camera. Hands and feet are targets in it; the arms and legs reach them with
 * two-bone IK, so a hand can be put anywhere and the elbow follows. The landmarks come out in
 * MediaPipe's image space: unmirrored x and y as fractions of the picture, and z from the hips in
 * x's scale, negative towards the camera.
 *
 * The proportions are standingPose's (pose/ReplayPoseSource.ts): a 640x480 picture with the hips
 * at 0.56 of its height and a torso 0.24 of it, the ankles at 0.88. depth moves the person back
 * (smaller, their feet nearer the horizon) or forward (bigger, feet out of the picture).
 */

export interface Vec3 { x: number; y: number; z: number; }
/** A landmark as MediaPipe reports it. */
export interface DetectedPoint extends Vec3 { visibility: number; presence: number; }

export interface PuppetPose {
  /** The hip centre across the mirrored picture: 0 its left edge, 1 its right. */
  x: number;
  /** How far back: 1 the usual distance, 1.3 farther (smaller), 0.75 near enough that the feet leave the picture. */
  depth: number;
  /** Degrees the torso tilts sideways, towards the player's right (+) or left (−). */
  lean: number;
  /** Degrees the torso bends forward, towards the camera. */
  bow: number;
  /** Degrees the body turns to its right (+): the right shoulder goes back. */
  turn: number;
  /** 0 standing to 1 a deep squat: the hips drop and the knees bend, feet planted. */
  crouch: number;
  /** Torso lengths the whole body is off the floor (a jump). */
  lift: number;
  /** Degrees the head tilts towards the player's right (+), and turns to their right (+). */
  headTilt: number;
  headTurn: number;
  /** Wrist and ankle targets in body space, measured as if standing (crouch keeps the feet planted). */
  leftHand: Vec3;
  rightHand: Vec3;
  leftFoot: Vec3;
  rightFoot: Vec3;
  /** Landmarks placed by hand, in body space, over where the body puts them (by MediaPipe index). */
  joints: Partial<Record<number, Vec3>>;
}

// Proportions in torso lengths (measured from standingPose).
const SHOULDER_HALF = 0.39;
const HIP_HALF = 0.25;
export const UPPER_ARM = 0.5;
export const FOREARM = 0.47;
const THIGH = 0.67;
const SHIN = 0.66;
const HEAD_UP = 0.5;
const CROUCH_DROP = 0.6;
// The picture at depth 1: torso height and hip height, as fractions of its height, and where the
// floor's horizon is (a person farther back stands higher in the picture).
const TORSO = 0.24;
const HIP_Y = 0.56;
const HORIZON = 0.42;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3): Vec3 => { const l = length(a); return l > 1e-9 ? scale(a, 1 / l) : v3(); };
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Standing relaxed in the middle of the picture, arms a little out. */
export const STAND: PuppetPose = {
  x: 0.5, depth: 1, lean: 0, bow: 0, turn: 0, crouch: 0, lift: 0, headTilt: 0, headTurn: 0,
  leftHand: v3(-0.5, 0.05, 0.05), rightHand: v3(0.5, 0.05, 0.05),
  leftFoot: v3(-0.22, -1.32, 0.05), rightFoot: v3(0.22, -1.32, 0.05),
  joints: {},
};

/**
 * Two-bone IK: where the middle joint goes for a chain of l1 and l2 from root reaching for target
 * (held to its reach), bending towards pole.
 */
export function reach(root: Vec3, target: Vec3, l1: number, l2: number, pole: Vec3): { mid: Vec3; end: Vec3 } {
  const d = sub(target, root);
  const dist = Math.min((l1 + l2) * 0.999, Math.max(Math.abs(l1 - l2) + 1e-3, length(d)));
  const dir = length(d) > 1e-9 ? norm(d) : v3(0, -1, 0);
  const end = add(root, scale(dir, dist));
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let bend = sub(pole, scale(dir, dot(pole, dir)));
  if (length(bend) < 1e-4) bend = cross(dir, v3(0, 0, 1));
  if (length(bend) < 1e-4) bend = v3(1, 0, 0);
  return { mid: add(add(root, scale(dir, a)), scale(norm(bend), h)), end };
}

/** Where the person stands in the picture: their hip centre (image fractions) and torso height. */
export function placement(pose: PuppetPose) {
  const depth = Math.max(0.3, pose.depth);
  const torso = TORSO / depth;
  const drop = CROUCH_DROP * Math.max(0, Math.min(1, pose.crouch));
  return { hipX: 1 - pose.x, hipY: HORIZON + (HIP_Y - HORIZON) / depth + (drop - pose.lift) * torso, torso, drop };
}

/** The 33 landmarks of a pose in body space (from the hip centre where it is now). */
export function bodyPoints(pose: PuppetPose): Vec3[] {
  const { drop } = placement(pose);
  const lean = rad(pose.lean), bow = rad(pose.bow + 15 * Math.max(0, Math.min(1, pose.crouch))), turn = rad(pose.turn);
  const up = v3(Math.sin(lean) * Math.cos(bow), Math.cos(lean) * Math.cos(bow), Math.sin(bow));
  const neck = up;
  // Across the shoulders (towards the player's right), turned with the body.
  const across = add(scale(v3(Math.cos(lean), -Math.sin(lean), 0), Math.cos(turn)), v3(0, 0, -Math.sin(turn)));
  const hipAcross = v3(Math.cos(turn), 0, -Math.sin(turn));
  const p: Vec3[] = Array.from({ length: 33 }, () => v3());
  p[11] = add(neck, scale(across, -SHOULDER_HALF));
  p[12] = add(neck, scale(across, SHOULDER_HALF));
  p[23] = scale(hipAcross, -HIP_HALF);
  p[24] = scale(hipAcross, HIP_HALF);

  // The face, round a head centre at nose height: (u across, v up, w forward) turned by headTurn.
  const tilt = lean + rad(pose.headTilt), yaw = rad(pose.headTurn);
  const headUp = v3(Math.sin(tilt) * Math.cos(bow), Math.cos(tilt) * Math.cos(bow), Math.sin(bow));
  const faceAcross = v3(Math.cos(tilt), -Math.sin(tilt), 0);
  const forward = norm(cross(faceAcross, headUp));
  const head = add(neck, scale(headUp, HEAD_UP));
  const face = (u: number, v: number, w: number) => {
    const u2 = u * Math.cos(yaw) + w * Math.sin(yaw), w2 = w * Math.cos(yaw) - u * Math.sin(yaw);
    return add(add(add(head, scale(faceAcross, u2)), scale(headUp, v)), scale(forward, w2));
  };
  // The person's left is body −x.
  p[0] = face(0, 0, 0.14);
  [[1, 0.067], [2, 0.11], [3, 0.156]].forEach(([i, u]) => { p[i] = face(-u, 0.04, 0.09); p[i + 3] = face(u, 0.04, 0.09); });
  p[7] = face(-0.19, 0, -0.04); p[8] = face(0.19, 0, -0.04);
  p[9] = face(-0.067, -0.1, 0.1); p[10] = face(0.067, -0.1, 0.1);

  // Arms: elbows out, down and back; the hand's points along the forearm, the thumb towards the body.
  for (const [side, shoulder, elbow, wrist, pinky, index, thumb, target] of [
    [-1, 11, 13, 15, 17, 19, 21, pose.leftHand], [1, 12, 14, 16, 18, 20, 22, pose.rightHand],
  ] as const) {
    const arm = reach(p[shoulder], target, UPPER_ARM, FOREARM, v3(side * 0.5, -0.6, -0.6));
    p[elbow] = arm.mid; p[wrist] = arm.end;
    const along = norm(sub(arm.end, arm.mid));
    let n = scale(cross(along, v3(0, 0, 1)), side);
    if (length(n) < 1e-4) n = v3(-side, 0, 0);
    n = norm(n);
    p[pinky] = add(add(arm.end, scale(along, 0.125)), scale(n, -0.028));
    p[index] = add(arm.end, scale(along, 0.167));
    p[thumb] = add(add(arm.end, scale(along, 0.083)), scale(n, 0.056));
  }
  // Legs: knees forward and a little out; crouching keeps the feet where they were.
  for (const [side, hip, knee, ankle, heel, toe, target] of [
    [-1, 23, 25, 27, 29, 31, pose.leftFoot], [1, 24, 26, 28, 30, 32, pose.rightFoot],
  ] as const) {
    const leg = reach(p[hip], add(target, v3(0, drop, 0)), THIGH, SHIN, v3(side * 0.35, 0, 1));
    p[knee] = leg.mid; p[ankle] = leg.end;
    p[heel] = add(leg.end, v3(side * -0.011, -0.083, -0.05));
    p[toe] = add(leg.end, v3(side * 0.056, -0.125, 0.18));
  }
  for (const [i, at] of Object.entries(pose.joints)) if (at) p[Number(i)] = at;
  return p;
}

// How sure MediaPipe is of each landmark in view: the face and torso most, the hands and feet least.
const SURE = Array.from({ length: 33 }, (_, i) => (i <= 12 || i === 23 || i === 24 ? 0.98 : i <= 16 || (i >= 25 && i <= 28) ? 0.95 : 0.9));
// A landmark this far outside the picture is out of view: MediaPipe still guesses where, unsure.
const EDGE = 0.01;

/** Body-space points to MediaPipe's image space for a pose's placement, with how sure the model would be of each. */
export function toImage(points: readonly Vec3[], pose: PuppetPose, frame: FrameSize): DetectedPoint[] {
  const { hipX, hipY, torso } = placement(pose);
  const aspect = frame.width / frame.height;
  return points.map((b, i) => {
    const x = hipX - (b.x * torso) / aspect, y = hipY - b.y * torso, z = (-b.z * torso) / aspect;
    const inView = x >= -EDGE && x <= 1 + EDGE && y >= -EDGE && y <= 1 + EDGE;
    return { x, y, z, visibility: inView ? SURE[i] : 0.12, presence: inView ? SURE[i] : 0.2 };
  });
}

/** What MediaPipe would report for a person in this pose: 33 landmarks in image space. */
export function landmarksOf(pose: PuppetPose, frame: FrameSize = { width: 640, height: 480 }): DetectedPoint[] {
  return toImage(bodyPoints(pose), pose, frame);
}
