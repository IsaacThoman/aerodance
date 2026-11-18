import * as THREE from 'three';
import { TABLE, stepBall, v3 } from '../../minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../../minigames/table-tennis/ball.ts';
import { botServe, botShot, botTarget } from '../../minigames/table-tennis/bot.ts';
import type { BotLevel } from '../../minigames/table-tennis/bot.ts';
import type { FlightEvent } from '../../minigames/table-tennis/flight.ts';
import { endOf, heldBall, mine, mineBall, otherEnd } from '../../minigames/table-tennis/rally.ts';
import type { End } from '../../minigames/table-tennis/rally.ts';
import { BLADE_UP, MITT, OWN_EYE, REACH, SHOULDER, TABLE_Z, newRig } from '../../minigames/table-tennis/rig.ts';
import type { Rig } from '../../minigames/table-tennis/rig.ts';
import { Round } from '../../minigames/table-tennis/round.ts';
import type { Play } from '../../minigames/table-tennis/round.ts';
import { ArmPlayer } from './arm.ts';
import { DancerPlayer } from './dancer.ts';
import type { Blade } from './dancer.ts';
import { clamp, cross, scale, seeded } from './vec.ts';

/*
 * The match the screensaver shows, without the drawing: the Table Tennis minigame's own round
 * (round.ts: the ball's physics, the paddles meeting it, the robot arm's bot and its serve, dead
 * balls taken back) played by stand-ins instead of tracked people. Each stand-in (a glass dancer,
 * dancer.ts, or an arm, arm.ts) says where its paddle's blade is each frame, and it's handed to
 * the round as a tracked player's hand would be (holdBlade), so the round judges every hit
 * against the paddle that's drawn.
 *
 *   robot     a dancer at the near end against the robot arm (the round's bot) at the far end;
 *             the dancer raises its free hand and the robot serves, as the minigame's player does
 *   dancers   two dancers, the round's two-player open rally: each serves in turn (two serves
 *             each), tossing the ball up and swinging through it
 *   robots    an arm at each end: the near one plays as the bot does, mirrored
 *
 * What the round leaves to the players is theirs: where each shot goes and how hard (the bot's
 * own shots and serves, bot.ts, which every stand-in plays, mirrored), and now and then a shot
 * into the net or wide that ends the point (more likely the longer the rally). The match keeps
 * the score (first to 11, by 2), pauses between points, and keeps the ball that went dead
 * visible, rolling and fading, while the next one comes into play.
 */

export type Scenario = 'robot' | 'dancers' | 'robots';
export const SCENARIOS: readonly Scenario[] = ['robot', 'dancers', 'robots'];
export const isScenario = (s: string): s is Scenario => (SCENARIOS as readonly string[]).includes(s);

/** Between points (s): the pause before the next serve, a little longer after a long rally, and after a game. */
const PAUSE = { min: 1.5, spread: 1.1, perShot: 0.06, game: 3.4 } as const;
/** A shot's chance of going astray: `base`, and `perShot` more for each shot of the rally so far, up to `max`; a serve's. */
const ERRORS = { base: 0.07, perShot: 0.022, max: 0.35, serve: 0.04 } as const;
/** The dead ball fades over this long (s); the next ball comes into play this long after the point. */
const DEAD_FADE = 0.9;
const NEXT_BALL = 0.55;
const POINTS_TO_WIN = 11;

export type Miss = 'net' | 'wide' | 'long';
export type Player = DancerPlayer | ArmPlayer;

/** A point that's been played: who won it, and how many shots it had (the serve too). */
export interface PointResult { winner: End; shots: number; how: 'winner' | 'net' | 'out' | 'missed'; }

const tmp = { m: new THREE.Matrix4(), x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };

/**
 * Hands a stand-in's blade (its own frame) to the round as its paddle hand, where a tracked
 * player's hand would be: the wrist from its shoulder (rig.ts's body frame, before its reach) and
 * the hand's way and turn, with the drawn hand already there, so the round's easing (for a
 * camera's ~30 Hz) leaves it exactly where it's put.
 */
