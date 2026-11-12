/*
 * A round of Table Tennis, without the drawing: the ball, the players' paddles (rig.ts) and,
 * alone, the robot's, a frame at a time, and the match they're playing (match.ts). Game.tsx draws
 * what's here; the tests play it without a screen (apps/web/tests/table-tennis-agency.test.ts).
 *
 * A Match (Play.mode) is first to 6 (match.ts MATCH), against the robot alone or the other player
 * with two. On a player's serve the ball waits in the air over their end (rally.ts SERVE); their
 * free hand raised tosses it up, and a swing through it as it comes down serves it (assist.ts
 * serveHit; or Space). The robot serves its own after a moment: tossed up and struck (robot.ts).
 * The ball flies (ball.ts) in the table's frame at the time's speed, met by the players' paddles
 * as they moved this frame (as they were a lag ago: LaggedBall, flight.ts), and the bot (bot.ts)
 * plays back the player's returns that land, now and then getting one wrong. The referee
 * (match.ts judge) says when a shot has won or lost the point; then, after a beat (BEAT), the
 * next serve is set up, until someone has won.
 *
 * Return Challenge (alone) has the robot serve and serve again, quicker every few, for as long as
 * the player returns them onto its half: the first they don't ends the round.
 *
 * With two every shot is slowed to a pace the other player can get to (assist.ts PACE): alone,
 * the robot gets to anything it can reach.
 *
 * A ball that's out of play is soon taken back (DEAD): on the floor, in the net, or bouncing twice
 * on one half with nobody hitting it.
 */

import * as THREE from 'three';
import { ASSIST, PACE, SERVE_SWING, SWING, assistReturn, interceptNudge, serveHit, swingOf } from './assist.ts';
import type { AssistLevel } from './assist.ts';
import { arrival, autoplayBlade, autoplayRaised, autoplayServe } from './autoplay.ts';
import { PADDLE_COOLDOWN, v3 } from './ball.ts';
import type { Ball, PaddlePose, V3 } from './ball.ts';
import { BOT, botMistake, botServe, botShot, botTarget, challengeServe, missShot, planReturn, reachRoom } from './bot.ts';
import type { BotLevel } from './bot.ts';
import { coming, endPass, recalibrate, trackPass } from './calibrate.ts';
import type { Pass, PassResult } from './calibrate.ts';
import { flightStep } from './flight.ts';
import type { FlightEvent, Swinger } from './flight.ts';
import { LaggedBall } from './lagged.ts';
import { award, challengeLevel, deadVerdict, judge, newMatch, newShot, serverOf } from './match.ts';
import type { Match, Shot, Verdict } from './match.ts';
import { SERVE, TOSS_S, endOf, heldBall, mine, mineBall, otherEnd, tossedBall } from './rally.ts';
import type { End } from './rally.ts';
import { RAISED, REST, bladePose, borneOut, followHands, handLive, heldPose, wristFor } from './rig.ts';
import type { Rig } from './rig.ts';
import { GAP, HOLD_NORMAL, faceNormal, forehand, heading, holdPose, onPaddle, planServe, serveBall, servePose, serveStrike, strokeOffset } from './robot.ts';
import type { ArmPose, ServeMotion } from './robot.ts';

/**
 * A ball out of play is taken back this long (the players' seconds) after it: bounces on the
 * floor, catches in the net, bounces a second time on one half with nobody hitting it, or has
 * lain still; and one that's been in the air this long with nobody touching it.
 */
export const DEAD = { floor: 0.35, net: 0.6, second: 0.3, still: 0.4, stalled: 12 } as const;
/**
 * Between points (the players' seconds): how long after a point is won the next serve is set up
 * (after a return in Return Challenge, `challenge`), and how long after the last point the round
 * is finished (Round.finished).
 */
export const BEAT = { point: 1.6, challenge: 0.5, over: 1.4 } as const;
/** How long the robot holds the ball before serving it (the players' seconds): in a match, and in Return Challenge. */
export const ROBOT_WAIT = { match: 1.1, challenge: 0.45 } as const;
// How late the paddle is to the ball, stepped through with L: 'auto' is the tracker's measured
// delay (camera to result) and DRAW_LAG more for the hand's filtering and easing; or set, in seconds.
export const HIT_LAGS = ['auto', 0, 0.06, 0.1, 0.15] as const;
export type HitLag = typeof HIT_LAGS[number];
/**
 * The paddle as drawn trails the tracker's poses by about 80 ms at a swing's speed (trackbench's
 * ping-pong scenes: the one-euro filter, holding each pose a frame, and the easing), and alone the
 * hit makes up for all of it. With two, a hit judged that long ago puts the ball that much further
 * on its way to the other player, who then has that much less time to reach it: compensating the
 * hitter in full costs the receiver as much (in the play simulation, two good players hit 94% at
 * 50 ms, 85% at 75 ms and 97% at 30 ms; alone, a good player 93% at 50 ms and 95% at 75 ms).
 */
