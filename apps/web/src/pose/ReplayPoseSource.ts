import { sampleSong } from '../../../../packages/pose/song.ts';
import { isObject, isPlayerCount } from '../../../../packages/pose/choreography.ts';
import { EXTENSION, buildFrames, decodePoseFile, encodePoseFile, framesToPoses } from '../../../../packages/pose/binary.ts';
import type { FrameInput } from '../../../../packages/pose/binary.ts';
import type { CaptureInput, Landmark, PlayerCount, Pose } from '../../../../packages/pose/choreography.ts';
import type { PoseRecordEvent, RecordTiming } from '../../../../packages/pose/browser/WebcamPoseSource.ts';
import { isPoseRecordEvent } from './PoseSource.ts';
import type { LivePoseRecord, PoseInputView, PoseSource, SongClock } from './PoseSource.ts';

/*
 * A pose source that plays back poses instead of tracking anyone, with the same surface as
 * the webcam source (subscribe, subscribeRecords, setPlayerCount, connect, disconnect), so
 * the game, its tests and demos run without a camera.
 *
 *   ghost       dances the song's own choreography (each player copies their track), with
 *               a little tracking noise and an optional lag: an autoplay that should score
 *               near the top, or lower with ?ghostLagMs=400.
 *   recording   replays a pose recording (createPoseRecorder) made during a real song, at
 *               the song times the poses were captured.
 *
 * Without a song attached (the menus) the players stand still in their camera lanes. The game
 * attaches the song while it plays: attachSong({ bundle, songTimeAt(perfMs), perfAtSong(ms),
 * playing() }) and attachSong(null) after.
 */

const RATE_HZ = 10;
const STALE_MS = 500;
const ASPECT_INPUT: CaptureInput = { width: 640, height: 480, mirrored: false };

export type ReplayMode = 'ghost' | 'recording';
export interface ReplayView extends PoseInputView {
  status: 'connected' | 'disconnected';
  sourceKind: 'replay';
  snapshot: LivePoseRecord | null;
  timing: RecordTiming;
  model: 'replay';
}
/** A pose recording's session details: the file's player slots and provenance. */
export interface PoseRecordingHeader {
  songId: string; playerCount: PlayerCount; recordedAt: string;
  /** How the source timed its frames (RecordTiming.method). */
  timing: string | null;
}
/** What a recording keeps of each record: enough to replay it. */
export type RecordedPose = Pick<LivePoseRecord, 'type' | 'input' | 'poses'>;
export interface PoseRecordingEntry { songTimeMs: number; record: RecordedPose; }
export interface PoseRecording { header: PoseRecordingHeader; entries: PoseRecordingEntry[]; }
export interface ReplayPoseSourceOptions {
  now?: () => number;
  mode?: ReplayMode;
  recording?: PoseRecording | null;
  /** The ghost dances this far behind the routine. */
  lagMs?: number;
  /** Tracking noise (image units, standard deviation). */
  noise?: number;
  seed?: number;
}

/** A relaxed standing pose centred at image x = cx (unmirrored: the person's left is image right). */
export function standingPose(cx: number): Landmark[] {
  const at = (dx: number, y: number): Landmark => ({ x: cx + dx, y, z: 0, confidence: 0.99 });
  const lm: Landmark[] = [];
  lm[0] = at(0, 0.2);
  ([[1, 0.012], [2, 0.02], [3, 0.028]] as const).forEach(([i, dx]) => { lm[i] = at(dx, 0.19); lm[i + 3] = at(-dx, 0.19); });
  lm[7] = at(0.035, 0.2); lm[8] = at(-0.035, 0.2);
  lm[9] = at(0.012, 0.225); lm[10] = at(-0.012, 0.225);
  for (const [i, dx, y] of [[11, 0.07, 0.32], [13, 0.085, 0.44], [15, 0.09, 0.55], [17, 0.095, 0.58], [19, 0.09, 0.59], [21, 0.08, 0.57],
    [23, 0.045, 0.56], [25, 0.05, 0.72], [27, 0.05, 0.88], [29, 0.048, 0.9], [31, 0.06, 0.91]]) {
    lm[i] = at(dx, y);
    lm[i + 1] = at(-dx, y);
  }
  return lm;
}