export function holdBlade(rig: Rig, b: Blade, now: number) {
  const side = rig.paddle, sh = SHOULDER[side], reach = MITT + BLADE_UP;
  const w = { x: b.c.x - OWN_EYE.x - sh.x - b.d.x * reach, y: b.c.y - OWN_EYE.y - sh.y - b.d.y * reach, z: b.c.z - OWN_EYE.z - sh.z - b.d.z * reach };
  const across = cross(b.d, b.n);
  rig.before[side] = rig.hands[side];
  rig.hands[side] = { at: now, pose: { wrist: scale(w, 1 / REACH), dir: { ...b.d }, across, from: 'pose' } };
  const drawn = rig.drawn[side];
  drawn.wrist.set(w.x, w.y, w.z);
  tmp.m.makeBasis(tmp.x.set(across.x, across.y, across.z), tmp.y.set(b.d.x, b.d.y, b.d.z), tmp.z.set(b.n.x, b.n.y, b.n.z));
  drawn.turn.setFromRotationMatrix(tmp.m);
  drawn.started = true;
  // No calibration to drift: a stand-in's paddle is where it says.
  rig.shift.set(0, 0, 0);
  rig.shifted.set(0, 0, 0);
}

/**
 * A shot from `from` (the hitter's own frame, them at +z) that misses: into the net, wide of the
 * table, or long off its far end. Checked against the ball's physics; null if none could be found.
 */
export function missShot(from: V3, kind: Miss, rand: () => number): V3 | null {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (kind === 'net') {
      // Aimed at the net's middle, from a little above the table up (the air brings it down
      // lower than it's aimed), the first that catches in it.
      const x = (rand() * 2 - 1) * 0.45, T = 0.3 + rand() * 0.1, start = rand() * 0.04;
      for (let h = 0.03 + start; h < 0.3; h += 0.02) {
        const vel = ballistic(from, v3(x, TABLE.top + h, 0), T);
        if (missesAsSaid(from, vel, kind)) return vel;
      }
      continue;
    }
    const s = rand() < 0.5 ? -1 : 1;
    const [to, T] = kind === 'wide'
      ? [v3(s * (TABLE.halfWidth + 0.3 + rand() * 0.35), TABLE.top, -(0.55 + rand() * 0.6)), 0.5 + rand() * 0.15]
      : [v3((rand() * 2 - 1) * 0.4, TABLE.top + 0.1, -(TABLE.halfLength + 0.35 + rand() * 0.4)), 0.62 + rand() * 0.15];
    const vel = ballistic(from, to, T);
    if (missesAsSaid(from, vel, kind)) return vel;
  }
  return null;
}

/** The velocity from `from` to `to` in `T` seconds as if without air, a little harder across (the air slows it). */
const ballistic = (from: V3, to: V3, T: number): V3 =>
  v3(((to.x - from.x) / T) * 1.05, (to.y - from.y + 0.5 * 9.81 * T * T) / T, ((to.z - from.z) / T) * 1.05);

/** Whether a ball leaving `from` at `vel` (own frame) misses the way it's meant to. */
function missesAsSaid(from: V3, vel: V3, kind: Miss): boolean {
  const b: Ball = { pos: { ...from }, vel: { ...vel }, cooldown: 0 };
  for (let t = 0; t < 3; t += 1 / 240) {
    const events = stepBall(b, 1 / 240, null, null);
    for (const e of events) {
      if (kind === 'net') return e.type === 'net';
      if (e.type === 'table' || e.type === 'net') return false;
      if (e.type === 'floor') return true;
    }
  }
  return false;
}

/** The ball as drawn: where it is (the table's frame), and how big (it pops into play, and a dead one shrinks away). */
export interface DrawnBall { pos: V3; size: number; }

export class Match {
  readonly scenario: Scenario;
  readonly rand: () => number;
  readonly play: Play;
  readonly rigs: Rig[];
  readonly round: Round;
  /** Each end's stand-in (null: the round's own bot, the far end against a lone dancer or arm). */
  readonly players: [Player, Player | null];
  /** The match's clock (s). */
  time = 0;
  score: [number, number] = [0, 0];
  games: [number, number] = [0, 0];
  points: PointResult[] = [];
  /** This point: its shots so far, who hit last, whether it was the serve, the ends the ball has bounced on since. */
  shots = 0;
  hitter: End | null = null;
  serving = false;
  bounced: End[] = [];
  /** A shot of this point's is going astray (it was played to). */
  astray: Miss | null = null;
  /** When the last point ended, and when the next serve may start. */
  overAt = -Infinity;
  nextServeAt = 1.2;
  /** Who serves next with two dancers (the robot always serves against one). */
  server: End = 0;
  /** The ball that went dead, rolling on as it fades. */
  dead: { ball: Ball; at: number } | null = null;
  /** The round's ball before this frame (the dead ball's start). */
  private before: Ball = { pos: v3(), vel: v3(), cooldown: 0 };
  /** The table's bounces, newest last (the table's frame, m; the match's seconds). */
  marks: { at: V3; t: number }[] = [];
  /** What happened this frame, for the drawing. */
  events: FlightEvent[] = [];

