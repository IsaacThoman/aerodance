import type { PlayerCount, Pose, TrackCalibration } from '../../../../packages/pose/choreography.ts';
import { isPoseRecordEvent } from '../pose/PoseSource.ts';
import type { PoseSource, PoseSourceEvent } from '../pose/PoseSource.ts';
import { createLivePlayer } from '../game/livePose.ts';
import type { LivePlayer } from '../game/livePose.ts';
import { SETUP_TRACKING_REFRESH_MS } from '../game/GameSession.ts';
import { WebcamCalibration } from '../game/webcamCalibration.ts';
import type { CalibrationStatus } from '../game/webcamCalibration.ts';
import { createPoseFollower } from './pose/body.ts';
import type { PlayerPose, PoseFollower } from './pose/body.ts';
import { createGestureSet, handRaised } from './pose/gestures.ts';
import type { GestureDetector, GestureEvent } from './pose/gestures.ts';
import type { MinigameComponent, MinigameContext, MinigameDefinition, MinigameFrame, MinigameOutcome, MinigamePhase } from './types.ts';

/*
 * One round of one minigame, independent of React and drawing (MinigameScreen draws it, App
 * mounts the game). It owns everything around the game (types.ts):
 *
 *   loading      the game's code downloads (definition.load)
 *   calibrating  with a live camera: every player in view holds still together for 2.5 seconds
 *                (game/webcamCalibration.ts, the song game's), which measures each one's body;
 *                shoulders and hips in view are enough, unless the game wants feet (fullBody)
 *   howto        the game's how-to card, until Start or a player holds a hand up for a moment
 *   countdown    3, 2, 1 (and again after a pause)
 *   playing      the game's clock runs (timeMs), the HUD shows scores, a timed round ends itself
 *   paused       the clock holds; resume() counts down again
 *   finishing    "Time's up" for a moment, then
 *   results      the scores, set
 *
 * Poses come from the same records the song game scores (pose/PoseSource.ts): each player's
 * pose follower (pose/body.ts) and gesture detectors (pose/gestures.ts) take every record, at
 * the camera frame's capture time; their events reach the game a frame at a time (frame()).
 * Replays (?input=ghost) skip calibrating: their players calibrate themselves as they go.
 *
 * const session = new MinigameSession({ game, playerCount, source });
 * await session.load(); every frame: session.advance(performance.now());  // update(), then tick = frame()
 * session.start(); session.pause(); session.resume(); session.finish(); session.dispose();
 */

export const COUNTDOWN_MS = 3000;
/** How long "Time's up" shows before the results. */
export const FINISH_MS = 1400;
/** A hand held up this long on the how-to card starts the countdown. */
export const RAISE_START_MS = 800;
const PRESENT_MS = 400;

export interface MinigameSessionOptions {
  game: MinigameDefinition;
  playerCount: PlayerCount;
  source?: PoseSource | null;
  now?: () => number;
}
type Listener = (session: MinigameSession) => void;
let sessions = 0;

