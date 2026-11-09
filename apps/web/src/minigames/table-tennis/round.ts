/*
 * A round of Table Tennis, without the drawing: the ball, the players' paddles (rig.ts) and,
 * alone, the robot's, a frame at a time. Game.tsx draws what's here; the tests play it without a
 * screen (apps/web/tests/table-tennis-agency.test.ts).
 *
 * Alone, the ball is held on the robot's paddle until a serve (the player's free hand raised, or
 * Space), tossed up and struck, then flies (ball.ts) in the table's frame at the time's speed,
 * met by the player's paddle as it moved this frame (as it was a lag ago: LaggedBall, flight.ts).
 * A return that lands on the far half counts, and the bot (bot.ts) plays it back, the robot's
 * paddle drawn back, swung through the ball and followed through (robot.ts): a rally lasts as
 * long as the player keeps returning it.
 *
 * With two, the ball waits in the air over the server's end (rally.ts SERVE) until their swing
 * serves it (assist.ts serveHit; or Space), and the open rally (rally.ts) counts the shots that
 * land on the other half.
 *
 * Either way a ball that's out of play is soon taken back (DEAD): on the floor, in the net, or
 * bouncing twice on one half with nobody hitting it. With two it goes to whoever's end it
 * finished at.
 */

import * as THREE from 'three';
import { ASSIST, SERVE_SWING, SWING, assistReturn, interceptNudge, serveHit, swingOf } from './assist.ts';
import type { AssistLevel } from './assist.ts';
import { arrival, autoplayBlade, autoplayRaised, autoplayServe } from './autoplay.ts';
import { PADDLE_COOLDOWN, v3 } from './ball.ts';
import type { Ball, PaddlePose, V3 } from './ball.ts';
import { BOT, botServe, botShot, botTarget, planReturn, reachRoom } from './bot.ts';
import type { BotLevel } from './bot.ts';
import { coming, endPass, recalibrate, trackPass } from './calibrate.ts';
import type { Pass, PassResult } from './calibrate.ts';
import { flightStep } from './flight.ts';
import type { FlightEvent, Swinger } from './flight.ts';
import { LaggedBall } from './lagged.ts';
import { SERVE, bounced, dead, endOf, heldBall, hit, mine, mineBall, newRally, otherEnd, served } from './rally.ts';
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
// How late the paddle is to the ball, stepped through with L: 'auto' is the tracker's measured
// delay (camera to result) and DRAW_LAG more for the hand's easing and the screen; or set, in seconds.
export const HIT_LAGS = ['auto', 0, 0.06, 0.1, 0.15] as const;
export type HitLag = typeof HIT_LAGS[number];
export const DRAW_LAG = 0.05;

/** The round's settings, and the keys pressed for it. */
export interface Play {
  forgiving: boolean;
  /** Space was pressed: serve a ball. */
  serve: boolean;
  /** How fast the ball's world runs (1: real time). */
  timeScale: number;
  /** How late the paddle is to the ball (hits are judged against the ball as it was then). */
  hitLag: HitLag;
  /** How much the aim assist helps (assist.ts). */
  assist: AssistLevel;
  /** Alone: how hard the bot's shots are, and whether it returns the player's misses too. */
  botLevel: BotLevel;
  botAlways: boolean;
}

/** How late a player's paddle is to the ball, in the ball's time (the camera off: not at all). */
const lagOf = (rig: Rig, play: Play) => (!rig.tracked ? 0 : (play.hitLag === 'auto' ? (rig.latency > 0 ? rig.latency + DRAW_LAG : 0) : play.hitLag) * play.timeScale);

/** Each player's part of the ball's frame: their paddle last frame (the table's frame) and where they'd moved it (their own), their swings, the ball's pass, their free hand. */
interface Player {
  paddle: PaddlePose | null; moved: V3 | null; speeds: { t: number; vel: V3 }[]; pass: Pass | null; raised: boolean;
  /** When they last swung or hit (their own seconds; never: -Infinity). */
  active: number;
}

const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const tmp = new THREE.Vector3();

