// What the game does with each pose result, from the worker's detections to a player record:
// WebcamPoseSource's tracker step (and the player count it gives the worker), the frame-age drop,
// and GameSession's setup (WebcamCalibration and the line-up retry). The game's own modules do
// the work; this only calls them in the game's order with the game's clocks.
import { PlayerTracker } from '../../../packages/pose/browser/tracker.ts';
import type { DetectedLandmark } from '../../../packages/pose/browser/slots.ts';
import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';
import { WebcamCalibration } from '../../../apps/web/src/game/webcamCalibration.ts';
import { SETUP_TRACKING_REFRESH_MS } from '../../../apps/web/src/game/GameSession.ts';
import type { CalibState, DetFrame, Joint, TrackedFrame } from './common.ts';

/** WebcamPoseSource drops a result whose frame is this old when it arrives. */
export const MAX_FRAME_AGE_MS = 500;

export interface GameLoopOptions {
  /**
   * Simulate GameSession's setup: calibration, and the line-up retry (a fresh tracker after four
   * seconds without a calibration hold) until calibration completes. The retry stops at
   * danceStartMs, when the song would be playing (default true).
   */
  session?: boolean;
  danceStartMs?: number;
}

/** A detection as the tracker takes it: conf stands for both visibility and presence (the tracker only uses their minimum). */
export const toDetected = (kp: readonly (readonly (number | null)[] | null)[]): DetectedLandmark[] =>
  kp.map(j => j ? { x: j[0]!, y: j[1]!, z: j[2] ?? 0, visibility: j[3] ?? 0, presence: j[3] ?? 0 } : { x: 0, y: 0, z: 0, visibility: 0, presence: 0 });

export const fromPose = (pose: Pose): { playerId: number; kp: Joint[] } =>
  ({ playerId: pose.playerId, kp: pose.landmarks.map(l => [l.x, l.y, l.z, l.confidence] as Joint) });

export class GameLoop {
  readonly playerCount: PlayerCount;
  readonly input: { width: number; height: number };
  readonly session: boolean;
  readonly danceStartMs: number;
  tracker: PlayerTracker;
  calibration: WebcamCalibration;
  /** How many players the last record found: what WebcamPoseSource tells the worker (its strips). */
  players = 0;
  seq = 0;
  refreshAt: number | null = null;
  calibrated = false;
  pendingReset = false;
  constructor(playerCount: number, input: { width: number; height: number }, { session = true, danceStartMs = Infinity }: GameLoopOptions = {}) {
    this.playerCount = playerCount as PlayerCount;
    this.input = input;
    this.session = session;
    this.danceStartMs = danceStartMs;
    // GameSession resets the tracking when it starts; a fresh tracker is the same.
    this.tracker = new PlayerTracker(this.playerCount);
    this.calibration = new WebcamCalibration(this.playerCount);
  }

  /** GameSession.update's setup step at time now: retry a line-up stuck without a calibration hold. */
  tick(now: number) {
    if (!this.session || this.calibrated) return;
    this.refreshAt ??= now;
    if (this.calibration.anchors) this.refreshAt = now;
    else if (now < this.danceStartMs && now - this.refreshAt >= SETUP_TRACKING_REFRESH_MS) {
      this.tracker = new PlayerTracker(this.playerCount);
      this.players = 0;
      this.refreshAt = now;
      this.pendingReset = true;
    }
  }

  /**
   * One worker result: captureMs is the frame's browser time (when the camera delivered it),
   * receivedMs when its result arrived. Returns the record, or a dropped one when it came too late.
   */
  result(frame: number, detections: readonly DetectedLandmark[][], looks: readonly (readonly number[] | null)[] | undefined, captureMs: number, receivedMs: number): TrackedFrame {
    this.tick(receivedMs);
    const reset = this.pendingReset;
    this.pendingReset = false;
    if (receivedMs - captureMs >= MAX_FRAME_AGE_MS) return { frame, t_ms: captureMs, received_ms: receivedMs, poses: [], lined: this.tracker.lined, dropped: true, ...(reset ? { reset } : {}) };
    const poses = this.tracker.update(detections, this.input, captureMs, looks ?? []);
    this.players = poses.length;
    const record: TrackedFrame = { frame, t_ms: captureMs, received_ms: receivedMs, poses: poses.map(fromPose), lined: this.tracker.lined, ...(reset ? { reset } : {}) };
    if (this.session) {
      if (!this.calibrated) {
        this.calibrated = this.calibration.accept({ sessionId: 'trackbench', seq: ++this.seq, poses, input: this.input }, captureMs, receivedMs);
      }
      const c = this.calibration;
      record.calib = { progress: Number(c.progress.toFixed(4)), complete: this.calibrated, hold: !!c.anchors, players: [...c.players] } satisfies CalibState;
    }
    return record;
  }

  /** A detections.jsonl line through the loop (offline: the result arrives when the frame was taken, unless the line says when). */
  replay(line: DetFrame, looks?: readonly (readonly number[] | null)[]): TrackedFrame {
    const received = line.received_ms ?? line.t_ms;
    const detected = line.people.map(p => toDetected(p.kp));
    return this.result(line.frame, detected, looks ?? line.looks, line.t_ms, received);
  }
}
