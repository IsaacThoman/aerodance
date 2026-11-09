/*
 * A Table Tennis player's hands and paddle, without the drawing: what the tracker last said of
 * their hands (trackHands: arms.ts on each pose as it arrives, one-euro filtered), and where the
 * scene's hands and the paddle's blade are each frame (followHands: eased onto them, in the
 * room). Game.tsx draws them there and round.ts plays the ball against the blade, so the game can
 * also be played without a screen (apps/web/tests/table-tennis-agency.test.ts).
 *
 * The room's frame: x to Player 1's right, y up, z towards Player 1; a player's own frame is
 * rally.ts's `mine` (them at +z of the table). The body's frame is at the player's eye, level,
 * facing down the table.
 */

import * as THREE from 'three';
import type { RawPose } from '../pose/body.ts';
import { DEFAULT_FOV, bodyTurn, flatWorld, handPose } from './arms.ts';
import type { BodyTurn, FrameSize, HandInput, HandPose, PicturePoint, Side, Vec3, WorldPoint } from './arms.ts';
import { TABLE, v3 } from './ball.ts';
import type { PaddlePose } from './ball.ts';
import { OneEuro } from './oneEuro.ts';
import type { End } from './rally.ts';

// The eye, in the room, and the shoulders from it in the body's frame (which doesn't tilt).
export const EYE = new THREE.Vector3(0, 1.6, 1.6);
export const SHOULDER: Record<Side, THREE.Vector3> = { right: new THREE.Vector3(0.2, -0.05, 0.05), left: new THREE.Vector3(-0.2, -0.05, 0.05) };
// Where a hand rests while it's lost: down by the side, out of view.
export const REST: Record<Side, Vec3> = { right: { x: 0.02, y: -0.55, z: -0.1 }, left: { x: -0.02, y: -0.55, z: -0.1 } };
// The free wrist this far above its shoulder raises the hand (and back below the lower mark, lowers
// it: alone, that asks the robot to serve); held up, the robot serves again this often (s).
export const RAISED = { up: 0.02, down: -0.1, again: 2.5 } as const;
/** A hand not heard of for this long is lost. */
export const LOST_MS = 500;
// Tracked reach is scaled up a little: arms held out read better a touch longer.
export const REACH = 1.1;
// The mitt sits this far past the wrist, along the hand, and the paddle's blade this far past the mitt.
export const MITT = 0.04;
export const BLADE_UP = 0.15;
// The table's middle (the net), its near end a step in front of the eye.
export const TABLE_Z = EYE.z - 0.45 - TABLE.halfLength;
// Each end's eye in the room: Player 1's at the near end, Player 2's the same at the far end,
// facing back down the table; and the body's turn there.
export const EYES: Record<End, THREE.Vector3> = { 0: EYE, 1: new THREE.Vector3(-EYE.x, EYE.y, 2 * TABLE_Z - EYE.z) };
export const YAW: Record<End, number> = { 0: 0, 1: Math.PI };
// The eye in each player's own frame (rally.ts mine: the table's frame, them at +z).
export const OWN_EYE = v3(EYE.x, EYE.y, EYE.z - TABLE_Z);
// The paddle's blade: its radius, and half its thickness, as drawn and when forgiving.
export const BLADE = { radius: 0.075, halfThickness: 0.006 };
export const FORGIVING = { radius: 0.13, halfThickness: 0.04 };

const UP = new THREE.Vector3(0, 1, 0);
const NO_SHIFT = new THREE.Vector3();
const SIDES = ['left', 'right'] as const;

export interface HandTarget { pose: HandPose; at: number; }

