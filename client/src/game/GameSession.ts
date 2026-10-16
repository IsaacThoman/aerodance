import { createScorer } from '../../../packages/score/scorer.ts';
import type { JudgementEvent, PlayerResult, Scorer } from '../../../packages/score/scorer.ts';
import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';
import { createSongPlayer } from '../audio/songPlayer.ts';
import type { SongPlayer, SongRange } from '../audio/songPlayer.ts';
import { createPoseRecorder } from '../pose/ReplayPoseSource.ts';
import type { PoseRecorder } from '../pose/ReplayPoseSource.ts';
import { isPoseRecordEvent } from '../pose/PoseSource.ts';
import type { DancerRoutine } from '../../../packages/stages/shared/routine.ts';
import type { PoseSource, PoseSourceEvent, SongClock } from '../pose/PoseSource.ts';
import type { LoadedSongBundle } from '../songs/loadBundle.ts';
import { createLivePlayer } from './livePose.ts';
import type { LivePlayer } from './livePose.ts';
import { WebcamCalibration } from './webcamCalibration.ts';
import type { CalibrationStatus } from './webcamCalibration.ts';

/*
 * One play of one song: loading, the ready check, the countdown, the dance, pausing and
 * the results, independent of React and drawing (GameScreen draws it).
 *
 *   loading → calibrating (webcam) → ready → countdown → playing ⇄ paused → finishing → results
 *
 * Everything runs on the song's audible clock (audio/songPlayer.ts): the countdown is the
 * scheduled start, the reference dancers sample it, and every live pose is placed at the
 * song position audible when the camera captured it, so neither rendering nor network
 * delay decides which reference pose a player is compared against.
 *
 * const session = new GameSession({ bundle, playerCount, source });
 * await session.load(); session.update(performance.now()) every frame;
 * session.start(); session.pause(); session.resume(); session.dispose();
 */

export const COUNTDOWN_MS = 3000;
// Live poses can arrive this late (camera and pose-tracking delay) and still count.
export const LATE_ALLOWANCE_MS = 750;
// The ready check: every player tracked and calibrated for this long starts the countdown.
export const READY_HOLD_MS = 1000;
const PRESENT_MS = 400;
// A live pose this far before the song still feeds the first second's movement.
const LEAD_MS = 1000;

export type GamePhase = 'loading' | 'calibrating' | 'ready' | 'countdown' | 'playing' | 'paused' | 'finishing' | 'results' | 'error' | 'disposed';
/** Per player, for the ready check. */
export type Readiness = 'missing' | 'calibrating' | 'ready';
/** The part of a song player (audio/songPlayer.ts) the session drives. */
export type SessionPlayer = Pick<SongPlayer, 'state' | 'ended' | 'timeMs' | 'rawTimeMs' | 'songTimeAt' | 'play' | 'pause' | 'seek' | 'dispose'>;
/** A song for the stage's reference dancers to follow (StageView). */
/** The dancers' routine, plus whether the song is audible (StageView pauses with it). */
export interface SongRoutine extends DancerRoutine {
  playing(): boolean;
}
export interface GameSessionOptions {
  bundle: LoadedSongBundle;
  playerCount: PlayerCount;
  source?: PoseSource | null;
  createPlayer?: (audio: Blob, range: SongRange) => Promise<SessionPlayer>;
  now?: () => number;
  /** Record the players' poses during the song (recordingText on results). */
  record?: boolean;
  /** Start the countdown by itself once everyone is ready. */
  autoStart?: boolean;
}
type SessionPatch = Partial<Pick<GameSession, 'error' | 'pausedAtMs' | 'finishAt' | 'results' | 'recordingText'>>;