function gaussian(rnd: () => number) {
  return Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
}

/** Reads a pose recording file (createPoseRecorder): a `recording` .adpose on the song clock. */
export function parseRecording(bytes: Uint8Array): PoseRecording {
  const f = decodePoseFile(bytes), prov = f.provenance;
  if (f.kind !== 'recording' || !isObject(prov) || typeof prov.songId !== 'string' || typeof prov.recordedAt !== 'string')
    throw Error('Unsupported pose recording');
  const header: PoseRecordingHeader = { songId: prov.songId, playerCount: f.playerSlots, recordedAt: prov.recordedAt,
    timing: typeof prov.timing === 'string' ? prov.timing : null };
  const input: CaptureInput = { width: f.input.width, height: f.input.height, mirrored: false };
  const entries = Array.from(f.times, (songTimeMs, i): PoseRecordingEntry => ({
    songTimeMs, record: { type: 'pose', input, poses: framesToPoses(f, i).poses },
  }));
  return { header, entries };
}

type RecordListener = (event: PoseRecordEvent<LivePoseRecord>) => void;

export class ReplayPoseSource implements PoseSource {
  now: () => number;
  mode: ReplayMode;
  recording: PoseRecording | null;
  lagMs: number;
  noise: number;
  listeners = new Set<(view: ReplayView) => void>();
  recordListeners = new Set<RecordListener>();
  playerCount: PlayerCount = 1;
  song: SongClock | null = null;
  seq = 0;
  cursor = 0;
  last: LivePoseRecord | null = null;
  lastAt: number | null = null;
  timer: ReturnType<typeof setInterval> | null = null;
  rnd: () => number;
  view: ReplayView;
  constructor({ now = () => performance.now(), mode = 'ghost', recording = null, lagMs = 0, noise = 0.006, seed = 7 }: ReplayPoseSourceOptions = {}) {
    this.now = now; this.mode = mode; this.recording = recording; this.lagMs = lagMs; this.noise = noise;
    let s = seed;
    this.rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    this.view = { status: 'disconnected', sourceKind: 'replay', message: '', snapshot: null, configuring: false, timing: { method: 'none', uncertaintyMs: null }, model: 'replay' };
  }
  subscribe(listener: (view: ReplayView) => void) {
    this.listeners.add(listener);
    listener(this.view);
    return () => { this.listeners.delete(listener); };
  }
  subscribeRecords(listener: RecordListener) {
    this.recordListeners.add(listener);
    return () => { this.recordListeners.delete(listener); };
  }
  publish(patch: Partial<ReplayView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener(this.view);
  }
  connect() {
    this.disconnect();
    this.publish({ status: 'connected', message: this.mode === 'ghost' ? 'Autoplay ghost: the dancers copy the routine.' : 'Replaying a pose recording.', timing: { method: 'replay', uncertaintyMs: 0 } });
    this.timer = setInterval(() => this.tick(), 1000 / RATE_HZ / 2);
  }
  disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.last = null;
    this.publish({ status: 'disconnected', snapshot: null, message: '' });
  }
  async setPlayerCount(count: PlayerCount) {
    if (!isPlayerCount(count)) throw Error('Choose one to four players');
    this.playerCount = count;
    this.last = null;
    this.publish({ snapshot: null });
  }
  attachSong(song: SongClock | null) {
    this.song = song;
    this.cursor = 0;
  }
  emit(poses: Pose[], captureBrowserTimeMs: number, input = ASPECT_INPUT) {
    const record: LivePoseRecord = { type: 'pose', sessionId: 'replay', seq: ++this.seq, playerCount: this.playerCount, input, poses };
    const receivedBrowserTimeMs = this.now();
    this.last = record;
    this.lastAt = receivedBrowserTimeMs;
    for (const listener of this.recordListeners) listener({ record, receivedBrowserTimeMs, captureBrowserTimeMs, timing: this.view.timing });
  }
  jitter(landmarks: Landmark[]) {
    if (!this.noise) return landmarks;
    return landmarks.map((j) => ({ ...j, x: j.x + gaussian(this.rnd) * this.noise, y: j.y + gaussian(this.rnd) * this.noise }));
  }
  standing(): Pose[] {
    // One player per lane; the mirrored preview shows P1 on the left, so P1's lane is on the camera's right.
    return Array.from({ length: this.playerCount }, (_, playerId) => ({ playerId, landmarks: this.jitter(standingPose(1 - (playerId + 0.5) / this.playerCount)) }));
  }
  tick() {
    const now = this.now();
    const song = this.song;
    if (!song) {
      if (this.lastAt === null || now - this.lastAt >= 1000 / RATE_HZ) this.emit(this.standing(), now);
    } else if (this.mode === 'ghost') {
      this.tickGhost(song, now);
    } else {
      this.tickRecording(song, now);
    }
    const snapshot = this.last && this.lastAt !== null && now - this.lastAt < STALE_MS ? this.last : null;
    if (snapshot !== this.view.snapshot) this.publish({ snapshot });
  }
  tickGhost(song: SongClock, now: number) {
    const songNow = song.songTimeAt(now);
    if (this.lastAt !== null && now - this.lastAt < 1000 / RATE_HZ) return;
    const { bundle } = song;
    const { playableStartMs, playableEndMs } = bundle.song;
    // The ghost dances what the coach did lagMs ago, held at the ends of the song.
    const t = Math.min(Math.max(songNow - this.lagMs, playableStartMs), playableEndMs - 1);
    const sample = sampleSong(bundle, t, this.playerCount);
    const poses = sample.poses.length ? sample.poses.map((p) => ({ playerId: p.playerId, landmarks: this.jitter(p.landmarks) })) : this.standing();
    const { inputWidth: width, inputHeight: height } = bundle.choreography.tracks[0].calibration;
    this.emit(poses, now, { width, height, mirrored: false });
  }
  tickRecording(song: SongClock, now: number) {
    if (!song.playing()) return;
    const songNow = song.songTimeAt(now);
    const entries = this.recording?.entries ?? [];
    while (this.cursor < entries.length && entries[this.cursor].songTimeMs <= songNow) {
      const { songTimeMs, record } = entries[this.cursor++];
      const poses = record.poses.filter((p) => p.playerId < this.playerCount);
      this.emit(poses, song.perfAtSong(songTimeMs), record.input);
    }
  }
}