/** A hand as it's drawn this frame, in the room: the mitt's place and turn (y along the hand, z out of the palm). */
export interface DrawnHand {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** The wrist from its shoulder as eased so far (the body's frame, with the reach), and the hand's own turn. */
  wrist: THREE.Vector3;
  turn: THREE.Quaternion;
  started: boolean;
}

/** A player: what the tracker last said about their hands, and the scene's hands and paddle for the ball. */
export interface Rig {
  /** Their end of the table (and their player number, less one). */
  end: End;
  /** The hand holding their paddle (the Paddle hand setting, theirs), and the free one. */
  paddle: Side;
  free: Side;
  hands: Record<Side, HandTarget | null>;
  /** Each hand's pose before its latest from the tracker (takeHand), to tell a swing from one wild pose. */
  before: Record<Side, HandTarget | null>;
  /** Poses are coming in (the hands follow them; until then they rest at REST). */
  tracked: boolean;
  /** The camera sends no world landmarks, so the arms' depth is read from the picture alone (arms.ts flatWorld). */
  flat: boolean;
  /** The hands as drawn (followHands), and the paddle's blade there: its centre and its face's normal, in the room (null before the first frame). */
  drawn: Record<Side, DrawnHand>;
  blade: { center: THREE.Vector3; normal: THREE.Vector3 } | null;
  /** The tracker's measured delay, camera to result, in seconds. */
  latency: number;
  /**
   * The aim assist's slide of the paddle's hand, set by the ball for the next frame, and the slide it
   * was drawn with this frame; the paddle's calibration shift, set by the ball's passes, and as
   * drawn this frame (eased onto it). All in the player's own frame (rally.ts mine).
   */
  nudge: THREE.Vector3;
  nudged: THREE.Vector3;
  shift: THREE.Vector3;
  shifted: THREE.Vector3;
  /** How their torso and head are turned, for the glass dancer the other player sees (null: not seen). */
  body: BodyTurn | null;
  /** Development: a stand-in plays for them (autoplay.ts), setting their hands. */
  autoplay: boolean;
}

const newDrawn = (side: Side): DrawnHand => ({
  position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
  wrist: new THREE.Vector3(REST[side].x, REST[side].y, REST[side].z), turn: new THREE.Quaternion(), started: false,
});

export const newRig = (end: End, paddle: Side): Rig => ({
  end, paddle, free: paddle === 'right' ? 'left' : 'right', hands: { left: null, right: null }, before: { left: null, right: null }, tracked: false, flat: false,
  drawn: { left: newDrawn('left'), right: newDrawn('right') }, blade: null, latency: 0,
  nudge: new THREE.Vector3(), nudged: new THREE.Vector3(), shift: new THREE.Vector3(), shifted: new THREE.Vector3(), body: null, autoplay: false,
});

/** A direction in a player's own frame, turned into the room's (or back). */
export function toRoom(end: End, v: THREE.Vector3, out: THREE.Vector3) {
  return end === 0 ? out.copy(v) : out.set(-v.x, v.y, -v.z);
}

/** A hand held at a wrist, pointing up and forward, knuckles level (index towards the middle). */
export const heldPose = (side: Side, wrist: Vec3): HandPose => ({
  wrist, dir: { x: 0, y: 0.8, z: -0.6 }, across: { x: side === 'right' ? -1 : 1, y: 0, z: 0 }, from: 'pose',
});

const vec = (a: number[]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
const arr = (a: Vec3) => [a.x, a.y, a.z];

/** The one-euro filters (minCutoff Hz, beta) each hand's wrist, dir and across go through (oneEuro.ts). */
export const HAND_FILTERS = { wrist: [1.2, 3], dir: [1, 1.2], across: [1, 1.2] } as const satisfies Record<string, readonly [number, number]>;
/** One hand's intake (intake): its filters. */
export interface HandIntake { wrist: OneEuro; dir: OneEuro; across: OneEuro; }
/** A player's hands' filters (trackHands): one-euro, on the wrist and the hand's two axes. */
export interface HandFilters { seen: RawPose | null; sides: Record<Side, HandIntake>; }
export const newHandIntake = (): HandIntake => ({ wrist: new OneEuro(...HAND_FILTERS.wrist), dir: new OneEuro(...HAND_FILTERS.dir), across: new OneEuro(...HAND_FILTERS.across) });
export const newHandFilters = (): HandFilters => ({
  seen: null,
  sides: { left: newHandIntake(), right: newHandIntake() },
});

/** A hand the tracker found, as readHands takes it: its side and points (RawPose's hands, or a recording's). */
export interface FoundHand extends HandInput { side: Side; score?: number; }

/**
 * Each side's hand from one pose (arms.ts handPose on its picture and world landmarks, with the
 * hand found at that wrist), before any filtering; null for a side the camera doesn't see.
 * (The trackbench's ping-pong metrics read recordings through this too.)
 */
export function readHands(pose: { landmarks: PicturePoint[]; world: WorldPoint[] }, hands: readonly FoundHand[] | null | undefined, size: FrameSize, fov = DEFAULT_FOV): Record<Side, HandPose | null> {
  const out = { left: null, right: null } as Record<Side, HandPose | null>;
  for (const side of SIDES) out[side] = handPose(pose, hands?.find((h) => h.side === side), side, size, fov);
  return out;
}

/** One hand's pose from readHands, taken in at `t` (seconds): what the game follows, filtered. */
export function intake(f: HandIntake, next: HandPose, t: number): HandPose {
  return { from: next.from, wrist: vec(f.wrist.filter(arr(next.wrist), t)), dir: vec(f.dir.filter(arr(next.dir), t)), across: vec(f.across.filter(arr(next.across), t)) };
}

/**
 * A player's hands from a pose as it arrives (`now`, ms): arms.ts on its picture and world
 * landmarks (stand-ins from the picture when the camera sends none) and the hands found, one-euro
 * filtered; and how their torso and head are turned. The tracking's delay is each pose's age
 * when it's first seen. A stand-in's hands (autoplay) are its own. A pose already taken in is
 * left alone.
 */
export function trackHands(rig: Rig, raw: RawPose | null | undefined, now: number, filters: HandFilters, fov = DEFAULT_FOV) {
  rig.tracked = true;
  if (!raw || raw === filters.seen) return;
  filters.seen = raw;
  const image = raw.landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.confidence ?? 1 }));
  const pose = { landmarks: image, world: raw.world ? [...raw.world] : flatWorld(image, raw.input) };
  rig.flat = !raw.world;
  rig.body = bodyTurn(pose.world, image);
  if (!rig.autoplay) {
    const read = readHands(pose, raw.hands, raw.input, fov);
    for (const side of SIDES) { const next = read[side]; if (next) takeHand(rig, side, next, now, filters); }
  }
  takeAge(rig, now - raw.capturedAt);
}

