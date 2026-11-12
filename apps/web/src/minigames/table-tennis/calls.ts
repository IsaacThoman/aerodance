import * as THREE from 'three';
import type { HandTracking } from '../../../../../packages/pose/webcamRecord.ts';
import { PLAYERS } from '../../game/results.ts';
import type { PlayerLook } from '../../game/results.ts';
import type { Face } from '../../ui/draw.ts';
import type { MinigamePhase } from '../types.ts';
import type { AssistLevel } from './assist.ts';
import { deuce, matchPointFor } from './match.ts';
import type { PointReason } from './match.ts';
import type { End } from './rally.ts';
import { BEAT } from './round.ts';
import type { PointWon, Round } from './round.ts';
import { TABLE_Z } from './rig.ts';
import type { Rig } from './rig.ts';

/*
 * What Table Tennis's HUD (Hud.tsx) says, without the drawing, so the tests can follow a round
 * through it (apps/web/tests/table-tennis-hud.test.ts):
 *
 *   calls     each point's, where the ball decided it, in each view: the error that lost it (OUT,
 *             NET, SHORT onto the hitter's own half), the same for everyone; or a shot that won
 *             it, NICE! to the player who hit it (GREAT RALLY! to everyone after a long rally) and
 *             what happened (2 BOUNCES, MISSED) to the other. In Return Challenge, +1 a return
 *   banners   whose point it was, a moment after its call, through the beat before the next serve;
 *             DEUCE and MATCH POINT as that serve is set up; GAME! once the match is won.
 *             Return Challenge: each new level, and the run's end
 *   prompts   how to serve, Swing! once the ball's tossed, whose serve it is; a player's own until
 *             they've served three times (unless they stand at their serve a while), the other
 *             side's until they've seen three
 *   tracking  what isn't all there with the tracking
 *
 * HudModel follows a round frame by frame (observe), keeping what the round doesn't: the calls
 * so far, when each score went up, the banner set for a serve, the serves each player has made
 * and seen, the aim assist's toast.
 */

/** The robot's colours, as a player's (PLAYERS): its orange paint. */
export const ROBOT: PlayerLook = { name: 'Robot', color: '#ff7a2e', light: '#ffc08a', dark: '#b8460f' };
export const GOLD: Face = ['#fff6cc', '#ffd34d', '#f0a500'];
export const CHAMPAGNE: Face = ['#fffaf0', '#f3e2a6', '#c9a85a'];
export const faceOf = (look: PlayerLook): Face => ['#ffffff', look.light, look.color];

/** A banner (s): how long after its point it comes up, and how long one for a new serve or level stays up. */
export const BANNER = { delay: 0.45, hold: 1.8, level: 1.45 } as const;
/** A rally this long shows its chip; a good shot ending one this long is a GREAT RALLY! */
export const RALLY = { shown: 5, great: 8 } as const;
/** Prompts: until a player has served (or seen) this many serves, and again once they've stood at their serve this long (s). */
export const PROMPT = { serves: 3, idle: 5 } as const;
/** How long the aim assist's new level is said (s). */
export const TOAST_S = 1.6;

/** A point's reason (match.ts), as its call says it. */
export const CALL_WORDS: Record<PointReason, string> = { out: 'OUT', net: 'NET', own: 'SHORT', double: '2 BOUNCES', missed: 'MISSED', return: '+1' };
export const ASSIST_LABELS: Record<AssistLevel, string> = { off: 'Off', low: 'Low', normal: 'Normal', high: 'High' };

export interface CallLook { text: string; face: Face; }
/** A point's call: where (the world's frame: the table's, moved by TABLE_Z), when (Round.real), and what each view says. */
export interface Call { at: THREE.Vector3; t: number; looks: CallLook[]; }
/** A banner: its headline, a line under it (in a side's colours, or plain), and when it shows (Round.real). */
export interface Banner { text: string; face: Face; sub?: { text: string; look: PlayerLook | null }; from: number; to: number; }
export interface Prompt { text: string; icon: 'raise' | 'swing' | null; /** The view's own serve. */ mine: boolean; }

/** The look of a side of the table: a player's, or alone at the far end, the robot's. */
export const lookOf = (round: Round, end: End) => (!round.two && end === 1 ? ROBOT : PLAYERS[end]);
/** A side's name on the score bug. */
export const nameOf = (round: Round, end: End) => (round.two ? PLAYERS[end].name : end === 0 ? 'You' : 'Robot');