export const DRAW_LAG = { one: 0.075, two: 0.03 } as const;
/** DRAW_LAG for one player or two. */
export const drawLag = (two: boolean) => (two ? DRAW_LAG.two : DRAW_LAG.one);

/** What's being played: a match (first to 6), or, alone, Return Challenge. */
export type Mode = 'match' | 'challenge';

/** The round's settings, and the keys pressed for it. */
export interface Play {
  /** A match, or (alone) Return Challenge: two players always play a match. */
  mode: Mode;
  forgiving: boolean;
  /** Space was pressed: serve a ball. */
  serve: boolean;
  /** How fast the ball's world runs (1: real time). */
  timeScale: number;
  /** How late the paddle is to the ball (hits are judged against the ball as it was then). */
  hitLag: HitLag;
  /** How much the aim assist helps (assist.ts). */
  assist: AssistLevel;
  /** Alone: how hard the bot's shots and serves are (a match's). */
  botLevel: BotLevel;
}

/**
 * How late a player's paddle is to the ball, in the ball's time (the camera off: not at all). A
 * serve's swing is allowed for in full (`full`), with two too: nobody waiting for it loses time.
 */
const lagOf = (rig: Rig, play: Play, two: boolean, full = false) => (!rig.tracked ? 0 : (play.hitLag === 'auto' ? (rig.latency > 0 ? rig.latency + drawLag(two && !full) : 0) : play.hitLag) * play.timeScale);

/** Each player's part of the ball's frame: their paddle last frame (the table's frame) and where they'd moved it (their own), their swings, the ball's pass, their free hand. */
interface Player { paddle: PaddlePose | null; moved: V3 | null; speeds: { t: number; vel: V3 }[]; pass: Pass | null; raised: boolean; }

/** A point won: to whom, why, whose shot it was, where the ball was when it was decided (the table's frame), and when (the players' seconds: Round.real). */
export interface PointWon extends Verdict { by: End; at: V3; t: number; }

const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const tmp = new THREE.Vector3();

export class Round {
  readonly rigs: Rig[];
  readonly play: Play;
  readonly two: boolean;
  readonly rand: () => number;
  /** A match, or Return Challenge (alone). */
  readonly mode: Mode;
  ball: Ball;
  lagged: LaggedBall | null = null;
  /** The ball's drawn place, from its real one (eased onto a rewound hit's by Game.tsx), set when a hit moves it. */
  drawnOff = v3();
  flying = false;
  deadAt = Infinity;
  slowSince: number | null = null;
  servedAt = -Infinity;
  hits = 0;
  /** The players' shots that landed on the other half. */
  returns = 0;
  /** The ball's world's time, and the players' own. */
  time = 0;
  real = 0;
  players: Player[];
  /** When the ball was last hit (by anyone), this point's shots that landed so far and the most any point has had, and since when the ball's been waiting to be served (the ball's time). */
  touchedAt = -Infinity;
  rally = 0;
  best = 0;
  heldSince = 0;
  /** The match: its score, and who serves. */
  match: Match = newMatch(0);
  /** Return Challenge: the serves returned so far, and the level the serves are at (match.ts challengeLevel). */
  challenge = { returns: 0, level: 0 };
  /** The shot in the air, as the referee follows it (match.ts), or none. */
  shot: Shot | null = null;
  /** The last point won (for the HUD's call), or none yet. */
  point: PointWon | null = null;
  /** A point has been won and the next serve isn't set up yet. */
  between = false;
  /** The match has been won, or the challenge's run has ended (Round.finished says when to show it). */
  done = false;
  /** When the waiting ball was tossed (the ball's time), or null while it waits to be. */
  tossAt: number | null = null;
  /** The half the ball last bounced on since it was last hit (null: it hasn't). */
  bouncedOn: End | null = null;
  /**
   * The bot: where it meets the ball (its paddle's middle then), when it last struck it, the spot
   * it's aiming its next shot at, the shot's heading (from above) and whether it's on its
   * forehand, and its paddle's face and stroke as drawn (eased).
   */
  bot = { pos: { ...BOT.home }, hitAt: -Infinity, aim: null as V3 | null, dir: v3(0, 0, 1), fore: true, normal: { ...HOLD_NORMAL }, offset: v3() };
  /** The robot's paddle this frame (the table's frame). */
  arm: ArmPose = holdPose(0);
  /** A serve asked for, and one under way (the toss, the strike, the follow-through), and its ball's velocity off the paddle. */
  serveAsked = false;
  serve: ServeMotion | null = null;
  serveVel = v3();
  /**
   * With two: a serve's swing seen (the ball's velocity off it), waiting for the tracker's next pose
   * to bear it out: the pose it was seen at, the wrist there and the way it was swinging.
   */
  serveSeen: { vel: V3; at: number; wrist: V3; way: V3 } | null = null;
  /** Each player's hits (with two). */
  hitsBy = [0, 0];
  /** The ball's latest bounces on the table, newest last: where (the table's frame), and when (the ball's time). */
  bounces: { at: V3; t: number }[] = [];
  /** How the last ball went by each player's paddle. */
  passes: (PassResult | null)[];
  /** What the ball hit this frame, the robot's paddle and the serves too (a paddle's `by` is its player; the robot's has none): for sounds and the like. */
  events: FlightEvent[] = [];

