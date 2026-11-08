import type { CaptureInput, FrameSize, Landmark, Point3, TrackCalibration } from '../../../../../packages/pose/choreography.ts';
import type { TrackedHand } from '../../../../../packages/pose/webcamRecord.ts';
import { JOINT_INDEX } from '../../pose/joints.ts';
import type { JointName } from '../../pose/joints.ts';

/*
 * A player's body as a minigame reads it, from the camera's poses (the same records the song
 * game scores). The screen is a mirror, so everything is the player's view of themselves: their
 * right hand is on the right of the screen.
 *
 *   screen    each landmark across the mirrored camera picture, 0-1 left to right and top to
 *             bottom (the camera's aspect is `aspect`; minigames/scene.tsx fits the picture to
 *             the screen)
 *   body      torso lengths (shoulder centre to hip centre, as calibrated) from the hip centre:
 *             x to the player's right, y up, z towards the camera. The same numbers whoever
 *             plays, however far from the camera they stand
 *   velocity  body space per second
 *   offset    the hip centre from where the player stood still for calibration, in torso
 *             lengths: stepping right is +x, a jump +y, a crouch −y
 *
 * Poses arrive 20-30 times a second, a tenth of a second or two after the movement (camera,
 * tracking), and jitter. Each landmark goes through a One Euro filter: steady while still,
 * hardly lagging while moving fast. Values change only when a pose arrives and are never
 * extrapolated, so `ageMs` (how old the newest capture is) is the honest latency. A landmark the
 * model is unsure of holds its last sure place for a moment, then follows the guess with its
 * confidence low; feet are often out of the picture. A player missing for PRESENT_MS isn't present.
 *
 *   raw       the newest pose as it arrived, for games that do their own geometry: unfiltered,
 *             unmirrored, with the camera's world landmarks and hands when the game asks for
 *             them (`tracking: 'hands'`)
 *
 * const follower = createPoseFollower(0);
 * follower.setCalibration(calibration);                     // from the stillness hold
 * follower.push(pose.landmarks, record.input, captureBrowserTimeMs);  // each record
 * follower.update(performance.now());                       // each frame: present, ageMs
 * follower.pose.body[JOINT.rightWrist]                      // { x, y, z }
 */

export interface BodyPoint { x: number; y: number; z: number; }
export interface ScreenPoint { x: number; y: number; }
/** A pose as it arrived from the camera (PlayerPose.raw). */
export interface RawPose {
  /** MediaPipe's 33 landmarks in the unmirrored picture (0-1), with their confidences, unfiltered. */
  landmarks: readonly Landmark[];
  /**
   * Its world landmarks, with `tracking: 'hands'`: the 33 in metres from the hips' centre (x to
   * the unmirrored picture's right, y down, z away from the camera), or null without them.
   */
  world: readonly Point3[] | null;
  /**
   * With `tracking: 'hands'` and one player, the hands the Hand Landmarker found at their wrists
   * (none found: empty), each on the player's own side; null while it isn't running (ctx.handTracking()).
   */
  hands: readonly TrackedHand[] | null;
  /** The picture it was measured in (always unmirrored), and when its frame was captured (performance.now()). */
  input: CaptureInput;
  capturedAt: number;
}

/** A joint's landmark index (JOINT.rightWrist is 16). */
export const JOINT = JOINT_INDEX as Readonly<Record<JointName | 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot', number>>;
export type { JointName, Side } from '../../pose/joints.ts';

/** A player's pose this frame (minigames/pose/gestures.ts reads it). */
export interface PlayerPose {
  readonly id: number;
  /** A pose arrived in the last PRESENT_MS. */
  present: boolean;
  /** The body space is the calibrated one (otherwise it's estimated from the poses so far). */
  calibrated: boolean;
  /** How sure the model is of the shoulders and hips, 0-1. */
  confidence: number;
  /** performance.now() when the newest pose's camera frame was captured, and how long ago that was. */
  capturedAt: number;
  ageMs: number;
  /** Poses so far. */
  samples: number;
  /** The camera picture's width over its height. */
  aspect: number;
  /** The torso's length as a fraction of the picture's height. */
  torso: number;
  /** Per landmark (33): mirrored screen place, body place, body velocity and confidence (0-1). */
  screen: ScreenPoint[];
  body: BodyPoint[];
  velocity: BodyPoint[];
  jointConfidence: number[];
  /** The hip centre from where the player was calibrated, and its velocity. */
  offset: BodyPoint;
  offsetVelocity: BodyPoint;
  /** The newest pose as it arrived (a new object with each one), or null before the first. */
  raw: RawPose | null;
}