/**
 * A point's call in each view (alone, the one). In the winner's colours; gold for the match's
 * last good shot, a great rally and a new level.
 */
export function callsFor(round: Round, point: PointWon, levelUp = false): CallLook[] {
  const views = round.two ? [0, 1] as const : [0] as const;
  const face = faceOf(lookOf(round, point.to));
  if (round.mode === 'challenge') {
    if (point.reason === 'return') return [levelUp ? { text: 'NICE!', face: GOLD } : { text: '+1', face }];
    return [{ text: CALL_WORDS[point.reason], face }];
  }
  const winner = point.reason === 'double' || point.reason === 'missed';
  if (!winner) return views.map(() => ({ text: CALL_WORDS[point.reason], face }));
  if (round.rally >= RALLY.great) return views.map(() => ({ text: 'GREAT RALLY!', face: GOLD }));
  // (Alone, the robot's winner is what the player missed.)
  return views.map((view) => (view === point.to && (round.two || point.to === 0)
    ? { text: 'NICE!', face: round.done ? GOLD : face }
    : { text: CALL_WORDS[point.reason], face }));
}

/** The banner due now (whether it's showing yet is its `from` and `to`): the match won, whose point it was, or one set for a serve or a level. */
function bannerDue(round: Round, set: Banner | null): Banner | null {
  const point = round.point;
  if (round.done && point) {
    const from = point.t + BANNER.delay;
    if (round.mode === 'challenge') {
      const n = round.challenge.returns;
      return { text: n ? `${n} RETURN${n === 1 ? '' : 'S'}` : 'NO RETURNS', face: CHAMPAGNE, sub: { text: 'RETURN CHALLENGE', look: null }, from, to: Infinity };
    }
    const winner = round.match.winner ?? point.to;
    return { text: 'GAME!', face: GOLD, sub: { text: round.two ? PLAYERS[winner].name.toUpperCase() : winner === 0 ? 'YOU WIN' : 'ROBOT WINS', look: lookOf(round, winner) }, from, to: Infinity };
  }
  if (round.between && point && round.mode === 'match') {
    const text = round.two ? `POINT — ${PLAYERS[point.to].name.toUpperCase()}` : point.to === 0 ? 'YOUR POINT' : "ROBOT'S POINT";
    return { text, face: faceOf(lookOf(round, point.to)), from: point.t + BANNER.delay, to: point.t + BEAT.point };
  }
  return set;
}

/**
 * What a view's player is asked to do now, if anything: how to toss their serve, then to swing;
 * or whose serve it is (Return Challenge's: to return it).
 */
export function promptFor(round: Round, view: End): Prompt | null {
  if (round.done || round.between || !(round.holding() || round.serve)) return null;
  const server = round.server();
  if (server !== view || !round.playerServes()) {
    const text = round.mode === 'challenge' ? 'Return the robot\'s serve' : round.two ? `${PLAYERS[server].name} serves` : 'The robot serves';
    return { text, icon: null, mine: false };
  }
  return round.tossAt === null ? { text: `Raise your ${round.rigs[view].free} hand to toss the ball`, icon: 'raise', mine: true } : { text: 'Swing!', icon: 'swing', mine: true };
}

/**
 * Tracking that isn't all there, said plainly: no 3D tracking from the camera, the hand model
 * loading, dropped (too slow) or not to be had (`warn`: the HUD shows these); hand tracking
 * turned off (the setting), calmly (the player chose it: the development panel says it).
 * Nothing when it's all there. (With two players the hands come and go for both together.)
 */
export function trackingNote(rig: Rig, tracking: HandTracking | null, two: boolean): { text: string; warn: boolean } | null {
  const paddle = two ? 'the paddles follow your arms' : 'the paddle follows your arm';
  if (rig.flat) return { text: 'This camera sends no 3D tracking: your arms\' depth is a guess', warn: true };
  if (tracking === 'loading') return { text: 'Loading hand tracking…', warn: true };
  if (tracking === 'dropped') return { text: `Hand tracking is off (tracking was too slow${two ? ' for two' : ''}): ${paddle}`, warn: true };
  if (tracking === 'unavailable') return { text: `No hand tracking: ${paddle}`, warn: true };
  if (tracking === null) return { text: `Hand tracking off (the setting): ${paddle}`, warn: false };
  return null;
}