  constructor(rigs: Rig[], play: Play, rand: () => number = Math.random) {
    this.rigs = rigs;
    this.play = play;
    this.two = rigs.length > 1;
    this.rand = rand;
    this.mode = this.two ? 'match' : play.mode;
    this.ball = this.robotHolds() ? { pos: onPaddle(this.arm), vel: v3(), cooldown: 0 } : heldBall(this.server(), 0, rigs[this.server()]?.paddle);
    this.players = rigs.map((): Player => ({ paddle: null, moved: null, speeds: [], pass: null, raised: false }));
    this.passes = rigs.map(() => null);
  }

  /** Whose serve it is: the match's server (alone, 1 is the robot's), or in Return Challenge always the robot's. */
  server(): End { return this.mode === 'challenge' ? 1 : serverOf(this.match); }
  /** The ball is waiting to be served (by a player or the robot): not in play, nor between points. */
  holding() { return !this.flying && !this.serve && !this.between && !this.done; }
  /** A player (not the robot) is to serve. */
  playerServes() { return this.two || this.server() === 0; }
  /** The robot has the ball on its paddle, its serve. */
  robotHolds() { return !this.two && this.holding() && this.server() === 1; }
  /** A player's waiting ball can be tossed (it has waited long enough), or is tossed. */
  armed() { return this.playerServes() && this.holding() && this.time - this.heldSince >= SERVE.arm * this.play.timeScale; }
  /** The ball is to be seen: in play, waiting to be served, or being served (not between points once it's gone). */
  ballShown() { return this.flying || this.holding() || !!this.serve; }
  /** The round is over and its results are due: a beat after the last point. */
  finished() { return this.done && this.point !== null && this.real - this.point.t >= BEAT.over; }

  /**
   * A stand-in (autoplay.ts) sets its player's hands before they're drawn, from the ball as they'd
   * see it (a lag ago): its blade where the swing should be, serving the ball that waits for it,
   * and alone its free hand up a while after the robot has the ball.
   */
  private standIns(now: number) {
    const { play } = this;
    for (const rig of this.rigs) {
      if (!rig.autoplay) continue;
      const mineToServe = this.holding() && this.server() === rig.end;
      const lag = lagOf(rig, play, this.two);
      const seen = this.flying && this.lagged ? mineBall(rig.end, this.lagged.then(lag)) : null;
      // (Serving, it swings at the tossed ball as it was a lag ago, as its swing will be judged against.)
      const since = this.tossAt === null ? null : this.time - this.tossAt - lagOf(rig, play, this.two, true);
      const toss = since === null ? null : tossedBall(rig.end, Math.max(0, since), rig.paddle);
      const blade = mineToServe ? autoplayServe(since === null ? null : since / play.timeScale, mine(rig.end, (toss ?? this.ball).pos))
        : autoplayBlade(seen && arrival(seen, play.timeScale), rig.paddle);
      rig.hands[rig.paddle] = { at: now, pose: { ...heldPose(rig.paddle, REST[rig.paddle]), wrist: wristFor(rig, blade) } };
      const raised = mineToServe && this.tossAt === null && autoplayRaised((this.time - this.heldSince) / play.timeScale);
      const out = rig.free === 'left' ? -0.05 : 0.05;
      rig.hands[rig.free] = { at: now, pose: heldPose(rig.free, raised ? { x: out, y: 0.3, z: -0.15 } : { x: out, y: -0.4, z: -0.1 }) };
    }
  }