export class MinigameSession implements MinigameContext {
  /** Different for every round (a fresh mount of its game, even for Play again). */
  readonly key = ++sessions;
  game: MinigameDefinition;
  playerCount: PlayerCount;
  source: PoseSource | null;
  now: () => number;
  current: MinigamePhase = 'loading';
  error = '';
  component: MinigameComponent | null = null;
  calibrationHold: WebcamCalibration | null;
  trackingRefreshAt: number;
  followers: PoseFollower[];
  players: PlayerPose[];
  /** The players' glass characters' poses (game/livePose.ts: smoothed for display). */
  live: LivePlayer[];
  gestures: GestureDetector[];
  /** When each player was last in a record. */
  present: number[];
  /** Gestures since the last frame, and this frame's for the game. */
  pending: GestureEvent[] = [];
  events: GestureEvent[] = [];
  /** This frame, as the game's frame callbacks get it (advance() makes it). */
  tick: MinigameFrame | null = null;
  lastGesture: GestureEvent | null = null;
  /** When a hand went up on the how-to card (any player), for raise-to-start. */
  raisedSince: number | null = null;
  /** The countdown's start; the clock's play so far and when it last moved. */
  countdownAt = 0;
  playedMs = 0;
  clockAt: number | null = null;
  lastFrameAt: number | null = null;
  finishAt: number | null = null;
  /** Each player's score. */
  scoreList: number[];
  /** The final scores, once the results are in. */
  results: number[] | null = null;
  /** The players play as a team this round (the definition's coop, or setCoop). */
  coop: boolean;
  /** How the game said the round ended (finish()'s outcome), if it did. */
  outcome: MinigameOutcome | null = null;
  /** The game's own reported state (report()), as data-mg-* keys. */
  reported: Record<string, string> = {};
  listeners = new Set<Listener>();
  offRecords: () => void;
  constructor({ game, playerCount, source = null, now = () => performance.now() }: MinigameSessionOptions) {
    this.game = game; this.playerCount = playerCount; this.source = source; this.now = now;
    this.coop = !!game.coop;
    this.trackingRefreshAt = now();
    // Live cameras calibrate; replays already know where everyone stands.
    // (Feet only for the games that want them: a living room's camera often can't see them.)
    this.calibrationHold = source && source.view.sourceKind !== 'replay' ? new WebcamCalibration(playerCount, { feet: !!game.fullBody }) : null;
    if (this.calibrationHold) source?.resetTracking?.();
    this.followers = Array.from({ length: playerCount }, (_, id) => createPoseFollower(id));
    this.players = this.followers.map((f) => f.pose);
    this.live = Array.from({ length: playerCount }, (_, playerId) => createLivePlayer({ playerId, autoCalibrate: !this.calibrationHold }));
    this.gestures = this.followers.map(() => createGestureSet());
    this.present = Array<number>(playerCount).fill(-Infinity);
    this.scoreList = Array<number>(playerCount).fill(0);
    this.offRecords = source?.subscribeRecords((e) => this.onRecord(e)) ?? (() => {});
  }