/** What the HUD keeps between frames (the round's own state is the rest). */
export class HudModel {
  point: PointWon | null = null;
  /** The latest calls, oldest first. */
  calls: Call[] = [];
  /** When each side's score last went up (Round.real). */
  bump = [-Infinity, -Infinity];
  /** A banner set for the serve after a point (DEUCE, MATCH POINT) or a new level. */
  set: Banner | null = null;
  private between = false;
  private level = 0;
  /**
   * The side whose serve the ball waited for last frame (alone, 1 is the robot), whether it was in
   * play, how many each player has served, and how many of the other side's serves each has seen.
   */
  private serving: End | null = null;
  private flying = false;
  served = [0, 0];
  seen = [0, 0];
  private assist: AssistLevel;
  toast: { text: string; t: number } | null = null;

  constructor(assist: AssistLevel) { this.assist = assist; }

  /** A frame of the round, once it has stepped: a new point, a serve set up or made, the aim assist changed. */
  observe(round: Round) {
    const point = round.point, t = round.real;
    if (point && point !== this.point) this.onPoint(round, point);
    if (this.between && !round.between && !round.done && round.mode === 'match') this.onServeReady(round);
    this.between = round.between;
    // A serve on its way: one more its player has served, and the other has seen.
    if (this.serving !== null && round.flying && !this.flying && round.shot?.by === this.serving) {
      if (round.two || this.serving === 0) this.served[this.serving] += 1;
      for (const end of [0, 1] as const) if (end !== this.serving) this.seen[end] += 1;
    }
    this.flying = round.flying;
    // (The robot's serve is a motion, its follow-through still going once the ball's away.)
    this.serving = !round.flying && (round.holding() || round.serve) ? round.server() : null;
    if (round.play.assist !== this.assist) { this.assist = round.play.assist; this.toast = { text: `Aim assist: ${ASSIST_LABELS[this.assist]}`, t }; }
  }

  /** A new point: its call, its side's score bumping, and in Return Challenge a new level's banner. */
  private onPoint(round: Round, point: PointWon) {
    this.point = point;
    const t = round.real, level = round.challenge.level, levelUp = round.mode === 'challenge' && level > this.level;
    this.level = level;
    this.calls.push({ at: new THREE.Vector3(point.at.x, point.at.y, point.at.z + TABLE_Z), t: point.t, looks: callsFor(round, point, levelUp) });
    if (this.calls.length > 3) this.calls.shift();
    if (round.mode === 'match') this.bump[point.to] = t;
    else if (point.reason === 'return') this.bump[0] = t;
    if (levelUp) this.set = { text: `LEVEL ${level + 1}`, face: CHAMPAGNE, sub: { text: 'FASTER SERVES', look: null }, from: t + 0.15, to: t + 0.15 + BANNER.level };
  }

  /** The next serve set up after a point: DEUCE or MATCH POINT (whose), as it starts. */
  private onServeReady(round: Round) {
    const t = round.real, match = round.match, point = matchPointFor(match);
    if (deuce(match)) this.set = { text: 'DEUCE', face: CHAMPAGNE, sub: { text: 'TWO IN A ROW TO WIN', look: null }, from: t, to: t + BANNER.hold };
    else if (point !== null) this.set = { text: 'MATCH POINT', face: GOLD, sub: { text: nameOf(round, point).toUpperCase(), look: lookOf(round, point) }, from: t, to: t + BANNER.hold };
    else this.set = null;
  }

  /** The banner showing now, if any. */
  banner(round: Round): Banner | null {
    const banner = bannerDue(round, this.set), t = round.real;
    return banner && t >= banner.from && t < banner.to ? banner : null;
  }

  /**
   * A view's prompt, if it's to show: their own serve's until they've served PROMPT.serves (or
   * after they've stood at it PROMPT.idle seconds), the other side's until they've seen as many.
   */
  prompt(round: Round, view: End): Prompt | null {
    const ask = promptFor(round, view);
    if (!ask) return null;
    if (!ask.mine) return this.seen[view] < PROMPT.serves ? ask : null;
    const idle = round.holding() && (round.time - round.heldSince) / round.play.timeScale >= PROMPT.idle;
    return this.served[view] < PROMPT.serves || idle ? ask : null;
  }

  /** What play.ts and the tests read: the last call (each view's, Player 1's first) and the banner showing. */
  report(round: Round, phase: MinigamePhase) {
    const banner = phase === 'playing' ? this.banner(round) : null;
    return { call: this.calls.at(-1)?.looks.map((look) => look.text).join('|') ?? null, banner: banner?.text ?? null };
  }
}