  constructor(scenario: Scenario, seed = 1) {
    this.scenario = scenario;
    this.rand = seeded(seed);
    this.play = { forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium', botAlways: false };
    const two = scenario === 'dancers';
    this.rigs = two ? [newRig(0, 'right'), newRig(1, 'right')] : [newRig(0, 'right')];
    for (const rig of this.rigs) rig.tracked = true;
    this.round = new Round(this.rigs, this.play, this.rand);
    const near = scenario === 'robots' ? new ArmPlayer(this.rand) : new DancerPlayer('right', this.rand);
    this.players = [near, two ? new DancerPlayer('right', this.rand) : null];
    if (two) this.round.duel.server = this.server;
  }

  get two() { return this.scenario === 'dancers'; }
  /** The ball in an end's own frame. */
  ownBall(end: End): Ball { return mineBall(end, this.round.ball); }

  /** Moves the match on by `delta` seconds. */
  step(delta: number) {
    const dt = clamp(delta, 0, 1 / 20);
    if (dt <= 0) return;
    this.time += dt;
    const now = this.time, ms = now * 1000, round = this.round;
    const wasFlying = round.flying;
    this.before = { pos: { ...round.ball.pos }, vel: { ...round.ball.vel }, cooldown: 0 };
    this.serveIfDue(now);
    // Each stand-in moves, and its blade is handed to the round. They stand easy between points,
    // and get ready a moment before the serve.
    const inPlay = round.flying || !!round.serve || now > this.nextServeAt - 0.5;
    if (this.two) {
      // The server has the next ball as soon as it's in play, and goes to serve it.
      const server = !round.flying && now > this.overAt + NEXT_BALL ? this.server : null;
      this.players.forEach((p, end) => {
        if (p instanceof DancerPlayer) p.waiting = end === server ? mine(end as End, heldBall(end as End, round.time, p.hand).pos) : null;
      });
    }
    this.players.forEach((p, end) => {
      if (!p) return;
      const e = end as End;
      const drawn = this.drawnBall(), seen = drawn ? mine(e, drawn.pos) : null;
      p.update(now, dt, seen, this.ownBall(e), inPlay);
      holdBlade(this.rigs[end], p.blade, ms);
    });
    round.step(dt, ms, true);
    this.play.serve = false;
    this.events = round.events;
    for (const e of round.events) {
      if (e.type === 'paddle') this.hit(e.by ?? 1, now);
      else if (e.type === 'table') {
        this.bounced.push(endOf(e.at.z));
        this.marks.push({ at: e.at, t: now });
        if (this.marks.length > 3) this.marks.shift();
      }
    }
    // The drawn paddles are the round's (the aim assist slides them onto the ball as it comes).
    this.players.forEach((p, end) => {
      const b = this.rigs[end]?.blade;
      if (p && b) p.blade = { ...p.blade, c: mine(end as End, v3(b.center.x, b.center.y, b.center.z - TABLE_Z)) };
    });
    if (wasFlying && !round.flying) this.pointOver(now);
    if (this.dead) {
      stepBall(this.dead.ball, dt, null, null);
      if (now - this.dead.at > DEAD_FADE) this.dead = null;
    }
  }

  // The next serve, once the pause is over: against the robot the dancer raises its free hand and
  // the robot serves; with two the server tosses the ball up and serves it.
  private serveIfDue(now: number) {
    const round = this.round;
    if (round.flying || round.serve || now < this.nextServeAt) return;
    if (!this.two) {
      const p = this.players[0];
      if (p instanceof DancerPlayer) {
        if (p.askedAt < this.nextServeAt) p.askedAt = now;
        if (now - p.askedAt < 0.42) return;
      }
      if (this.serveAsked) return;
      this.serveAsked = true;
      // The robot's serves this point, as hard as its level.
      this.play.botLevel = this.level();
      this.play.serve = true;
      return;
    }
    const server = this.players[this.server] as DancerPlayer;
    if (server.stroke?.kind === 'serve') {
      // Served (or the swing missed it: toss again).
      if (now < server.stroke.contactAt + 0.4) return;
    }
    const strikeAt = now + 1.0;
    const held = mine(this.server, heldBall(this.server, round.time + (strikeAt - now), server.hand).pos);
    server.planServe(now, held, strikeAt);
  }
  private serveAsked = false;

  private level(): BotLevel {
    const r = this.rand();
    return r < 0.25 ? 'easy' : r < 0.85 ? 'medium' : 'hard';
  }

  // A paddle met the ball: the shot is the hitter's (bot.ts's own shots and serves, mirrored for a
  // near-end player), unless it goes astray; and the other end gets ready for it.
  private hit(by: End, now: number) {
    const round = this.round;
    const serve = round.servedAt === round.time;
    this.serving = serve;
    this.hitter = by;
    this.bounced = [];
    this.shots += 1;
    const errChance = serve ? ERRORS.serve : Math.min(ERRORS.max, ERRORS.base + ERRORS.perShot * (this.shots - 1));
    const astray = this.astray === null && this.rand() < errChance;
    const from = mine(by, round.ball.pos);
    const receiver = otherEnd(by);
    const level = this.level();
    // (The round's bot at the far end plays its own shots.)
    const own = this.players[by] !== null;
    let vel: V3 | null = null;
    if (astray) {
      // Into the net or wide; or, at the robot, long (a ball off the end would fly through a dancer).
      const r = this.rand();
      const towardsDancer = this.players[receiver] instanceof DancerPlayer;
      const kind: Miss = serve ? 'net' : r < 0.45 ? 'net' : r < 0.8 || towardsDancer ? 'wide' : 'long';
      vel = missShot(from, kind, this.rand);
      if (vel) this.astray = kind;
    }
    if (!vel && own) {
      // Fair: a serve off its own half and onto the other's, or a shot onto the other half.
      const fromBot = mine(1, from);
      const hand = 'right';
      if (serve) vel = mine(1, botServe(fromBot, level === 'hard' ? 'medium' : level, this.rand, hand)?.vel ?? v3(0, 0, 3));
      else vel = mine(1, botShot(fromBot, level, this.rand, botTarget(level, this.rand, hand)));
    }
    if (vel) {
      round.ball.vel = mine(by, vel);
      round.lagged?.restart(round.ball, round.lagged.time);
    }
    // The other end reads it.
    this.players[receiver]?.incoming(now, mineBall(receiver, round.ball), serve, (this.rand() * 2 - 1) * 0.5);
  }

  private pointOver(now: number) {
    const other = this.hitter === null ? 0 : otherEnd(this.hitter);
    const h = this.hitter ?? 1;
    // The last shot was good (the serve off its own half first) and wasn't returned: its hitter wins it.
    const fair = this.serving ? this.bounced[0] === h && this.bounced[1] === other : this.bounced[0] === other;
    const winner: End = fair ? h : other;
    const how: PointResult['how'] = fair ? (this.bounced.length >= 2 ? 'missed' : 'winner') : this.astray === 'net' ? 'net' : 'out';
    this.points.push({ winner, shots: this.shots, how });
    if (this.points.length > 50) this.points.shift();
    this.score[winner] += 1;
    let pause = PAUSE.min + this.rand() * PAUSE.spread + Math.min(10, this.shots) * PAUSE.perShot;
    const [a, b] = this.score;
    if (Math.max(a, b) >= POINTS_TO_WIN && Math.abs(a - b) >= 2) {
      this.games[a > b ? 0 : 1] += 1;
      this.score = [0, 0];
      pause = PAUSE.game;
    }
    this.dead = { ball: { pos: { ...this.before.pos }, vel: { ...this.before.vel }, cooldown: 0 }, at: now };
    this.overAt = now;
    this.nextServeAt = now + pause;
    this.shots = 0;
    this.hitter = null;
    this.astray = null;
    this.serveAsked = false;
    this.bounced = [];
    if (this.two) {
      // Two serves each.
      const played = this.score[0] + this.score[1];
      this.server = (Math.floor(played / 2) % 2) as End;
      this.round.duel.server = this.server;
      this.round.heldSince = this.round.time;
    }
  }

  /**
   * The ball as drawn (the table's frame), or null while there's none in play: the round's, or
   * in the server's hand and tossed up; after a point, the next one popping in.
   */
  drawnBall(): DrawnBall | null {
    const round = this.round, now = this.time;
    const since = now - this.overAt - NEXT_BALL;
    if (since < 0) return null;
    const size = Math.min(1, since / 0.18);
    if (this.two && !round.flying) {
      const toss = (this.players[this.server] as DancerPlayer).tossBall(now);
      return toss ? { pos: mine(this.server, toss), size } : null;
    }
    return { pos: { ...round.ball.pos }, size };
  }

  /** The dead ball as drawn, shrinking and fading (null when there's none). */
  deadBall(): DrawnBall | null {
    if (!this.dead) return null;
    const u = (this.time - this.dead.at) / DEAD_FADE;
    return { pos: this.dead.ball.pos, size: Math.max(0, 1 - u * u) };
  }

  /** Average shots a point, over the points kept. */
  meanShots(): number { return this.points.length ? this.points.reduce((s, p) => s + p.shots, 0) / this.points.length : 0; }
}