export class GameSession {
  bundle: LoadedSongBundle;
  playerCount: PlayerCount;
  source: PoseSource | null;
  createPlayer: (audio: Blob, range: SongRange) => Promise<SessionPlayer>;
  now: () => number;
  recordPoses: boolean;
  autoStart: boolean;
  phase: GamePhase = 'loading';
  error = '';
  player: SessionPlayer | null = null;
  scorer: Scorer;
  webcamCalibration: WebcamCalibration | null;
  live: LivePlayer[];
  /** When each player was last in a record. */
  present: number[];
  readySince: number | null = null;
  acceptFromMs: number;
  finishAt: number | null = null;
  pausedAtMs: number | null = null;
  pausedEntranceMs: number | null = null;
  results: PlayerResult[] | null = null;
  recording: PoseRecorder | null = null;
  recordingText: string | null = null;
  listeners = new Set<(session: GameSession) => void>();
  judgementListeners = new Set<(event: JudgementEvent) => void>();
  offRecords: () => void;
  clock: SongClock;
  constructor({ bundle, playerCount, source = null, createPlayer = createSongPlayer, now = () => performance.now(), record = false, autoStart = true }: GameSessionOptions) {
    this.bundle = bundle; this.playerCount = playerCount; this.source = source; this.createPlayer = createPlayer;
    this.now = now; this.recordPoses = record; this.autoStart = autoStart;
    this.scorer = createScorer(bundle, playerCount);
    this.webcamCalibration = source?.view.sourceKind === 'webcam' ? new WebcamCalibration(playerCount) : null;
    this.live = Array.from({ length: playerCount }, (_, playerId) => createLivePlayer({ playerId, autoCalibrate: !this.webcamCalibration }));
    this.present = Array<number>(playerCount).fill(-Infinity);
    this.acceptFromMs = bundle.song.playableStartMs - LEAD_MS;
    this.scorer.onJudgement((e) => { for (const fn of this.judgementListeners) fn(e); });
    this.offRecords = source?.subscribeRecords((e) => this.onRecord(e)) ?? (() => {});
    this.clock = {
      bundle,
      songTimeAt: (perf) => this.player?.songTimeAt(perf) ?? bundle.song.playableStartMs,
      perfAtSong: (ms) => this.now() - ((this.player?.rawTimeMs() ?? ms) - ms),
      playing: () => this.player?.state === 'playing',
    };
  }