  // The robot's paddle this frame: through a serve, as it goes; otherwise where the bot meets the
  // ball (or home), with the stroke's swing on it, its face eased round to the shot's heading (or
  // up, holding the ball). The ball rides on it while it's held.
  private moveRobot(dt: number, plan: { t: number; at: V3 } | null) {
    if (this.two) return;
    const bot = this.bot;
    if (this.serve) {
      this.arm = servePose(this.serve, this.time);
      const ball = serveBall(this.serve, this.time, this.arm);
      if (ball) this.ball.pos = ball;
      if (this.time >= this.serve.end) {
        // Over: the bot takes it from here, from where the paddle is.
        bot.pos = { x: this.arm.pos.x + this.arm.normal.x * GAP, y: this.arm.pos.y + this.arm.normal.y * GAP, z: this.arm.pos.z + this.arm.normal.z * GAP };
        bot.normal = { ...this.arm.normal };
        bot.dir = heading(v3(), this.arm.normal);
        bot.offset = v3();
        bot.hitAt = -Infinity;
        this.serve = null;
      }
      return;
    }
    const held = this.robotHolds();
    if (plan && bot.aim) { bot.dir = heading(bot.pos, bot.aim); bot.fore = forehand(plan.at); }
    const face = held ? HOLD_NORMAL : faceNormal(bot.dir);
    const offset = held ? v3() : strokeOffset(plan ? plan.t : null, this.time - bot.hitAt, bot.dir, bot.fore, reachRoom(bot.pos));
    const kn = 1 - Math.exp(-12 * dt), ko = 1 - Math.exp(-30 * dt);
    const n = v3(bot.normal.x + (face.x - bot.normal.x) * kn, bot.normal.y + (face.y - bot.normal.y) * kn, bot.normal.z + (face.z - bot.normal.z) * kn);
    const l = Math.hypot(n.x, n.y, n.z) || 1;
    bot.normal = v3(n.x / l, n.y / l, n.z / l);
    bot.offset = v3(bot.offset.x + (offset.x - bot.offset.x) * ko, bot.offset.y + (offset.y - bot.offset.y) * ko, bot.offset.z + (offset.z - bot.offset.z) * ko);
    const bob = held ? 0.008 * Math.sin(this.time * 2.2) : 0;
    this.arm = {
      pos: v3(bot.pos.x + bot.offset.x - bot.normal.x * GAP, bot.pos.y + bot.offset.y - bot.normal.y * GAP + bob, bot.pos.z + bot.offset.z - bot.normal.z * GAP),
      normal: bot.normal,
    };
    if (held) this.ball.pos = onPaddle(this.arm);
  }


  // A pass over: kept for the HUD, and the paddle's calibration moved by it.
  private finishPass(i: number, struck: boolean) {
    const p = this.players[i];
    if (!p.pass) return;
    const pass = endPass(p.pass, struck, SWING.minSpeed);
    p.pass = null;
    const shifted = recalibrate(this.rigs[i].shift, pass);
    this.rigs[i].shift.set(shifted.x, shifted.y, shifted.z);
    this.passes[i] = pass;
  }

  // The ball's flight over (it's dead, or left too long): if nothing had decided the point, whoever
  // was to play the ball next loses it.
  private stopFlight() {
    this.flying = false;
    this.bot.aim = null;
    this.serveSeen = null;
    this.rigs.forEach((_, i) => this.finishPass(i, false));
    if (this.between || this.done) return;
    if (this.shot) this.decide(deadVerdict(this.shot), this.ball.pos);
    else this.nextServe();
  }

