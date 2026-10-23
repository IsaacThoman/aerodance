import { calibratePoses, reliableBodyPose } from '../../../../packages/character/calibration.ts';
import type { FrameSize, Landmark, PlayerCount, Pose, TrackCalibration } from '../../../../packages/pose/choreography.ts';
import type { LivePoseRecord } from '../pose/PoseSource.ts';

/** Per player: not in view, body not fully visible, moved, holding still, or calibrated. */
export type CalibrationPlayerStatus = 'missing' | 'body' | 'moving' | 'holding' | 'ready';
export interface CalibrationStatus { players: CalibrationPlayerStatus[]; progress: number; complete: boolean; }
/** What calibration reads from a pose record. */
export type CalibrationRecord = Pick<LivePoseRecord, 'sessionId' | 'seq' | 'poses'> & { input: FrameSize };

export const WEBCAM_STILL_MS = 2500;
export const WEBCAM_FRAME_GAP_MS = 400;
/** A player the model misses for no longer than this, once everyone is holding still, is still holding. */
export const WEBCAM_MISS_MS = 200;
const MIN_SAMPLES = 6;
const MOVEMENT_TOLERANCE = 0.15; // Fraction of the initial torso length, independent of camera distance.
const BODY = [11, 12, 23, 24, 27, 28];
const WRISTS = [15, 16];
const reliable = (j: Landmark | undefined) => !!j && (j.confidence ?? 0) >= 0.5;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
const mid = (p: readonly Landmark[], a: number, b: number) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 });

/** A shared stillness window; only new camera frames advance it, never render ticks. */
export class WebcamCalibration {
  playerCount: PlayerCount;
  boundary: string | null = null;
  seq: number | null = null;
  lastCapture = -Infinity;
  lastReceived = -Infinity;
  startedAt: number | null = null;
  anchors: Pose[] | null = null;
  frames: Pose[][] = [];
  /** When each player was last in view holding still. */
  seen: number[] = [];
  players: CalibrationPlayerStatus[] = [];
  progress = 0;
  /** One calibration per player, once everyone has held still. */
  tracks: TrackCalibration[] | null = null;
  constructor(playerCount: PlayerCount) {
    this.playerCount = playerCount;
    this.resetHold();
  }

  resetHold(players: CalibrationPlayerStatus[] = Array<CalibrationPlayerStatus>(this.playerCount).fill('missing')) {
    this.startedAt = null;
    this.anchors = null;
    this.frames = Array.from({ length: this.playerCount }, () => []);
    this.seen = Array<number>(this.playerCount).fill(-Infinity);
    this.players = players;
    this.progress = 0;
    this.tracks = null;
  }

  accept(record: CalibrationRecord, captureTime: number, now: number) {
    const boundary = `${record.sessionId}|${record.input.width}|${record.input.height}`;
    if (boundary !== this.boundary) {
      this.boundary = boundary;
      this.seq = null;
      this.lastCapture = -Infinity;
      this.lastReceived = -Infinity;
      this.resetHold();
    }
    this.status(now);
    if (!Number.isFinite(captureTime) || captureTime > now || now - captureTime > WEBCAM_FRAME_GAP_MS) return false;
    if ((this.seq !== null && record.seq <= this.seq) || captureTime <= this.lastCapture) return false;
    this.seq = record.seq;
    if (captureTime - this.lastCapture > WEBCAM_FRAME_GAP_MS) this.resetHold();
    this.lastCapture = captureTime;
    this.lastReceived = now;
    if (this.tracks) return true;

    const found = Array.from({ length: this.playerCount }, (_, id) => record.poses.find(p => p.playerId === id));
    // (Somebody holding still whom the model misses for a moment hasn't moved.)
    const players = found.map((p, id): CalibrationPlayerStatus => !p ? (this.anchors && captureTime - this.seen[id] <= WEBCAM_MISS_MS ? 'holding' : 'missing')
      : reliableBodyPose(p) ? 'holding' : 'body');
    if (players.some(p => p !== 'holding')) {
      this.resetHold(players);
      return false;
    }

    const aspect = record.input.width / record.input.height;
    const { anchors } = this;
    if (anchors) {
      found.forEach((pose, id) => {
        if (!pose) return;
        const p = pose.landmarks, anchor = anchors[id].landmarks;
        const tolerance = Math.max(0.02, distance(mid(anchor, 11, 12), mid(anchor, 23, 24), aspect)) * MOVEMENT_TOLERANCE;
        const joints = [...BODY, ...WRISTS.filter(i => reliable(p[i]) && reliable(anchor[i]))];
        if (joints.some(i => distance(p[i], anchor[i], aspect) > tolerance)) players[id] = 'moving';
      });
      if (players.includes('moving')) {
        this.resetHold(players);
        return false;
      }
    } else {
      // Everyone is in view (nobody is missed before a hold starts): one pose per player, in player order.
      this.anchors = found.filter((p): p is Pose => p !== undefined);
      this.startedAt = captureTime;
    }

    this.players = players;
    found.forEach((pose, id) => { if (pose) { this.frames[id].push(pose); this.seen[id] = captureTime; } });
    this.progress = Math.min(1, (captureTime - (this.startedAt ?? captureTime)) / WEBCAM_STILL_MS);
    if (this.progress < 1 || this.frames.some(frames => frames.length < MIN_SAMPLES)) return false;
    this.tracks = this.frames.map(frames => calibratePoses(frames, record.input, { adaptiveDistance: true }));
    this.players = Array(this.playerCount).fill('ready');
    return true;
  }

  status(now: number): CalibrationStatus {
    if (now - this.lastReceived > WEBCAM_FRAME_GAP_MS && (this.anchors || this.players.some(p => p !== 'missing'))) this.resetHold();
    return { players: this.players, progress: this.progress, complete: this.tracks !== null };
  }
}
