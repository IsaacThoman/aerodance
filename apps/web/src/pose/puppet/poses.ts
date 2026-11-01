import { STAND, v3 } from './rig.ts';
import type { PuppetPose, Vec3 } from './rig.ts';

/*
 * The puppet's vocabulary: named poses (a whole body, in place) and gestures (timed moves from
 * wherever the body is). Hands and feet are body-space targets (rig.ts): torso lengths from the
 * hip centre, x to the player's right, y up, z towards the camera. The shoulders are at y 1,
 * x ±0.39, and an arm reaches about 0.97.
 */

/** A pose change: any of PuppetPose's fields, joints merged. */
export type PosePatch = Partial<Omit<PuppetPose, 'joints'>> & { joints?: Partial<Record<number, Vec3 | null>> };
/** One step of a move: change the pose over ms (eased), then hold it for hold ms. */
export interface PuppetStep { patch: PosePatch; ms: number; hold?: number; ease?: EaseName; }
export type EaseName = 'linear' | 'in' | 'out' | 'inOut';

// Both hands at mirror-image points.
const both = (x: number, y: number, z = 0.05): PosePatch => ({ leftHand: v3(-x, y, z), rightHand: v3(x, y, z) });

/** Named poses: each replaces the whole body (not where it stands, how far back, or joints placed by hand). */
export const POSES: Record<string, PosePatch> = {
  stand: {},
  tpose: both(1.36, 1),
  armsUp: both(0.42, 1.92),
  armsOut: both(1.2, 0.55),
  vUp: both(1.0, 1.75),
  leftUp: { leftHand: v3(-0.42, 1.92, 0.05) },
  rightUp: { rightHand: v3(0.42, 1.92, 0.05) },
  leftOut: { leftHand: v3(-1.36, 1, 0.05) },
  rightOut: { rightHand: v3(1.36, 1, 0.05) },
  armsForward: both(0.3, 0.9, 0.9),
  guard: both(0.2, 1.3, 0.4),
  punchLeft: { ...both(0.2, 1.3, 0.4), leftHand: v3(-0.15, 1.05, 0.95) },
  punchRight: { ...both(0.2, 1.3, 0.4), rightHand: v3(0.15, 1.05, 0.95) },
  clap: both(0.04, 0.95, 0.5),
  hips: both(0.42, 0.12, 0),
  crouch: { crouch: 0.8, ...both(0.32, 0.55, 0.6) },
  jump: { lift: 0.55, ...both(0.9, 1.6) },
  leanLeft: { lean: -22 },
  leanRight: { lean: 22 },
  star: { ...both(1.05, 1.7), leftFoot: v3(-0.62, -1.18, 0.05), rightFoot: v3(0.62, -1.18, 0.05) },
  kickLeft: { leftFoot: v3(-0.25, -0.55, 0.95) },
  kickRight: { rightFoot: v3(0.25, -0.55, 0.95) },
  kneeLeft: { leftFoot: v3(-0.22, -0.75, 0.55) },
  kneeRight: { rightFoot: v3(0.22, -0.75, 0.55) },
  bow: { bow: 40 },
};

/** A named pose as a whole body, standing wherever it stands (x and depth aren't touched). */
export function namedPose(name: string): PosePatch {
  const patch = POSES[name];
  if (!patch) throw Error(`Unknown pose "${name}"; poses: ${Object.keys(POSES).join(', ')}`);
  const { joints: _joints, x: _x, depth: _depth, ...body } = STAND;
  return { ...body, ...patch };
}

type Side = 'left' | 'right';
// One hand at a body-space point, x out to its own side (mirrored for the left hand).
const handAt = (side: Side, x: number, y: number, z = 0.05): PosePatch =>
  (side === 'left' ? { leftHand: v3(-x, y, z) } : { rightHand: v3(x, y, z) });
const handDown = (side: Side) => handAt(side, 0.5, 0.05);
// A sweep across at shoulder height from body x `from` to `to` (on the screen: + is right),
// reaching further out on the hand's own side than across the body.
const sweep = (side: Side, from: number, to: number): PuppetStep[] => {
  const out = (x: number) => (Math.sign(x) === (side === 'left' ? -1 : 1) ? 1.25 : 0.9) * Math.sign(x);
  const at = (x: number) => (side === 'left' ? { leftHand: v3(out(x), 1.05, 0.25) } : { rightHand: v3(out(x), 1.05, 0.25) });
  // Getting ready and going back are unhurried, so only the sweep itself reads as a swipe.
  return [{ patch: at(from), ms: 700, hold: 100 }, { patch: at(to), ms: 260, hold: 120 }, { patch: handDown(side), ms: 1000 }];
};

/** What a gesture starts from: the hand it uses and the pose it starts in. */
export interface GestureFrom { side: Side; pose: Pick<PuppetPose, 'x'>; }

