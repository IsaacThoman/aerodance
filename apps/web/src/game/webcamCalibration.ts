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
/** A player the model misses for no longer than this, while holding still, is still holding. */
export const WEBCAM_MISS_MS = 200;
/**
 * Stillness is judged on the median of a player's last few poses (at most WEBCAM_STILL_FILTER
 * from this long before the latest), so one jittery result (the model's, not the player's)
 * doesn't count as moving. Bounded in time, so a slow camera can't hide a move behind older poses.
 */
export const WEBCAM_STILL_FILTER_MS = 300;
export const WEBCAM_STILL_FILTER = 5;
const MIN_SAMPLES = 6;
const MOVEMENT_TOLERANCE = 0.15; // Fraction of the initial torso length, independent of camera distance.
// The joints calibration measures (calibratePoses): shoulders, hips and ankles. Hands don't
// change the calibration, so moving them doesn't restart a hold.
const BODY = [11, 12, 23, 24, 27, 28];
const distance = (a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
const mid = (p: readonly Landmark[], a: number, b: number) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 });
const median = (v: number[]) => { const s = v.toSorted((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** One player's hold: since when, the stance it started from, its samples, and their latest poses. */
interface Hold { startedAt: number | null; anchor: Pose | null; frames: Pose[]; recent: { at: number; pose: Pose }[]; seen: number; }
const freshHold = (): Hold => ({ startedAt: null, anchor: null, frames: [], recent: [], seen: -Infinity });

/**
 * Each player's hold runs on its own: a player who moves, steps out or is missed for long
 * restarts only theirs. Calibration completes at the first moment every player is in view and
 * has held still for long enough; nobody is calibrated before then, so a player who leaves, or
 * a number that passes to somebody else, can't keep an old stance. Only new camera frames
 * advance it, never render ticks; a camera change or a gap in its frames starts everyone afresh.
 */
export class WebcamCalibration {
  playerCount: PlayerCount;
  boundary: string | null = null;
  seq: number | null = null;
  lastCapture = -Infinity;
  lastReceived = -Infinity;
  holds: Hold[] = [];
  /** Every player's stance while they're all holding still, or null. */
  anchors: Pose[] | null = null;
  /** Each player's samples in their current hold. */
  frames: Pose[][] = [];
  players: CalibrationPlayerStatus[] = [];
  /** The slowest player's progress. */
  progress = 0;
  /** One calibration per player, once everyone has held still. */
  tracks: TrackCalibration[] | null = null;
  constructor(playerCount: PlayerCount) {
    this.playerCount = playerCount;
    this.resetHold();
  }

  resetHold(players: CalibrationPlayerStatus[] = Array<CalibrationPlayerStatus>(this.playerCount).fill('missing')) {
    this.holds = Array.from({ length: this.playerCount }, freshHold);
    this.players = players;
    this.tracks = null;
    this.sync();
  }

  /** Recomputes the summary fields from the holds. */
  sync() {
    this.anchors = (this.tracks || this.players.every(p => p === 'holding')) && this.holds.every(h => h.anchor) ? this.holds.map(h => h.anchor!) : null;
    this.frames = this.holds.map(h => h.frames);
    this.progress = this.tracks ? 1 : Math.min(...this.holds.map(h => h.startedAt === null ? 0 : Math.min(1, (this.lastCapture - h.startedAt) / WEBCAM_STILL_MS)));
  }

  /** A player's stance now: the median of their poses over the last WEBCAM_STILL_FILTER_MS. */
  stance(hold: Hold, pose: Pose, at: number): Landmark[] {
    hold.recent = [...hold.recent.filter(r => at - r.at <= WEBCAM_STILL_FILTER_MS), { at, pose }].slice(-WEBCAM_STILL_FILTER);
    if (hold.recent.length === 1) return pose.landmarks;
    return pose.landmarks.map((j, i) => ({ ...j, x: median(hold.recent.map(r => r.pose.landmarks[i].x)), y: median(hold.recent.map(r => r.pose.landmarks[i].y)) }));
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

    const aspect = record.input.width / record.input.height;
    this.players = this.holds.map((hold, id): CalibrationPlayerStatus => {
      const pose = record.poses.find(p => p.playerId === id);
      // (Somebody holding still whom the model misses, or is unsure of, for a moment hasn't moved.)
      const brief = hold.anchor !== null && captureTime - hold.seen <= WEBCAM_MISS_MS;
      if (!pose) {
        if (brief) return 'holding';
        this.holds[id] = freshHold();
        return 'missing';
      }
      if (!reliableBodyPose(pose)) {
        if (brief) return 'holding';
        this.holds[id] = freshHold();
        return 'body';
      }
      const stance = this.stance(hold, pose, captureTime);
      if (hold.anchor) {
        const anchor = hold.anchor.landmarks;
        const tolerance = Math.max(0.02, distance(mid(anchor, 11, 12), mid(anchor, 23, 24), aspect)) * MOVEMENT_TOLERANCE;
        // (A number that passed to somebody else standing elsewhere shows as a move too.)
        if (BODY.some(i => distance(stance[i], anchor[i], aspect) > tolerance)) {
          // Their hold starts again from where they are now.
          this.holds[id] = { ...freshHold(), recent: [{ at: captureTime, pose }] };
          return 'moving';
        }
      } else hold.startedAt = captureTime;
      // The stance a hold is measured from settles over its first few results.
      if (hold.frames.length < 3) hold.anchor = { playerId: id, landmarks: stance };
      hold.frames.push(pose);
      hold.seen = captureTime;
      return 'holding';
    });
    const done = this.players.every(p => p === 'holding')
      && this.holds.every(h => captureTime - h.startedAt! >= WEBCAM_STILL_MS && h.frames.length >= MIN_SAMPLES);
    if (done) {
      this.tracks = this.holds.map(h => calibratePoses(h.frames, record.input, { adaptiveDistance: true }));
      this.players = Array(this.playerCount).fill('ready');
    }
    this.sync();
    return done;
  }

  status(now: number): CalibrationStatus {
    if (now - this.lastReceived > WEBCAM_FRAME_GAP_MS && (this.anchors || this.players.some(p => p !== 'missing'))) this.resetHold();
    return { players: this.players, progress: this.progress, complete: this.tracks !== null };
  }
}