/** A player who hasn't been seen for this long isn't present. */
export const PRESENT_MS = 400;
/** A landmark the model is unsure of holds its last sure place this long. */
export const HOLD_MS = 500;
const SURE = 0.5;
const COUNT = 33;

/** One Euro filter settings: the cutoff at rest (Hz), how much speed raises it, and the velocity's cutoff. */
export interface EuroSettings { minCutoff: number; beta: number; dCutoff: number; }
// Body space is in torso lengths (hands move up to about 8 a second); the screen in picture widths.
export const BODY_FILTER: EuroSettings = { minCutoff: 1.4, beta: 0.5, dCutoff: 3 };
export const SCREEN_FILTER: EuroSettings = { minCutoff: 1.4, beta: 3, dCutoff: 3 };

/** The One Euro filter (Casiez et al. 2012): adaptive low-pass, with its smoothed derivative. */
export class OneEuro {
  value = 0;
  velocity = 0;
  at = -Infinity;
  settings: EuroSettings;
  constructor(settings: EuroSettings) { this.settings = settings; }
  reset() { this.at = -Infinity; this.velocity = 0; }
  /** Filters a sample taken at `at` (ms); returns the filtered value. */
  next(sample: number, at: number) {
    if (!Number.isFinite(this.at) || at <= this.at) {
      if (!Number.isFinite(this.at)) { this.value = sample; this.velocity = 0; }
      this.at = Math.max(at, Number.isFinite(this.at) ? this.at : at);
      return this.value;
    }
    const dt = (at - this.at) / 1000;
    this.at = at;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const { minCutoff, beta, dCutoff } = this.settings;
    this.velocity += ((sample - this.value) / dt - this.velocity) * alpha(dCutoff);
    this.value += (sample - this.value) * alpha(minCutoff + beta * Math.abs(this.velocity));
    return this.value;
  }
}

const zero = (): BodyPoint => ({ x: 0, y: 0, z: 0 });
const mid = (p: readonly Landmark[], a: number, b: number) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 });
const sure = (j: Landmark) => j.confidence === null || j.confidence >= SURE;

/** A blank pose for player id (not present, not calibrated). */
export function emptyPose(id: number): PlayerPose {
  return {
    id, present: false, calibrated: false, confidence: 0, capturedAt: -Infinity, ageMs: Infinity, samples: 0, aspect: 4 / 3, torso: 0.24,
    screen: Array.from({ length: COUNT }, () => ({ x: 0.5, y: 0.5 })), body: Array.from({ length: COUNT }, zero),
    velocity: Array.from({ length: COUNT }, zero), jointConfidence: Array<number>(COUNT).fill(0), offset: zero(), offsetVelocity: zero(), raw: null,
  };
}

export interface PoseFollower {
  readonly pose: PlayerPose;
  readonly calibration: TrackCalibration | null;
  /** The calibration body space is measured against (null estimates it from the poses). */
  setCalibration(calibration: TrackCalibration | null): void;
  /**
   * A pose for this player from a record: its landmarks (image space), the frame and when it was
   * captured, and its world landmarks and hands when it has them (raw).
   */
  push(landmarks: readonly Landmark[], input: FrameSize | CaptureInput, capturedAt: number, extras?: { world?: readonly Point3[]; hands?: readonly TrackedHand[] }): void;
  /** Each frame: whether the player is present, and how old their pose is. */
  update(now: number): void;
  /** Forgets the filters (a player who comes back starts afresh). */
  reset(): void;
}