/** A hand as the tracker found it at `now` (ms), filtered, for the scene's hand to follow. */
export function takeHand(rig: Rig, side: Side, next: HandPose, now: number, filters: HandFilters) {
  rig.before[side] = rig.hands[side];
  rig.hands[side] = { at: now, pose: intake(filters.sides[side], next, now / 1000) };
}

/** A pose's age (ms) when it was first seen: the tracking's delay, averaged. */
export function takeAge(rig: Rig, ms: number) {
  const age = ms / 1000;
  if (age >= 0 && age < 1) rig.latency = rig.latency > 0 ? rig.latency * 0.9 + age * 0.1 : age;
}

/**
 * Whether the tracker's latest pose bears out a swing going `way` (the player's own frame): the
 * hand hasn't just sprung back against it by `sprung` metres or more. One wild pose (an arm's
 * depth read the wrong way round, say) throws the hand out and the next brings it back, which
 * looks like a swing to anything watching the eased hand.
 */
export function borneOut(rig: Rig, side: Side, way: Vec3, sprung: number, now: number): boolean {
  const pose = rig.hands[side], was = rig.before[side];
  const l = Math.hypot(way.x, way.y, way.z);
  if (!pose || !was || !l || now - was.at >= LOST_MS) return true;
  const a = pose.pose.wrist, b = was.pose.wrist;
  return ((a.x - b.x) * way.x + (a.y - b.y) * way.y + (a.z - b.z) * way.z) / l > -sprung;
}

/** Whether a side's hand is being tracked now (not lost, nor waiting for the camera). */
export const handLive = (rig: Rig, side: Side, now: number) => {
  const target = rig.hands[side];
  return rig.tracked && !!target && now - target.at < LOST_MS;
};

const tmp = { wrist: new THREE.Vector3(), dir: new THREE.Vector3(), across: new THREE.Vector3(), face: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), body: new THREE.Matrix4(), yaw: new THREE.Quaternion(), v: new THREE.Vector3() };

/**
 * Each of a player's hands where it's drawn this frame (`now`, ms; `delta`, seconds since the
 * last): the mitt just past the wrist, eased from the tracker's ~30 Hz to the screen's rate (it's
 * already filtered; a lost hand drops slowly to its rest). The paddle's hand slides as the aim
 * assist says and is shifted as its calibration has it, and the blade is along the hand past the
 * mitt, its face square to the knuckles (a shakehand grip).
 */