  onChange(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  set(phase: MinigamePhase) {
    if (this.current === 'disposed') return;
    this.current = phase;
    for (const fn of this.listeners) fn(this);
  }
  phase() { return this.current; }

  /** Fetches the game; then calibration (a live camera) or its how-to card. */
  async load() {
    try {
      const module = await this.game.load();
      if (this.current === 'disposed') return;
      this.component = module.default;
      this.set(this.calibrationHold ? 'calibrating' : 'howto');
    } catch (error) {
      this.fail(`${this.game.title} couldn't load. ${error instanceof Error ? error.message : ''}`.trim());
    }
  }
  /** The game broke (it wouldn't load, or crashed): the screen says so and offers the way out. */
  fail(message: string) {
    if (this.current === 'disposed') return;
    this.error = message;
    this.set('error');
  }

  calibrationStatus(now = this.now()): CalibrationStatus | null { return this.calibrationHold?.status(now) ?? null; }
  /** Which players are in view (seen in the last PRESENT_MS). */
  /** Who is in view: seen within the last `within` ms (PRESENT_MS, as the games see it; the HUD's nudges wait longer). */
  presence(now = this.now(), within = PRESENT_MS) { return this.present.map((at) => now - at <= within); }

  onRecord(event: PoseSourceEvent) {
    if (!isPoseRecordEvent(event)) return;
    const { record, captureBrowserTimeMs } = event;
    if (record.type !== 'pose' || record.playerCount !== this.playerCount || !['calibrating', 'howto', 'countdown', 'playing', 'paused', 'finishing'].includes(this.current)) return;
    const now = this.now();
    const captured = Number.isFinite(captureBrowserTimeMs) ? captureBrowserTimeMs : now;
    for (const pose of record.poses) {
      const id = pose.playerId;
      if (id >= this.playerCount) continue;
      this.present[id] = now;
      this.live[id].push(pose.landmarks, record.input, now);
      this.followers[id].push(pose.landmarks, record.input, captured);
      const happened = this.gestures[id].update(this.followers[id].pose);
      if (happened.length) this.lastGesture = happened.at(-1)!;
      if (this.current === 'playing') this.pending.push(...happened);
    }
    if (this.calibrationHold && this.current === 'calibrating' && this.calibrationHold.accept(record, captured, now)) {
      this.calibrationHold.tracks?.forEach((track, id) => this.calibrate(id, track));
      this.set('howto');
    }
  }
  calibrate(id: number, track: TrackCalibration) {
    this.followers[id].setCalibration(track);
    this.live[id].setCalibration(track);
  }

  /** Every frame: the clock, presence, raise-to-start, the countdown, a timed round's end. */
  update(now = this.now()) {
    for (const f of this.followers) f.update(now);
    const phase = this.current;
    if (phase === 'calibrating' && this.calibrationHold) {
      // A line-up the tracker hasn't settled retries, as the song game's does.
      if (this.calibrationHold.anchors) this.trackingRefreshAt = now;
      else if (now - this.trackingRefreshAt >= SETUP_TRACKING_REFRESH_MS) {
        this.source?.resetTracking?.();
        this.trackingRefreshAt = now;
        this.present.fill(-Infinity);
      }
    } else if (phase === 'howto') {
      const raised = this.players.some((p) => p.present && (handRaised(p, 'left') || handRaised(p, 'right')));
      this.raisedSince = raised ? this.raisedSince ?? now : null;
      if (this.raisedSince !== null && now - this.raisedSince >= RAISE_START_MS) this.start();
    } else if (phase === 'countdown') {
      if (now - this.countdownAt >= COUNTDOWN_MS) { this.clockAt = now; this.set('playing'); }
    } else if (phase === 'playing') {
      if (this.clockAt !== null) this.playedMs += Math.max(0, now - this.clockAt);
      this.clockAt = now;
      if (this.game.durationMs && this.playedMs >= this.game.durationMs) {
        this.playedMs = this.game.durationMs;
        this.finish();
      }
    } else if (phase === 'finishing' && this.finishAt !== null && now >= this.finishAt) {
      this.results = [...this.scoreList];
      this.set('results');
    }
  }

  /** Each frame, before the game's: update(), then this frame for the game (tick). */
  advance(now = this.now()) {
    this.update(now);
    this.tick = this.frame(now);
    return this.tick;
  }

  /** This frame for the game: its clock and the players' gestures since the last one. */
  frame(now = this.now()): MinigameFrame {
    const playing = this.current === 'playing';
    const dt = playing && this.lastFrameAt !== null ? Math.min(0.1, Math.max(0, now - this.lastFrameAt) / 1000) : 0;
    this.lastFrameAt = playing ? now : null;
    this.events = this.pending;
    this.pending = [];
    return { dt, now, phase: this.current, timeMs: this.playedMs, players: this.players, events: this.events };
  }

  /** From the how-to card: the countdown starts. */
  start() {
    if (this.current !== 'howto') return;
    this.raisedSince = null;
    this.countdownAt = this.now();
    this.set('countdown');
  }
  pause() {
    if (this.current !== 'countdown' && this.current !== 'playing') return;
    if (this.current === 'playing' && this.clockAt !== null) this.playedMs += Math.max(0, this.now() - this.clockAt);
    this.clockAt = null;
    this.set('paused');
  }
  resume() {
    if (this.current !== 'paused') return;
    this.countdownAt = this.now();
    for (const g of this.gestures) g.reset();
    this.set('countdown');
  }

  // ---------- The game's side (MinigameContext) ----------

  timeMs() { return this.playedMs; }
  remainingMs() { return this.game.durationMs ? Math.max(0, this.game.durationMs - this.playedMs) : Infinity; }
  scores() { return this.scoreList; }
  setScore(player: number, score: number) {
    if (player < 0 || player >= this.playerCount || !Number.isFinite(score) || this.results) return;
    this.scoreList[player] = score;
  }
  setCoop(coop: boolean) { if (!this.results) this.coop = coop; }
  addScore(player: number, points: number) { this.setScore(player, (this.scoreList[player] ?? 0) + points); }
  finish(scores?: readonly number[], outcome?: MinigameOutcome) {
    if (this.current !== 'playing' && this.current !== 'paused' && this.current !== 'countdown') return;
    if (scores) scores.slice(0, this.playerCount).forEach((s, i) => this.setScore(i, s));
    this.outcome = outcome ?? null;
    this.clockAt = null;
    this.finishAt = this.now() + FINISH_MS;
    this.set('finishing');
  }
  livePose(player: number, now = this.now()): Pose | null {
    return this.live[player]?.frame(now, now - this.present[player] <= PRESENT_MS) ?? null;
  }
  calibration(player: number) { return this.live[player]?.calibration ?? null; }
  report(state: Record<string, string | number | boolean | null>) {
    for (const [key, value] of Object.entries(state)) {
      const name = `mg${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      if (value === null) delete this.reported[name];
      else this.reported[name] = String(value);
    }
  }

  dispose() {
    this.offRecords();
    this.listeners.clear();
    this.current = 'disposed';
  }
}