/**
 * Records every pose a source delivers during a song, at the song time it was captured, for
 * replay (ReplayPoseSource 'recording') and scoring research. stop() returns a `recording`
 * .adpose file; extension field 6 keeps each frame's capture time.
 */
export interface PoseRecorderOptions {
  songId: string;
  /** The song position audible at a performance.now() time. */
  songTimeAt: (perfMs: number) => number;
  playerCount: PlayerCount;
}
export interface PoseRecorder {
  /** Stops recording; returns the recording file. */
  stop(): Uint8Array<ArrayBuffer>;
}

export function createPoseRecorder(source: Pick<PoseSource, 'subscribeRecords'>, { songId, songTimeAt, playerCount }: PoseRecorderOptions): PoseRecorder {
  const recordedAt = new Date().toISOString(), frames: FrameInput[] = [];
  let input: CaptureInput | null = null, timing: string | null = null;
  const off = source.subscribeRecords((event) => {
    if (!isPoseRecordEvent(event)) return;
    const { record, captureBrowserTimeMs } = event;
    if (record.type !== 'pose' || !Number.isFinite(captureBrowserTimeMs)) return;
    // The camera geometry and timing method are constant for a session.
    input ??= record.input;
    timing ??= event.timing?.method ?? null;
    frames.push({ timeMs: Math.round(songTimeAt(captureBrowserTimeMs) * 10) / 10,
      poses: record.poses.filter((p) => p.playerId < playerCount),
      extensions: { [EXTENSION.captureBrowserTimeMs]: captureBrowserTimeMs } });
  });
  return {
    stop() {
      off();
      // Frames go in song time order; a frame at an already-recorded time is dropped.
      const ordered = frames.slice().sort((a, b) => a.timeMs - b.timeMs).filter((f, i, all) => !i || f.timeMs > all[i - 1].timeMs);
      return encodePoseFile(buildFrames({
        kind: 'recording', playerSlots: playerCount, input: input ?? { width: 640, height: 480 }, modelId: null,
        extensionIds: [EXTENSION.captureBrowserTimeMs], provenance: { songId, recordedAt, timing },
      }, ordered));
    },
  };
}