export function followHands(rig: Rig, now: number, delta: number) {
  for (const side of SIDES) {
    const drawn = rig.drawn[side];
    const target = rig.hands[side];
    const lost = rig.tracked && (!target || now - target.at >= LOST_MS);
    const pose = !rig.tracked || lost ? heldPose(side, REST[side]) : target!.pose;
    const k = 1 - Math.exp(-(lost ? 4 : 24) * delta);
    drawn.wrist.lerp(tmp.wrist.set(pose.wrist.x, pose.wrist.y, pose.wrist.z).multiplyScalar(rig.tracked ? REACH : 1), k);
    // The hand's frame: y along the hand, x across the knuckles, z (the paddle's front face) out of the palm.
    const dir = tmp.dir.set(pose.dir.x, pose.dir.y, pose.dir.z).normalize();
    const across = tmp.across.set(pose.across.x, pose.across.y, pose.across.z);
    const face = tmp.face.crossVectors(across, dir);
    if (face.lengthSq() > 1e-6) {
      face.normalize();
      across.crossVectors(dir, face);
      tmp.q.setFromRotationMatrix(tmp.m.makeBasis(across, dir, face));
      if (!drawn.started) { drawn.turn.copy(tmp.q); drawn.started = true; } else drawn.turn.slerp(tmp.q, k);
    }
    // Into the room: the body's frame is at the player's eye, facing down the table, level.
    tmp.yaw.setFromAxisAngle(UP, YAW[rig.end]);
    tmp.body.makeRotationFromQuaternion(tmp.yaw).setPosition(EYES[rig.end]);
    drawn.quaternion.multiplyQuaternions(tmp.yaw, drawn.turn);
    const wrist = tmp.wrist.copy(drawn.wrist).add(SHOULDER[side]).applyMatrix4(tmp.body);
    drawn.position.copy(wrist).addScaledVector(tmp.dir.set(0, 1, 0).applyQuaternion(drawn.quaternion), MITT);
    if (side !== rig.paddle) continue;
    rig.nudged.copy(rig.nudge);
    // (Only while the camera's on: the hands waiting for it aren't the player's.)
    rig.shifted.lerp(rig.tracked ? rig.shift : NO_SHIFT, 1 - Math.exp(-3 * delta));
    drawn.position.add(toRoom(rig.end, rig.nudged, tmp.v)).add(toRoom(rig.end, rig.shifted, tmp.v));
    rig.blade ??= { center: new THREE.Vector3(), normal: new THREE.Vector3() };
    rig.blade.center.copy(drawn.position).addScaledVector(tmp.dir.set(0, 1, 0).applyQuaternion(drawn.quaternion), BLADE_UP);
    rig.blade.normal.set(0, 0, 1).applyQuaternion(drawn.quaternion);
  }
}

/** The paddle's blade in the table's frame (ball.ts), as drawn this frame; null before the first. */
export function bladePose(rig: Rig, forgiving: boolean): PaddlePose | null {
  if (!rig.blade) return null;
  const { center: c, normal: n } = rig.blade;
  return { center: v3(c.x, c.y, c.z - TABLE_Z), normal: v3(n.x, n.y, n.z), ...(forgiving ? FORGIVING : BLADE) };
}

/**
 * The wrist (from its shoulder, as the tracker would give it) that puts the paddle's blade at a
 * place in the player's own frame, the hand held as heldPose has it: for stand-ins and tests.
 */
export function wristFor(rig: Rig, blade: Vec3): Vec3 {
  const d = heldPose(rig.paddle, REST[rig.paddle]).dir, s = SHOULDER[rig.paddle];
  const reach = MITT + BLADE_UP, k = 1 / (rig.tracked ? REACH : 1);
  return {
    x: (blade.x - OWN_EYE.x - s.x - d.x * reach - rig.shifted.x) * k,
    y: (blade.y - OWN_EYE.y - s.y - d.y * reach - rig.shifted.y) * k,
    z: (blade.z - OWN_EYE.z - s.z - d.z * reach - rig.shifted.z) * k,
  };
}