/** Follows one player's poses into PlayerPose (see the top of this file). */
export function createPoseFollower(id: number, { body: bodyFilter = BODY_FILTER, screen: screenFilter = SCREEN_FILTER } = {}): PoseFollower {
  const pose = emptyPose(id);
  let calibration: TrackCalibration | null = null;
  // Without a calibration: the torso and standing place from the first poses.
  let estimate: { torso: number; hip: { x: number; y: number } } | null = null;
  const filters = {
    screen: Array.from({ length: COUNT }, () => [new OneEuro(screenFilter), new OneEuro(screenFilter)]),
    body: Array.from({ length: COUNT }, () => [new OneEuro(bodyFilter), new OneEuro(bodyFilter), new OneEuro(bodyFilter)]),
    offset: [new OneEuro(bodyFilter), new OneEuro(bodyFilter), new OneEuro(bodyFilter)],
  };
  // Per landmark: its last sure place (image space) and when.
  const held: ({ x: number; y: number; z: number; at: number } | undefined)[] = [];
  let lastSeen = -Infinity;

  const reset = () => {
    for (const group of [...filters.screen, ...filters.body, filters.offset]) for (const f of group) f.reset();
    held.length = 0;
    pose.samples = 0;
  };

  return {
    pose,
    get calibration() { return calibration; },
    setCalibration(next) {
      calibration = next;
      estimate = null;
      pose.calibrated = !!next;
      reset();
    },
    reset,
    push(raw, input, capturedAt, extras) {
      if (raw.length < COUNT) return;
      pose.raw = { landmarks: raw, world: extras?.world ?? null, hands: extras?.hands ?? null,
        input: 'mirrored' in input ? input : { ...input, mirrored: false }, capturedAt };
      // Gone long enough to have walked away: start afresh.
      if (capturedAt - lastSeen > 3000) reset();
      lastSeen = Math.max(lastSeen, capturedAt);
      const aspect = input.width / input.height;
      const landmarks = raw.map((j, i) => {
        if (sure(j)) { held[i] = { x: j.x, y: j.y, z: j.z, at: capturedAt }; return j; }
        const h = held[i];
        return h && capturedAt - h.at <= HOLD_MS ? { ...j, x: h.x, y: h.y, z: h.z } : j;
      });
      const hip = mid(landmarks, 23, 24), shoulders = mid(landmarks, 11, 12);
      const liveTorso = Math.max(0.02, Math.hypot((shoulders.x - hip.x) * aspect, shoulders.y - hip.y));
      if (!calibration && !estimate) estimate = { torso: liveTorso, hip };
      if (estimate) estimate.torso += (liveTorso - estimate.torso) * 0.05;
      const torso = calibration?.torsoLength ?? estimate!.torso;
      const base = calibration?.baseHip ?? estimate!.hip;
      pose.aspect = aspect;
      pose.torso = torso;
      // (Updated in place: four players' poses 30 times a second shouldn't make garbage.)
      for (let i = 0; i < COUNT; i++) {
        const j = landmarks[i];
        const [sx, sy] = filters.screen[i], [bx, by, bz] = filters.body[i];
        const screen = pose.screen[i], body = pose.body[i], velocity = pose.velocity[i];
        screen.x = sx.next(1 - j.x, capturedAt);
        screen.y = sy.next(j.y, capturedAt);
        body.x = bx.next(((hip.x - j.x) * aspect) / torso, capturedAt);
        body.y = by.next((hip.y - j.y) / torso, capturedAt);
        body.z = bz.next((-j.z * aspect) / torso, capturedAt);
        velocity.x = bx.velocity; velocity.y = by.velocity; velocity.z = bz.velocity;
        pose.jointConfidence[i] = raw[i].confidence ?? 1;
      }
      const [ox, oy] = filters.offset;
      pose.offset.x = ox.next(((base.x - hip.x) * aspect) / torso, capturedAt);
      pose.offset.y = oy.next((base.y - hip.y) / torso, capturedAt);
      pose.offsetVelocity.x = ox.velocity;
      pose.offsetVelocity.y = oy.velocity;
      pose.confidence = [11, 12, 23, 24].reduce((sum, i) => sum + (raw[i].confidence ?? 1), 0) / 4;
      pose.capturedAt = Math.max(pose.capturedAt, capturedAt);
      pose.samples++;
    },
    update(now) {
      pose.present = now - lastSeen <= PRESENT_MS;
      pose.ageMs = now - pose.capturedAt;
      if (!pose.present) {
        for (const v of [...pose.velocity, pose.offsetVelocity]) { v.x = 0; v.y = 0; v.z = 0; }
      }
    },
  };
}