  // A point won (match.ts): scored, and the beat before the next serve begun. In Return Challenge a
  // return counts and the next serve comes; the player missing one ends the round (one of the
  // robot's serves that didn't land is served again).
  private decide(verdict: Verdict, at: V3) {
    const by = this.shot?.by ?? otherEnd(verdict.to);
    this.point = { ...verdict, by, at: { ...at }, t: this.real };
    this.between = true;
    this.best = Math.max(this.best, this.rally);
    if (this.mode === 'challenge') {
      if (verdict.reason === 'return') this.challenge = { returns: this.challenge.returns + 1, level: challengeLevel(this.challenge.returns + 1) };
      else if (verdict.to === 1) this.done = true;
    } else {
      award(this.match, verdict.to);
      if (this.match.winner !== null) this.done = true;
    }
  }

  // The beat over: the next serve, its ball waiting for the server (on the robot's paddle, its).
  private nextServe() {
    Object.assign(this, { between: false, shot: null, rally: 0, tossAt: null, serveSeen: null, serveAsked: false, heldSince: this.time });
  }

  /** How long the beat after the last point lasts (the players' seconds). */
  private beat() { return this.mode === 'challenge' && this.point?.to === 0 ? BEAT.challenge : BEAT.point; }

  // What the ball touching the table, the net or the floor does to the shot in the air (match.ts judge).
  private referee(e: FlightEvent) {
    const shot = this.shot;
    if (!shot || this.between || this.done || e.type === 'paddle') return;
    const landed = shot.landed;
    const verdict = judge(shot, { type: e.type, half: endOf(e.at.z) });
    if (!landed && shot.landed) {
      this.rally += 1;
      if (this.two || shot.by === 0) this.returns += 1;
      // Return Challenge: the player's return landing is the point.
      if (this.mode === 'challenge' && shot.by === 0) { this.decide({ to: 0, reason: 'return' }, e.at); return; }
    }
    if (verdict) this.decide(verdict, e.at);
  }

  /** The ball's flight begins (a serve's strike), from where it is, at `vel`. */
  private launch(vel: V3, cooldown = 0) {
    this.ball = { pos: { ...this.ball.pos }, vel, cooldown };
    this.lagged = new LaggedBall(this.ball, this.time);
    this.drawnOff = v3();
    for (const p of this.players) p.pass = null;
    Object.assign(this, { flying: true, deadAt: Infinity, slowSince: null, servedAt: this.time, bouncedOn: null, tossAt: null });
  }