/**
 * Gestures: steps from wherever the body is now, with the hand they use (the right one unless
 * told otherwise). A swipe's direction is on the mirrored screen: swipeLeft sweeps towards its left.
 */
export const GESTURES: Record<string, (from: GestureFrom) => PuppetStep[]> = {
  // A hand sweeps across at shoulder height, from out on one side over to the other.
  swipeLeft: ({ side }) => sweep(side, 1, -1),
  swipeRight: ({ side }) => sweep(side, -1, 1),
  swipeUp: ({ side }) => [
    { patch: handAt(side, 0.6, 0.3, 0.3), ms: 500, hold: 100 },
    { patch: handAt(side, 0.6, 1.95, 0.3), ms: 260, hold: 120 },
    { patch: handDown(side), ms: 1100 },
  ],
  swipeDown: ({ side }) => [
    { patch: handAt(side, 0.6, 1.95, 0.3), ms: 900, hold: 100 },
    { patch: handAt(side, 0.6, 0.3, 0.3), ms: 260, hold: 120 },
    { patch: handDown(side), ms: 500 },
  ],
  // Guard up, a quick jab straight at the camera, back to guard.
  punch: ({ side }) => [
    { patch: POSES.guard, ms: 600, hold: 150 },
    { patch: handAt(side, 0.15, 1.05, 0.95), ms: 140, ease: 'out', hold: 100 },
    { patch: POSES.guard, ms: 350, hold: 100 },
  ],
  // Hands apart, together, apart.
  clap: () => [
    { patch: both(0.65, 0.95, 0.35), ms: 200, hold: 60 },
    { patch: both(0.04, 0.95, 0.5), ms: 130, ease: 'in', hold: 60 },
    { patch: both(0.65, 0.95, 0.35), ms: 180 },
  ],
  // Dip, spring up with the arms, come down and settle.
  jump: () => [
    { patch: { crouch: 0.35, ...both(0.55, 0.3, 0.2) }, ms: 220 },
    { patch: { crouch: 0, lift: 0.6, ...both(0.9, 1.6) }, ms: 230, ease: 'out' },
    { patch: { lift: 0 }, ms: 230, ease: 'in' },
    { patch: { crouch: 0.25 }, ms: 110 },
    { patch: { crouch: 0, ...both(0.5, 0.05) }, ms: 220 },
  ],
  squat: () => [
    { patch: { crouch: 0.9, ...both(0.32, 0.55, 0.6) }, ms: 500, hold: 300 },
    { patch: { crouch: 0, ...both(0.5, 0.05) }, ms: 500 },
  ],
  // A hand up by the head, waving side to side three times.
  wave: ({ side }) => [
    { patch: handAt(side, 0.75, 1.75, 0.1), ms: 250 },
    ...[0, 1, 2].flatMap((): PuppetStep[] => [
      { patch: handAt(side, 1.05, 1.7, 0.1), ms: 160 },
      { patch: handAt(side, 0.55, 1.78, 0.1), ms: 160 },
    ]),
    { patch: handDown(side), ms: 300 },
  ],
  // Both arms flapping like wings, three times.
  flap: () => [
    ...[0, 1, 2].flatMap((): PuppetStep[] => [
      { patch: both(1.3, 1.25), ms: 180 },
      { patch: both(1.1, 0.35), ms: 180 },
    ]),
    { patch: both(0.5, 0.05), ms: 250 },
  ],
  // A step a tenth of the picture across.
  stepLeft: ({ pose }) => [{ patch: { x: pose.x - 0.1 }, ms: 450 }],
  stepRight: ({ pose }) => [{ patch: { x: pose.x + 0.1 }, ms: 450 }],
  leanLeft: () => [{ patch: { lean: -22 }, ms: 300, hold: 400 }, { patch: { lean: 0 }, ms: 300 }],
  leanRight: () => [{ patch: { lean: 22 }, ms: 300, hold: 400 }, { patch: { lean: 0 }, ms: 300 }],
};

/** A gesture's steps from a pose, with its hand and speed (2 is twice as fast). */
export function gestureSteps(name: string, { side = 'right', speed = 1, pose }: { side?: Side; speed?: number; pose: Pick<PuppetPose, 'x'> }): PuppetStep[] {
  const make = GESTURES[name];
  if (!make) throw Error(`Unknown gesture "${name}"; gestures: ${Object.keys(GESTURES).join(', ')}`);
  const k = 1 / Math.max(0.1, speed);
  return make({ side, pose }).map((step) => ({ ...step, ms: step.ms * k, hold: (step.hold ?? 0) * k }));
}

const EASES: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
};
export const ease = (name: EaseName = 'inOut', t: number) => EASES[name](Math.min(1, Math.max(0, t)));
export const isEase = (name: unknown): name is EaseName => typeof name === 'string' && name in EASES;