export class Round {
  readonly rigs: Rig[];
  readonly play: Play;
  readonly two: boolean;
  readonly rand: () => number;
  ball: Ball;
  lagged: LaggedBall | null = null;
  /** The ball's drawn place, from its real one (eased onto a rewound hit's by Game.tsx), set when a hit moves it. */
  drawnOff = v3();
  flying = false;
  deadAt = Infinity;
  slowSince: number | null = null;
  servedAt = -Infinity;
  hits = 0;
  returns = 0;
  hitThisServe = false;
  /** The ball's world's time, and the players' own. */
  time = 0;
  real = 0;
  players: Player[];
  /** When the ball was last hit (by anyone), alone the rally's returns so far and the best, and since when the ball's been held to serve. */
  touchedAt = -Infinity;
  rally = 0;
  best = 0;
  heldSince = 0;
  /** Alone: the player hit the ball last, and their return has had its one fair bounce (for the bot to play). */
  yours = false;
  farBounce = false;
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
  /** With two: the open rally, and each player's hits. */
  duel = newRally(0);
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
    this.ball = this.two ? heldBall(0, 0, rigs[0].paddle) : { pos: onPaddle(this.arm), vel: v3(), cooldown: 0 };
    this.players = rigs.map((): Player => ({ paddle: null, moved: null, speeds: [], pass: null, raised: false, active: -Infinity }));
    this.passes = rigs.map(() => null);
  }

  /** Who's waiting to serve: alone, the player (for the robot to serve), while the ball's held. */
  server(): End { return this.two ? this.duel.server : 0; }
  holding() { return !this.flying && !this.serve; }
  /** Whether a player has swung or hit lately (SERVE.away). */
  playing(end: End) { return this.real - this.players[end].active <= SERVE.away; }
  /** With two: the waiting ball can be served (it has waited long enough). */
  armed() { return this.two && this.holding() && this.time - this.heldSince >= SERVE.arm * this.play.timeScale; }

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
      const seen = this.flying && this.lagged ? mineBall(rig.end, this.lagged.then(lagOf(rig, play))) : null;
      const blade = this.two && mineToServe ? autoplayServe((this.time - this.heldSince) / play.timeScale, mine(rig.end, heldBall(rig.end, 0, rig.paddle).pos))
        : autoplayBlade(seen && arrival(seen, play.timeScale), rig.paddle);
      rig.hands[rig.paddle] = { at: now, pose: { ...heldPose(rig.paddle, REST[rig.paddle]), wrist: wristFor(rig, blade) } };
      const raised = !this.two && autoplayRaised(mineToServe ? this.time - this.heldSince : null);
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
    const held = !this.flying;
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

  private endRally() { if (this.rally) { this.best = Math.max(this.best, this.rally); this.rally = 0; } }

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

  // The ball's flight over (it's dead, or a stalled rally's ball taken back).
  private over() {
    this.flying = false;
    this.bot.aim = null;
    this.heldSince = this.time;
    this.serveSeen = null;
    if (this.two) {
      // To whoever's end it finished at; unless they aren't playing (away, or not looking) and the other is.
      const at = endOf(this.ball.pos.z), other = otherEnd(at);
      dead(this.duel, this.playing(at) || !this.playing(other) ? at : other);
    } else this.endRally();
    this.rigs.forEach((_, i) => this.finishPass(i, false));
  }

  /** The ball's flight begins (a serve's strike), from where it is, at `vel`. */
  private launch(vel: V3, cooldown = 0) {
    this.ball = { pos: { ...this.ball.pos }, vel, cooldown };
    this.lagged = new LaggedBall(this.ball, this.time);
    this.drawnOff = v3();
    for (const p of this.players) p.pass = null;
    Object.assign(this, { flying: true, deadAt: Infinity, slowSince: null, servedAt: this.time, bouncedOn: null });
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
      if (swing.x || swing.y || swing.z) p.active = this.real;
      // (A serve's swing is a longer one than a rally's.)
      return { paddleVel, live, wasRaised, lag: lagOf(rig, play), swing, serveSwing: () => borne(SERVE_SWING.travel) };
    });
    const s = this.server();
    let plan: { t: number; at: V3 } | null = null;
    if (two) {
      // Space serves (a stalled rally's ball taken back to the server first).
      if (play.serve && this.flying) { this.over(); this.duel.server = s; this.heldSince = this.time; }
      if (!this.flying) {
        // Left waiting too long, the ball goes to the other player to serve.
        if (this.time - this.heldSince > SERVE.pass * play.timeScale) { this.duel.server = otherEnd(s); this.heldSince = this.time; this.serveSeen = null; }
        const server = this.server(), rig = rigs[server];
        const held = heldBall(server, this.time, rig.paddle);
        this.ball.pos = held.pos; this.ball.vel = held.vel;
        const from = mine(server, held.pos);
        const { raw } = pads[server], { live } = you[server];
        const pose = rig.hands[rig.paddle];
        let vel: V3 | null = play.serve ? { ...SERVE.key } : null;
        if (!vel && (!live || !pose)) this.serveSeen = null;
        else if (!vel && this.serveSeen && pose && pose.at > this.serveSeen.at) {
          // The tracker's next pose bears the swing out, unless the hand has sprung back: one wild
          // pose (the arm's depth read the wrong way round, say) isn't a swing.
          const w = pose.pose.wrist, was = this.serveSeen.wrist, way = this.serveSeen.way;
          if ((w.x - was.x) * way.x + (w.y - was.y) * way.y + (w.z - was.z) * way.z > -SWING.sprung) vel = this.serveSeen.vel;
          this.serveSeen = null;
        } else if (!vel && !this.serveSeen && pose && this.armed() && raw) {
          const swing = you[server].serveSwing();
          const seen = serveHit(from, raw, swing, help);
          const l = Math.hypot(swing.x, swing.y, swing.z) || 1;
          if (seen) this.serveSeen = { vel: seen, at: pose.at, wrist: { ...pose.pose.wrist }, way: v3(swing.x / l, swing.y / l, swing.z / l) };
        }
        if (vel) {
          // A serve lands, whatever the level (but with the assist off).
          this.serveSeen = null;
          this.launch(mine(server, assistReturn(from, vel, play.assist === 'off' && !play.serve ? 0 : 1)), PADDLE_COOLDOWN);
          served(this.duel);
          this.hits += 1; this.hitsBy[server] += 1; this.touchedAt = this.time; this.players[server].active = this.real;
          this.events.push({ type: 'paddle', at: { ...this.ball.pos }, speed: Math.hypot(vel.x, vel.y, vel.z), by: server });
        }
      }
    } else {
      // The player's free hand raised (not in the middle of a rally: an arm swung up mid-rally isn't a serve), or Space.
      const idle = !this.flying || this.time - Math.max(this.servedAt, this.touchedAt) > RAISED.again * play.timeScale;
      const asked = play.serve || (this.players[0].raised && idle && (!you[0].wasRaised || this.time - this.servedAt > RAISED.again * play.timeScale));
      // A serve asked for: the ball back to the robot if it's still out (a rally stalled), and served once it's holding it.
      if (asked && !this.serve) {
        this.serveAsked = true;
        if (this.flying) this.over();
      }
      if (this.holding() && this.serveAsked && dist(this.bot.pos, BOT.home) < 0.02 && dist(this.bot.normal, HOLD_NORMAL) < 0.05) {
        this.endRally();
        // Struck from above where it's held, down onto its own half and over onto the player's.
        const from = serveStrike(this.arm.pos);
        const flight = botServe(from, play.botLevel, this.rand, rigs[0].paddle);
        const vel = flight?.vel ?? v3(0, 0, 3);
        const dir = heading(from, flight?.second ?? v3(0, 0, 1));
        const tilt = Math.min(0.35, Math.max(-0.2, Math.atan2(vel.y, Math.hypot(vel.x, vel.z))));
        this.serve = planServe(this.time, this.arm.pos, dir, faceNormal(dir, tilt));
        this.serveVel = vel;
        this.serveAsked = false;
      }
    }
    play.serve = false;
    const b = this.ball;
    if (!two && this.serve && !this.flying && this.time >= this.serve.strikeAt) {
      // The strike: the ball's flight begins.
      b.pos = { ...this.serve.strike };
      this.launch({ ...this.serveVel });
      this.events.push({ type: 'paddle', at: { ...this.serve.strike }, speed: Math.hypot(this.serveVel.x, this.serveVel.y, this.serveVel.z) });
      Object.assign(this, { hitThisServe: false, yours: false, farBounce: false });
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
      const swingers: Swinger[] = rigs.map((rig, i) => ({
        // (A lost hand's paddle, sinking to its rest, is still there for the ball to meet, as it's drawn; it swings at nothing.)
        end: rig.end, raw: you[i].live ? pads[i].raw : null, paddleVel: you[i].paddleVel, swing: you[i].swing, lag: you[i].lag,
        from: this.players[i].paddle ?? pads[i].paddle, to: pads[i].paddle,
      }));
      const flight = flightStep(lagged, worldDt, swingers, help, play.timeScale);
      this.events.push(...flight.events);
      // Drawn from where it was, easing onto where a hit (judged a lag ago) put it.
      const by = flight.events.find((e): e is FlightEvent & { type: 'paddle' } => e.type === 'paddle')?.by;
      if ((flight.swung || flight.hit) && by !== undefined && you[by].lag > 0) this.drawnOff = v3(before.x + this.drawnOff.x - ball.pos.x, before.y + this.drawnOff.y - ball.pos.y, before.z + this.drawnOff.z - ball.pos.z);
      const out = (after: number) => { this.deadAt = Math.min(this.deadAt, this.time + after * play.timeScale); };
      for (const e of flight.events) {
        if (e.type === 'paddle') { this.deadAt = Infinity; this.bouncedOn = null; }
        if (two) {
          if (e.type === 'paddle' && e.by !== undefined) { this.hits += 1; this.hitsBy[e.by] += 1; hit(this.duel, e.by); this.touchedAt = this.time; this.players[e.by].active = this.real; this.finishPass(e.by, true); }
          if (e.type === 'table' && bounced(this.duel, endOf(e.at.z)) === 'fair') this.returns += 1;
        } else {
          if (e.type === 'paddle') { this.hits += 1; this.hitThisServe = true; this.yours = true; this.touchedAt = this.time; this.farBounce = false; this.finishPass(0, true); }
          if (e.type === 'table' && e.side === 'far' && this.hitThisServe) { this.returns += 1; this.rally += 1; this.hitThisServe = false; this.farBounce = true; }
          // Anything else after the far half's bounce: the bot can't play it.
          else if (e.type !== 'paddle') this.farBounce = false;
          if (e.type === 'table' && e.side === 'near') this.hitThisServe = false;
        }
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
        // The bot goes to where it will meet the player's return (a fair one, or any it can get to if
        // it returns everything), and hits it as it gets there. Returning a miss ends the rally's count.
        plan = this.yours && this.deadAt === Infinity && !this.serve ? planReturn(ball, this.farBounce, play.botAlways) : null;
        // The spot its shot will go to, chosen as it sets off for the ball (its paddle turns to face it).
        if (plan) this.bot.aim ??= botTarget(play.botLevel, this.rand, rigs[0].paddle);
        if (plan && plan.t <= worldDt * 1.01 && dist(this.bot.pos, plan.at) < 0.3) {
          if (!this.farBounce) this.endRally();
          const aim = this.bot.aim ?? undefined;
          // (Its paddle's sound is the only thing of the hit left to say: the round has taken it in.)
          this.events.push(lagged.hitThen(0, (struck) => botShot(struck.pos, play.botLevel, this.rand, aim))[0]);
          Object.assign(this, { touchedAt: this.time, hitThisServe: false, yours: false, farBounce: false, slowSince: null, bouncedOn: null });
          this.bot.hitAt = this.time;
          this.bot.aim = null;
        }
        if (!this.serve) {
          const goal = plan?.at ?? BOT.home, bot = this.bot.pos;
          const away = dist(goal, bot);
          // Returning everything, it's as quick as it needs to be to get there.
          const speed = plan && play.botAlways ? Math.max(BOT.speed, away / Math.max(plan.t, worldDt)) : BOT.speed;
          const move = Math.min(1, (speed * worldDt) / (away || 1));
          this.bot.pos = v3(bot.x + (goal.x - bot.x) * move, bot.y + (goal.y - bot.y) * move, bot.z + (goal.z - bot.z) * move);
        }
      }
      if (settled || this.time > this.deadAt || this.time - Math.max(this.servedAt, this.touchedAt) > DEAD.stalled * play.timeScale) this.over();
    } else if (!two && !this.serve) {
      // Back home between rallies, to hold the ball.
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