  onChange(fn: (session: GameSession) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  onJudgement(fn: (event: JudgementEvent) => void) { this.judgementListeners.add(fn); return () => { this.judgementListeners.delete(fn); }; }
  set(phase: GamePhase, patch: SessionPatch = {}) {
    Object.assign(this, patch, { phase });
    for (const fn of this.listeners) fn(this);
  }

  async load() {
    const { song } = this.bundle;
    try {
      const player = await this.createPlayer(this.bundle.audio, { startMs: song.playableStartMs, endMs: song.playableEndMs });
      if (this.phase === 'disposed') { player.dispose(); return; }
      this.player = player;
      this.set(this.webcamCalibration ? 'calibrating' : 'ready');
    } catch {
      if (this.phase !== 'disposed') this.set('error', { error: 'This browser could not decode the song audio.' });
    }
  }

  /** The loaded song player; only called in phases that come after loading. */
  loaded(): SessionPlayer {
    if (!this.player) throw Error('The song has not loaded');
    return this.player;
  }

  /** Per player: 'missing' (not in view), 'calibrating' (in view, settling) or 'ready'. */
  readiness(now = this.now()): Readiness[] {
    return this.live.map((p, id) => (now - this.present[id] > PRESENT_MS ? 'missing' : p.calibration ? 'ready' : 'calibrating'));
  }

  calibrationStatus(now = this.now()): CalibrationStatus | null { return this.webcamCalibration?.status(now) ?? null; }

  onRecord(event: PoseSourceEvent) {
    if (!isPoseRecordEvent(event)) return;
    const { record, captureBrowserTimeMs } = event;
    if (record.type !== 'pose' || record.playerCount !== this.playerCount) return;
    const now = this.now();
    for (let id = 0; id < this.playerCount; id++) {
      const pose = record.poses.find((p) => p.playerId === id);
      if (!pose) continue;
      this.present[id] = now;
      this.live[id].push(pose.landmarks, record.input, now);
    }
    if (this.webcamCalibration && ['calibrating', 'ready'].includes(this.phase)) {
      if (this.webcamCalibration.accept(record, captureBrowserTimeMs, now)) {
        this.webcamCalibration.tracks?.forEach((profile, id) => {
          if (this.live[id].calibration !== profile) this.live[id].setCalibration(profile);
        });
        if (this.phase !== 'ready') this.set('ready');
      } else if (this.phase === 'ready' && !this.webcamCalibration.status(now).complete) {
        this.live.forEach(p => p.setCalibration(null));
        this.set('calibrating');
      }
    }
    if (!['countdown', 'playing', 'finishing'].includes(this.phase) || !Number.isFinite(captureBrowserTimeMs)) return;
    const player = this.loaded();
    if (player.state !== 'playing') return;
    const songMs = player.songTimeAt(captureBrowserTimeMs);
    if (songMs <= this.acceptFromMs || songMs > this.bundle.song.playableEndMs + LATE_ALLOWANCE_MS) return;
    const aspect = record.input.width / record.input.height;
    for (const pose of record.poses) {
      if (pose.playerId < this.playerCount) this.scorer.addSample(pose.playerId, songMs, pose.landmarks, aspect);
    }
  }

  /** The smoothed live pose to draw for a player (null hides their character). */
  livePose(id: number, now = this.now()): Pose | null {
    return this.live[id]?.frame(now, now - this.present[id] <= PRESENT_MS) ?? null;
  }

  /** Starts the countdown; the song and the dancers begin together when it reaches zero. */
  start() {
    if (this.phase !== 'ready') return;
    if (this.webcamCalibration && !this.webcamCalibration.status(this.now()).complete) return;
    const player = this.loaded();
    this.source?.attachSong?.(this.clock);
    if (this.recordPoses && this.source) {
      this.recording = createPoseRecorder(this.source, { songId: this.bundle.song.songId, songTimeAt: (perf) => player.songTimeAt(perf), playerCount: this.playerCount });
    }
    player.play({ delayMs: COUNTDOWN_MS });
    this.set('countdown');
  }

  /** Milliseconds until the song (re)starts, during the countdown. */
  countdownMs() {
    if (this.phase !== 'countdown') return 0;
    return Math.max(0, this.resumeFromMs() - this.loaded().rawTimeMs());
  }
  resumeFromMs() { return this.pausedAtMs ?? this.bundle.song.playableStartMs; }

  /** Entrance time relative to the first audible beat; held while paused or resuming. */
  entranceTimeMs(): number {
    // pause() always sets pausedEntranceMs before the paused phase.
    if (this.phase === 'paused') return this.pausedEntranceMs ?? -Infinity;
    if (this.phase === 'countdown') return this.pausedEntranceMs !== null && this.pausedEntranceMs >= 0 ? this.pausedEntranceMs : -this.countdownMs();
    if (this.phase === 'playing' || this.phase === 'finishing') return this.loaded().timeMs() - this.bundle.song.playableStartMs;
    return -Infinity;
  }

  pause() {
    if (!['countdown', 'playing'].includes(this.phase)) return;
    this.pausedEntranceMs = this.entranceTimeMs();
    const player = this.loaded();
    const at = this.phase === 'countdown' ? this.resumeFromMs() : player.timeMs();
    player.pause();
    player.seek(at);
    // Poses from after this point would be compared against a song that stopped.
    this.scorer.discardAfter(at);
    this.acceptFromMs = Math.max(this.acceptFromMs, at);
    this.set('paused', { pausedAtMs: at });
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.loaded().play({ delayMs: COUNTDOWN_MS });
    this.set('countdown');
  }

  update(now = this.now()) {
    const { phase, player } = this;
    if (this.webcamCalibration && ['calibrating', 'ready'].includes(phase)) {
      const { complete } = this.webcamCalibration.status(now);
      if (phase === 'ready' && !complete) {
        this.live.forEach(p => p.setCalibration(null));
        this.set('calibrating');
      } else if (phase === 'ready' && this.autoStart) this.start();
    } else if (phase === 'ready') {
      const ready = this.readiness(now).every((r) => r === 'ready');
      this.readySince = ready ? this.readySince ?? now : null;
      if (this.autoStart && this.readySince !== null && now - this.readySince >= READY_HOLD_MS) this.start();
    } else if (phase === 'countdown' && player) {
      if (player.rawTimeMs() >= this.resumeFromMs()) this.set('playing');
    } else if (phase === 'playing' && player) {
      this.scorer.advance(player.timeMs() - LATE_ALLOWANCE_MS);
      if (player.ended) this.set('finishing', { finishAt: now + LATE_ALLOWANCE_MS });
    } else if (phase === 'finishing' && this.finishAt !== null && now >= this.finishAt) {
      this.scorer.finish();
      this.source?.attachSong?.(null);
      const recording = this.recording?.stop() ?? null;
      this.recording = null;
      this.set('results', { results: this.scorer.results(), recordingText: recording });
    }
  }

  /** The reference dancers' routine for StageView. */
  routine(): Required<SongRoutine> {
    return {
      bundle: this.bundle,
      playerCount: this.playerCount,
      timeMs: () => this.player?.timeMs() ?? this.bundle.song.playableStartMs,
      playing: () => this.player?.state === 'playing',
      entranceTimeMs: () => this.entranceTimeMs(),
    };
  }

  dispose() {
    this.offRecords();
    this.source?.attachSong?.(null);
    this.recording?.stop();
    this.player?.dispose();
    this.listeners.clear();
    this.judgementListeners.clear();
    this.phase = 'disposed';
  }
}