  /**
   * A frame: `delta` seconds since the last, at `now` (ms, the clock the hands' poses are timed
   * by). Only while playing does anything but the hands move: the countdown and a pause hold the
   * ball, the bot, the score and the paddles' calibration where they are (the paddles are still
   * followed, so play resumes without a jump).
   */
  step(delta: number, now: number, playing: boolean) {
    const { rigs, play, two } = this;
    this.events = [];
    this.standIns(now);
    for (const rig of rigs) followHands(rig, now, delta);
    // Real time (the players'), and the ball's world's.
    const dt = playing ? Math.min(delta, 1 / 20) : 0;
    const span = Math.min(Math.max(delta, dt), 0.25);
    const worldDt = dt * play.timeScale;
    this.time += worldDt;
    // Each paddle where it's drawn now, in the table's frame (with the reach it has), where the
    // player has it in their own frame (without the aim assist's slide), and where they've moved
    // it (without its calibration either).
    const pads = rigs.map((rig) => {
      const paddle = bladePose(rig, play.forgiving);
      if (!paddle) return { paddle: null, raw: null, moved: null };
      const c = mine(rig.end, paddle.center);
      const raw = v3(c.x - rig.nudged.x, c.y - rig.nudged.y, c.z - rig.nudged.z);
      const moved = v3(raw.x - rig.shifted.x, raw.y - rig.shifted.y, raw.z - rig.shifted.z);
      return { paddle, raw, moved };
    });
    const keep = () => rigs.forEach((_, i) => { this.players[i].paddle = pads[i].paddle; this.players[i].moved = pads[i].moved; });
    if (!playing) { keep(); return; }
    const help = ASSIST[play.assist];
    this.real += dt;
    // Each player's swing (at their own speed, whatever the time's; neither the assist's slide nor
    // the calibration's shift is a swing), how late they see the ball, and their free hand raised
    // above its shoulder (from the tracker), with some give before it counts as lowered.
    const you = rigs.map((rig, i) => {
      const p = this.players[i], moved = pads[i].moved;
      // (By the frame's real length: `dt` is capped, and a slow frame's move isn't a fast one.)
      const paddleVel = p.moved && moved && dt > 0 ? v3((moved.x - p.moved.x) / span, (moved.y - p.moved.y) / span, (moved.z - p.moved.z) / span) : undefined;
      // Only a hand being tracked swings (one lost drifts down to its rest, which is no swing).
      const live = handLive(rig, rig.paddle, now);
      if (paddleVel && live) p.speeds.push({ t: this.real, vel: paddleVel });
      while (p.speeds.length && this.real - p.speeds[0].t > 0.5) p.speeds.shift();
      const free = rig.hands[rig.free];
      const wasRaised = p.raised;
      p.raised = handLive(rig, rig.free, now) && free!.pose.wrist.y > (p.raised ? RAISED.down : RAISED.up);
      // (A hand thrown out and back by one wild pose is no swing.)
      const borne = (travel?: number) => {
        const swung = live ? swingOf(p.speeds, this.real, travel) : null;
        return swung && borneOut(rig, rig.paddle, swung.vel, this.real - swung.t, SWING.sprung, now) ? swung.vel : v3();
      };
      const swing = borne();
      // (A serve's swing is a longer one than a rally's.)
      return { paddleVel, live, wasRaised, lag: lagOf(rig, play, two), serveLag: lagOf(rig, play, two, true), swing, serveSwing: () => borne(SERVE_SWING.travel) };
    });
    let plan: { t: number; at: V3 } | null = null;
    // A point won: once its beat is over, the ball (if it's still going) is taken back and the next
    // serve set up.
    if (this.between && !this.done && this.point && this.real - this.point.t >= this.beat()) {
      if (this.flying) this.stopFlight();
      this.nextServe();
    }
    const s = this.server();
    if (this.holding() && !this.playerServes()) {
      // The robot's serve: after a moment holding the ball (or Space), once it's home, struck from
      // above where it's held, down onto its own half and over onto the player's.
      const wait = this.mode === 'challenge' ? ROBOT_WAIT.challenge : ROBOT_WAIT.match;
      if (play.serve || this.time - this.heldSince >= wait * play.timeScale) this.serveAsked = true;
      if (this.serveAsked && dist(this.bot.pos, BOT.home) < 0.02 && dist(this.bot.normal, HOLD_NORMAL) < 0.05) {
        const from = serveStrike(this.arm.pos);
        const flight = botServe(from, this.mode === 'challenge' ? challengeServe(this.challenge.level) : play.botLevel, this.rand, rigs[0].paddle);
        const vel = flight?.vel ?? v3(0, 0, 3);
        const dir = heading(from, flight?.second ?? v3(0, 0, 1));
        const tilt = Math.min(0.35, Math.max(-0.2, Math.atan2(vel.y, Math.hypot(vel.x, vel.z))));
        this.serve = planServe(this.time, this.arm.pos, dir, faceNormal(dir, tilt));
        this.serveVel = vel;
        this.serveAsked = false;
      }
    } else if (this.holding()) {
      // A player's serve: the ball waits by their paddle hand until their free hand, raised, tosses
      // it; a swing through it as it comes down serves it (or Space, at once). Left to fall (as the
      // server saw it, a lag ago: until then it rests where it dropped to), it's back waiting, to
      // be tossed again.
      const rig = rigs[s], p = this.players[s], { serveLag: lag } = you[s];
      if (this.tossAt === null && this.armed() && p.raised) this.tossAt = this.time;
      const since = this.tossAt === null ? null : this.time - this.tossAt;
      if (since !== null && !tossedBall(s, Math.max(0, since - lag), rig.paddle)) { this.tossAt = null; this.serveSeen = null; this.heldSince = this.time; }
      const ball = this.tossAt === null || since === null ? heldBall(s, this.time, rig.paddle) : tossedBall(s, Math.min(since, TOSS_S - 1e-3), rig.paddle)!;
      this.ball.pos = ball.pos; this.ball.vel = ball.vel;
      const from = mine(s, ball.pos);
      const { raw } = pads[s], { live } = you[s];
      const pose = rig.hands[rig.paddle];
      let vel: V3 | null = play.serve ? { ...SERVE.key } : null;
      if (!vel && (!live || !pose || this.tossAt === null)) this.serveSeen = null;
      else if (!vel && this.serveSeen && pose && pose.at > this.serveSeen.at) {
        // The tracker's next pose bears the swing out, unless the hand has sprung back: one wild
        // pose (the arm's depth read the wrong way round, say) isn't a swing.
        const w = pose.pose.wrist, was = this.serveSeen.wrist, way = this.serveSeen.way;
        if ((w.x - was.x) * way.x + (w.y - was.y) * way.y + (w.z - was.z) * way.z > -SWING.sprung) vel = this.serveSeen.vel;
        this.serveSeen = null;
      } else if (!vel && !this.serveSeen && pose && raw && this.tossAt !== null) {
        // Swung at the ball as the server saw it, a lag ago.
        const seenBall = tossedBall(s, Math.max(0, this.time - this.tossAt - lag), rig.paddle) ?? ball;
        const swing = you[s].serveSwing();
        const seen = serveHit(mine(s, seenBall.pos), raw, swing, help);
        const l = Math.hypot(swing.x, swing.y, swing.z) || 1;
        if (seen) this.serveSeen = { vel: seen, at: pose.at, wrist: { ...pose.pose.wrist }, way: v3(swing.x / l, swing.y / l, swing.z / l) };
      }
      if (vel) {
        // A serve lands, whatever the level (but with the assist off), and with two no sooner than
        // the other player can be ready for it.
        this.serveSeen = null;
        this.launch(mine(s, assistReturn(from, vel, play.assist === 'off' && !play.serve ? 0 : 1, two ? PACE.serve : undefined)), PADDLE_COOLDOWN);
        this.shot = newShot(s);
        this.hits += 1; this.hitsBy[s] += 1; this.touchedAt = this.time;
        this.events.push({ type: 'paddle', at: { ...this.ball.pos }, speed: Math.hypot(vel.x, vel.y, vel.z), by: s });
      }
    }
    play.serve = false;
    const b = this.ball;
    if (!two && this.serve && !this.flying && this.time >= this.serve.strikeAt) {
      // The robot's strike: the ball's flight begins (a real serve: onto its own half first).
      b.pos = { ...this.serve.strike };
      this.launch({ ...this.serveVel });
      this.shot = newShot(1, true);
      this.events.push({ type: 'paddle', at: { ...this.serve.strike }, speed: Math.hypot(this.serveVel.x, this.serveVel.y, this.serveVel.z) });
    } else if (this.flying && this.lagged) {
      const lagged = this.lagged, ball = this.ball;
      // Each ball's pass by each paddle, as its player saw it: kept at its nearest.
      rigs.forEach((rig, i) => {
        const raw = pads[i].raw;
        if (!you[i].live || !raw) return;
        const then = mineBall(rig.end, lagged.then(you[i].lag));
        if (coming(then, raw.z)) this.players[i].pass = trackPass(this.players[i].pass, then, raw, Math.hypot(you[i].swing.x, you[i].swing.y, you[i].swing.z));
      });
      const before = { ...ball.pos };
      // (Once the point's won, the ball goes on its way untouched.)
      const swingers: Swinger[] = this.between ? [] : rigs.map((rig, i) => ({
        // (A lost hand's paddle, sinking to its rest, is still there for the ball to meet, as it's drawn; it swings at nothing.)
        end: rig.end, raw: you[i].live ? pads[i].raw : null, paddleVel: you[i].paddleVel, swing: you[i].swing, lag: you[i].lag,
        from: this.players[i].paddle ?? pads[i].paddle, to: pads[i].paddle,
      }));
      const flight = flightStep(lagged, worldDt, swingers, help, play.timeScale, two ? PACE.rally : undefined);
      this.events.push(...flight.events);
      // Drawn from where it was, easing onto where a hit (judged a lag ago) put it.
      const by = flight.events.find((e): e is FlightEvent & { type: 'paddle' } => e.type === 'paddle')?.by;
      if ((flight.swung || flight.hit) && by !== undefined && you[by].lag > 0) this.drawnOff = v3(before.x + this.drawnOff.x - ball.pos.x, before.y + this.drawnOff.y - ball.pos.y, before.z + this.drawnOff.z - ball.pos.z);
      const out = (after: number) => { this.deadAt = Math.min(this.deadAt, this.time + after * play.timeScale); };
      for (const e of flight.events) {
        if (e.type === 'paddle') {
          this.deadAt = Infinity; this.bouncedOn = null;
          if (e.by !== undefined) { this.hits += 1; this.hitsBy[e.by] += 1; this.touchedAt = this.time; this.shot = newShot(e.by); this.finishPass(e.by, true); }
        } else this.referee(e);
        if (e.type === 'table') {
          this.bounces.push({ at: e.at, t: this.time });
          if (this.bounces.length > 3) this.bounces.shift();
          // A second bounce on one half, nobody having hit it between: nobody will now. (The
          // robot's serve bounces on its own half first, then once on the player's.)
          const on = endOf(e.at.z);
          if (this.bouncedOn === on) out(DEAD.second);
          this.bouncedOn = on;
        }
        if (e.type === 'net') out(DEAD.net);
        if (e.type === 'floor') out(DEAD.floor);
      }
      // Gone by a paddle (or away) unhit.
      rigs.forEach((rig, i) => {
        const raw = pads[i].raw;
        if (this.players[i].pass && (!raw || !coming(mineBall(rig.end, lagged.then(you[i].lag)), raw.z))) this.finishPass(i, false);
      });
      // Settled anywhere (on the table too): still or barely rolling for a while.
      if (Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z) < 0.25) this.slowSince ??= this.time; else this.slowSince = null;
      const settled = this.slowSince !== null && this.time - this.slowSince > DEAD.still * play.timeScale;
      if (!two) {
        // In a match the bot goes to where it will meet the player's return that has landed on its
        // half, and hits it as it gets there, now and then getting it wrong (more often the harder
        // the ball came at it). In Return Challenge it only serves.
        const yours = this.shot?.by === 0;
        plan = this.mode === 'match' && yours && !this.between && this.deadAt === Infinity && !this.serve ? planReturn(ball, !!this.shot?.landed) : null;
        // The spot its shot will go to, chosen as it sets off for the ball (its paddle turns to face it).
        if (plan) this.bot.aim ??= botTarget(play.botLevel, this.rand, rigs[0].paddle);
        if (plan && plan.t <= worldDt * 1.01 && dist(this.bot.pos, plan.at) < 0.3) {
          const aim = this.bot.aim ?? undefined;
          const mistake = botMistake(play.botLevel, Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z) / play.timeScale, this.rand);
          // (Its paddle's sound is the only thing of the hit left to say: the round has taken it in.)
          this.events.push(lagged.hitThen(0, (struck) => (mistake ? missShot(struck.pos, mistake, this.rand) : botShot(struck.pos, play.botLevel, this.rand, aim)))[0]);
          Object.assign(this, { touchedAt: this.time, slowSince: null, bouncedOn: null, shot: newShot(1) });
          this.bot.hitAt = this.time;
          this.bot.aim = null;
        }
        if (!this.serve) {
          const goal = plan?.at ?? BOT.home, bot = this.bot.pos;
          const away = dist(goal, bot);
          const move = Math.min(1, (BOT.speed * worldDt) / (away || 1));
          this.bot.pos = v3(bot.x + (goal.x - bot.x) * move, bot.y + (goal.y - bot.y) * move, bot.z + (goal.z - bot.z) * move);
        }
      }
      if (settled || this.time > this.deadAt || this.time - Math.max(this.servedAt, this.touchedAt) > DEAD.stalled * play.timeScale) this.stopFlight();
    } else if (!two && !this.serve) {
      // Back home between points, to hold the ball for its serve.
      const bot = this.bot.pos, k = 1 - Math.exp(-5 * worldDt);
      this.bot.pos = v3(bot.x + (BOT.home.x - bot.x) * k, bot.y + (BOT.home.y - bot.y) * k, bot.z + (BOT.home.z - bot.z) * k);
    }
    this.moveRobot(worldDt, plan);
    // Each assist's slide for the next frame: a swinging blade towards where the ball will meet
    // it, quickly as it nears, and slowly back once it's gone.
    rigs.forEach((rig, i) => {
      const { raw } = pads[i], { paddleVel, swing, live, lag } = you[i];
      const seen = this.flying && this.lagged && raw && paddleVel && live ? mineBall(rig.end, this.lagged.then(lag)) : null;
      const nudge = seen && raw && paddleVel ? interceptNudge(seen, raw, paddleVel, swing, play.timeScale, help) : null;
      tmp.set(nudge?.x ?? 0, nudge?.y ?? 0, nudge?.z ?? 0);
      rig.nudge.lerp(tmp, 1 - Math.exp(-(nudge ? 30 : 5) * dt));
    });
    keep();
  }
}
