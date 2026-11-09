/*
 * Table Tennis played without a screen: pretend people at a pretend webcam, through the game's
 * own round (round.ts), to measure how the game feels to someone who plays well, badly, or not at
 * all (table-tennis-agency.test.ts; tools/table-tennis/agency.ts prints the tables).
 *
 * A person (Person) moves their real paddle hand, in their own frame (rally.ts mine), by what
 * they see of the ball now. A camera (Camera) sees the hand late and wrongly: sampled at its
 * rate, each sample arriving a delay later, off by a steady error, a slowly wandering one and a
 * pose-to-pose one (most in depth, and more in a swing: TRACKING, as measured), now and then a
 * wild one, or none at all for a stretch. What arrives goes
 * through the game's own filters (rig.ts takeHand), eased hands and paddle, and the round's
 * frames at the screen's rate.
 */

import { TABLE, v3 } from '../../src/minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../../src/minigames/table-tennis/ball.ts';
import { defaultAssist } from '../../src/minigames/table-tennis/assist.ts';
import type { AssistLevel } from '../../src/minigames/table-tennis/assist.ts';
import { AUTOPLAY, arrival } from '../../src/minigames/table-tennis/autoplay.ts';
import type { BotLevel } from '../../src/minigames/table-tennis/bot.ts';
import { heldBall, mine, mineBall } from '../../src/minigames/table-tennis/rally.ts';
import type { End } from '../../src/minigames/table-tennis/rally.ts';
import { BLADE_UP, MITT, OWN_EYE, REACH, REST, SHOULDER, heldPose, newHandFilters, newRig, takeAge, takeHand } from '../../src/minigames/table-tennis/rig.ts';
import type { HandFilters, Rig } from '../../src/minigames/table-tennis/rig.ts';
import { Round } from '../../src/minigames/table-tennis/round.ts';
import type { Play } from '../../src/minigames/table-tennis/round.ts';
import type { Side } from '../../src/minigames/table-tennis/arms.ts';

/** A seeded random source (mulberry32), and a normal one from it. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return { rand, normal };
}
type Random = ReturnType<typeof seeded>;

/** How a person plays. */
export interface Skill {
  /**
   * idle: hands down by their sides. still: the paddle held up in front, not moved. flail: swings
   * all the time, at nothing. play: watches the ball and swings at it.
   */
  kind: 'idle' | 'still' | 'flail' | 'play';
  /** How far off their swing's aim is (m, standard deviation across and up), and in depth. */
  aim: number;
  depth: number;
  /** How far off its timing is (s, standard deviation). */
  timing: number;
  /** How long the forward swing takes (s): shorter is faster. */
  swing: number;
  /** The share of balls they don't go for at all (looking away, too late). */
  lapse: number;
}
export const SKILLS = {
  idle: { kind: 'idle', aim: 0, depth: 0, timing: 0, swing: 0.17, lapse: 0 },
  still: { kind: 'still', aim: 0, depth: 0, timing: 0, swing: 0.17, lapse: 0 },
  flail: { kind: 'flail', aim: 0, depth: 0, timing: 0, swing: 0.17, lapse: 0 },
  /** New to it: often late or early, a hand's width off. */
  novice: { kind: 'play', aim: 0.1, depth: 0.15, timing: 0.07, swing: 0.2, lapse: 0.08 },
  /** Has the hang of it. */
  casual: { kind: 'play', aim: 0.06, depth: 0.1, timing: 0.04, swing: 0.17, lapse: 0.03 },
  /** Plays well. */
  good: { kind: 'play', aim: 0.03, depth: 0.06, timing: 0.02, swing: 0.15, lapse: 0.01 },
} as const satisfies Record<string, Skill>;

/** A hand's error as the tracker reads it (m, the player's own frame: x right, y up, z back): steady, slowly wandering, and from pose to pose. */
export interface Noise { bias: V3; slow: V3; fast: V3; }
/** How a camera and its tracking see a paddle hand. */
export interface Tracking {
  /** Poses a second, and how long after the hand was there each arrives (s), give or take `jitter`. */
  hz: number;
  delay: number;
  jitter: number;
  /** The blade's error with the hand at rest and in a swing (in between, in between). */
  rest: Noise;
  swing: Noise;
  /** How much the steady error differs from one round to the next (m, standard deviation per axis). */
  biasSpread: V3;
  /** The share of poses that are wild, and how far off (m, any direction). */
  wildRate: number;
  wild: number;
  /** How often the hand is lost for a stretch (a minute), and for how long (s). */
  lostPerMinute: number;
  lostS: number;
}
const cm = (x: number, y: number, z: number): V3 => v3(x / 100, y / 100, z / 100);
const NONE: Noise = { bias: v3(), slow: v3(), fast: v3() };
/** The slow error wanders over about this long (s). */
const SLOW_S = 0.4;
/**
 * The cameras. `one` and `two` are measured: the tracked blade's error on trackbench's ping-pong
 * scenes with the game's own tracking (tools/trackbench/PINGPONG.md, "Noise profile of the
 * tracked blade": one player on 11 scenes; two players on two held-out scenes, so roughly), the
 * tracker's rate and delay from its realtime runs with 50 ms more for a webcam's own. Its wild
 * poses are counted at half their measured share, the pose-to-pose error in swings holding the
 * rest of them. Measured on renders, not on people: real footage will say more.
 */
export const TRACKING = {
  /** A camera that sees everything exactly, at once. */
  perfect: { hz: 60, delay: 0, jitter: 0, rest: NONE, swing: NONE, biasSpread: v3(), wildRate: 0, wild: 0, lostPerMinute: 0, lostS: 0 },
  /** One player at a webcam. */
  one: {
    hz: 29, delay: 0.08, jitter: 0.01,
    rest: { bias: cm(0.5, -1.6, -1.9), slow: cm(2.6, 2.6, 6.5), fast: cm(1.3, 1.7, 2.3) },
    swing: { bias: cm(0.9, -5.9, -4.7), slow: cm(2.4, 3.8, 8.6), fast: cm(4.5, 4.4, 9.2) },
    biasSpread: cm(1.3, 0.6, 2.8), wildRate: 0.02, wild: 0.19, lostPerMinute: 1.1, lostS: 0.4,
  },
  /** Two players at one webcam: slower, later, each smaller in the picture. */
  two: {
    hz: 22, delay: 0.105, jitter: 0.02,
    rest: { bias: cm(2.5, -1.6, 1.7), slow: cm(6.7, 4.1, 7.6), fast: cm(1.8, 2.1, 3.0) },
    swing: { bias: cm(0.7, -10.7, -7.6), slow: cm(8.8, 6.7, 9.8), fast: cm(9.4, 9.4, 13.0) },
    biasSpread: cm(0.6, 2.4, 1.1), wildRate: 0.08, wild: 0.23, lostPerMinute: 1.6, lostS: 0.4,
  },
} as const satisfies Record<string, Tracking>;

const add = (a: V3, b: V3, k = 1): V3 => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const mix = (a: V3, b: V3, u: number): V3 => v3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
const smooth = (u: number) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };
const sign = (hand: Side) => (hand === 'left' ? -1 : 1);

/** The wrist (from its shoulder, real metres, the body's frame) that has the paddle's blade at a place in the player's own frame. */
function wristOf(hand: Side, blade: V3): V3 {
  const d = heldPose(hand, REST[hand]).dir, s = SHOULDER[hand], reach = MITT + BLADE_UP;
  return v3((blade.x - OWN_EYE.x - s.x - d.x * reach) / REACH, (blade.y - OWN_EYE.y - s.y - d.y * reach) / REACH, (blade.z - OWN_EYE.z - s.z - d.z * reach) / REACH);
}

/** Where the blade is (own frame) for a wrist so (from its shoulder, real metres). */
function bladeOf(hand: Side, wrist: V3): V3 {
  const d = heldPose(hand, REST[hand]).dir, s = SHOULDER[hand], reach = MITT + BLADE_UP;
  return v3(OWN_EYE.x + s.x + wrist.x * REACH + d.x * reach, OWN_EYE.y + s.y + wrist.y * REACH + d.y * reach, OWN_EYE.z + s.z + wrist.z * REACH + d.z * reach);
}

/** A swing under way: drawn back by `from`, through `at` at the time `t`, and on. */
interface Stroke { at: V3; t: number; start: V3; startT: number; }

/** A pretend person at one end: where their real hands are at each moment. */
export class Person {
  readonly end: End;
  readonly hand: Side;
  readonly skill: Skill;
  private random: Random;
  private stroke: Stroke | null = null;
  /** The ball they've made up their mind about (by when it was last hit), and whether they're going for it. */
  private decided = -Infinity;
  private blade: V3;
  private nextFlail = 0;
  private serveAt: number | null = null;
  /** Bringing the paddle up to the waiting ball, before serving it. */
  private ready: { at: V3; from: V3; t: number; over: number } | null = null;
  /** Their free hand is up (alone: asking the robot to serve). */
  raised = false;
  private raiseAt: number | null = null;

  constructor(end: End, hand: Side, skill: Skill, random: Random) {
    this.end = end; this.hand = hand; this.skill = skill; this.random = random;
    this.blade = this.home();
  }

  private home(): V3 { return v3(AUTOPLAY.home.x * sign(this.hand), AUTOPLAY.home.y, AUTOPLAY.home.z); }

  private begin(at: V3, t: number, now: number) {
    const { skill, random } = this;
    const off = v3(random.normal() * skill.aim, random.normal() * skill.aim, random.normal() * skill.depth);
    this.stroke = { at: add(at, off), t: t + random.normal() * skill.timing, start: { ...this.blade }, startT: now };
  }

  /**
   * The blade's real place at `now` for a stroke: to its backswing by the time the swing starts,
   * then through the ball and on in an arc that speeds up into the ball and slows after it (its
   * fastest at the ball), a little across the body and upwards as a forehand goes.
   */
  private along(stroke: Stroke, now: number): V3 {
    const { swing } = this.skill;
    const out = sign(this.hand);
    const back = add(stroke.at, v3(0.1 * out, -0.06, 0.26));
    const through = add(stroke.at, v3(-0.12 * out, 0.1, -0.24));
    const u = (now - (stroke.t - swing)) / swing;
    if (u <= 0) return mix(stroke.start, back, smooth((now - stroke.startT) / Math.max(0.08, stroke.t - swing - stroke.startT)));
    // At the ball at u = 1, where it's fastest; done at u = 2.
    return u <= 2 ? mix(back, through, smooth(u / 2)) : through;
  }

  /**
   * Where their paddle's blade really is at `now` (s), in their own frame, given what they see:
   * the ball (their own frame) flying or waiting for them, when it was last hit, and whether
   * it's theirs to serve (and since when it has waited).
   */
  update(now: number, seen: { ball: Ball | null; touchedAt: number; serve: { ball: V3; since: number } | null; robotHolds: boolean }): V3 {
    const { skill, random } = this;
    if (skill.kind === 'idle') {
      this.raised = false;
      // Down by their side, swaying a little.
      const rest = REST[this.hand];
      return bladeOf(this.hand, v3(rest.x + 0.03 * sign(this.hand) + 0.02 * Math.sin(now * 1.3), rest.y + 0.05, rest.z - 0.05 + 0.02 * Math.sin(now * 0.9)));
    }
    // Alone, they ask the robot to serve: the free hand up a moment after it has the ball.
    if (seen.robotHolds) { this.raiseAt ??= now + 0.5 + random.rand() * 0.6; this.raised = now >= this.raiseAt && now < this.raiseAt + 0.5; if (now > this.raiseAt + 1.2) this.raiseAt = null; }
    else { this.raiseAt = null; this.raised = false; }
    if (skill.kind === 'still') return this.home();
    if (skill.kind === 'flail') {
      if (!this.stroke || now > this.stroke.t + skill.swing * 2) {
        if (now >= this.nextFlail) {
          this.begin(v3((random.rand() * 2 - 1) * 0.5, TABLE.top + 0.15 + random.rand() * 0.6, AUTOPLAY.hitZ + (random.rand() * 2 - 1) * 0.15), now + 0.25 + skill.swing, now);
          this.nextFlail = now + 0.5 + random.rand() * 0.5;
        }
      }
    } else if (seen.serve) {
      // Their serve: they bring the paddle up behind the waiting ball (getting ready isn't
      // serving), and after a moment swing through it.
      if (this.serveAt === null || seen.serve.since > this.serveAt + 1.2) {
        this.serveAt = seen.serve.since + 0.6 + random.rand() * 0.5;
        this.ready = { at: add(seen.serve.ball, v3(0.03 * sign(this.hand), 0.02 + random.rand() * 0.08, 0.12 + random.rand() * 0.06)), from: { ...this.blade }, t: now, over: 0.2 + random.rand() * 0.2 };
      }
      if (this.ready && !this.stroke && seen.serve.since >= this.serveAt - 0.05) { this.ready = null; this.begin(seen.serve.ball, now + skill.swing + 0.15, now); }
    } else {
      this.serveAt = null; this.ready = null;
      const coming = seen.ball && arrival(seen.ball);
      // A ball coming that they haven't made their mind up about: they go for it (or let it by),
      // if there's time to.
      if (coming && seen.touchedAt !== this.decided && coming.t > 0.12) {
        this.decided = seen.touchedAt;
        if (random.rand() >= skill.lapse) this.begin(coming.at, now + coming.t, now);
      }
    }
    if (this.stroke) {
      this.blade = this.along(this.stroke, now);
      // Over: back to ready, quickly.
      if (now > this.stroke.t + skill.swing * 1.3) { this.stroke = null; }
    } else if (this.ready) {
      this.blade = mix(this.ready.from, this.ready.at, smooth((now - this.ready.t) / this.ready.over));
    } else {
      this.blade = mix(this.blade, this.home(), 0.12);
    }
    return this.blade;
  }
}

/** A pretend camera on one player: their real hands in, the tracker's poses out, late and wrong. */
class Camera {
  private tracking: Tracking;
  private random: Random;
  private next = 0;
  private queue: { at: number; taken: number; wrist: V3 | null; raised: boolean }[] = [];
  private filters: HandFilters = newHandFilters();
  /** This round's share of the steady error, the slow error as it wanders (in standard deviations), and until when the hand is lost. */
  private offset: V3;
  private slow = v3();
  private lostUntil = -Infinity;
  /** The blade a frame ago, and how fast it's really moving (m/s, smoothed). */
  private was: { at: V3; t: number } | null = null;
  private speed = 0;
  constructor(tracking: Tracking, random: Random) {
    this.tracking = tracking; this.random = random; this.next = random.rand() / tracking.hz;
    this.offset = v3(random.normal() * tracking.biasSpread.x, random.normal() * tracking.biasSpread.y, random.normal() * tracking.biasSpread.z);
    this.slow = v3(random.normal(), random.normal(), random.normal());
  }

  /** Takes a picture if one's due at `now` (s), and gives the rig any poses that have arrived. */
  see(rig: Rig, person: Person, blade: V3, now: number) {
    const { tracking: k, random } = this;
    if (this.was && now > this.was.t) {
      const speed = Math.hypot(blade.x - this.was.at.x, blade.y - this.was.at.y, blade.z - this.was.at.z) / (now - this.was.t);
      this.speed += (speed - this.speed) * 0.5;
    }
    this.was = { at: { ...blade }, t: now };
    if (now >= this.next) {
      const dt = 1 / k.hz;
      this.next += dt;
      // The slow error wanders (each axis its own way), and the hand is lost for a stretch now and then.
      const keep = Math.exp(-dt / SLOW_S), fresh = Math.sqrt(1 - keep * keep);
      this.slow = v3(this.slow.x * keep + random.normal() * fresh, this.slow.y * keep + random.normal() * fresh, this.slow.z * keep + random.normal() * fresh);
      if (random.rand() < (k.lostPerMinute / 60) * dt) this.lostUntil = now + k.lostS * (0.5 + random.rand());
      // In a swing by how fast the hand really moves: at rest below half a metre a second, swinging above two.
      const u = Math.min(1, Math.max(0, (this.speed - 0.5) / 1.5));
      const part = (pick: (n: Noise) => V3) => mix(pick(k.rest), pick(k.swing), u);
      const bias = part((n) => n.bias), slow = part((n) => n.slow), fast = part((n) => n.fast);
      let seen = add(blade, v3(
        bias.x + this.offset.x + slow.x * this.slow.x + fast.x * random.normal(),
        bias.y + this.offset.y + slow.y * this.slow.y + fast.y * random.normal(),
        bias.z + this.offset.z + slow.z * this.slow.z + fast.z * random.normal()));
      if (random.rand() < k.wildRate) {
        const way = v3(random.normal(), random.normal(), random.normal()), l = Math.hypot(way.x, way.y, way.z) || 1;
        seen = add(seen, way, k.wild / l);
      }
      this.queue.push({ at: now + Math.max(0, k.delay + random.normal() * k.jitter), taken: now, wrist: now < this.lostUntil ? null : wristOf(person.hand, seen), raised: person.raised });
    }
    while (this.queue.length && this.queue[0].at <= now) {
      const pose = this.queue.shift()!;
      rig.tracked = true;
      const ms = now * 1000;
      if (pose.wrist) takeHand(rig, rig.paddle, heldPose(rig.paddle, pose.wrist), ms, this.filters, pose.taken * 1000);
      const out = rig.free === 'left' ? -0.05 : 0.05;
      takeHand(rig, rig.free, heldPose(rig.free, pose.raised ? { x: out, y: 0.3, z: -0.15 } : { x: out, y: -0.4, z: -0.1 }), ms, this.filters, pose.taken * 1000);
      takeAge(rig, (now - pose.taken) * 1000);
    }
  }
}

export interface SimOptions {
  /** One player (against the robot) or two (each other), and how each plays and is seen. */
  players: readonly { skill: Skill; tracking: Tracking; hand?: Side }[];
  seconds: number;
  seed?: number;
  /** The aim assist's level (the game's own for that many players, unless given). */
  assist?: AssistLevel;
  botLevel?: BotLevel;
  botAlways?: boolean;
  fps?: number;
}

export interface SimResult {
  /** Balls that came at each player (the robot's serves and shots; the other player's serves and shots that landed on their half), how many of them they hit, and how many of those hits landed on the other half. */
  came: number[];
  hits: number[];
  fair: number[];
  /** With two: each player's serves (balls put in play by them). */
  serves: number[];
  /** The rallies' lengths (shots in a row that landed), and the best. */
  rallies: number[];
  best: number;
  /** Seconds the ball spent out of play (waiting to be served), as a share of the round. */
  waiting: number;
  /** How long each wait for a serve lasted (s). */
  waits: number[];
}

/** A round played by pretend people. */
export function simulate(options: SimOptions): SimResult {
  const { players, seconds, seed = 1, fps = 60 } = options;
  const random = seeded(seed);
  const two = players.length > 1;
  const rigs = players.map((p, i) => newRig(i as End, p.hand ?? 'right'));
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 'auto', assist: options.assist ?? defaultAssist(players.length), botLevel: options.botLevel ?? 'medium', botAlways: options.botAlways ?? true };
  const round = new Round(rigs, play, random.rand);
  const people = players.map((p, i) => new Person(i as End, rigs[i].paddle, p.skill, seeded(seed * 7919 + i * 104729 + 1)));
  const cameras = players.map((p, i) => new Camera(p.tracking, seeded(seed * 31337 + i * 15485863 + 2)));
  const result: SimResult = { came: players.map(() => 0), hits: players.map(() => 0), fair: players.map(() => 0), serves: players.map(() => 0), rallies: [], best: 0, waiting: 0, waits: [] };
  const dt = 1 / fps;
  // The shot in the air: whose, whether its landing has been judged, and (the robot's) whether
  // the player has answered it yet.
  let shot: { by: End | 'bot'; judged: boolean; serve: boolean } | null = null;
  const answered: boolean[] = players.map(() => true);
  let wasFlying = false, waitedSince = 0, rally = 0;
  const endRally = () => { if (rally) result.rallies.push(rally); rally = 0; };
  const comesAt = (end: End) => { result.came[end] += 1; answered[end] = false; };
  for (let t = 0; t < seconds; t += dt) {
    rigs.forEach((rig, i) => {
      const serving = two && round.holding() && round.server() === rig.end;
      const blade = people[i].update(t, {
        ball: round.flying ? mineBall(rig.end, round.ball) : null,
        touchedAt: Math.max(round.touchedAt, round.servedAt),
        serve: serving ? { ball: mine(rig.end, heldBall(rig.end, 0, rig.paddle).pos), since: round.time - round.heldSince } : null,
        robotHolds: !two && round.holding(),
      });
      cameras[i].see(rig, people[i], blade, t);
    });
    const botHitBefore = round.bot.hitAt, servedBefore = round.servedAt;
    round.step(dt, t * 1000, true);
    const served = round.servedAt !== servedBefore;
    // The robot's serve or shot: it comes at the player.
    if (!two && (round.bot.hitAt !== botHitBefore || served)) { shot = { by: 'bot', judged: true, serve: false }; comesAt(0); }
    for (const e of round.events) {
      if (e.type === 'paddle' && e.by !== undefined) {
        if (two && served) result.serves[e.by] += 1;
        // (A ball hit twice on its way by counts once.)
        else if (!answered[e.by]) { result.hits[e.by] += 1; answered[e.by] = true; }
        shot = { by: e.by, judged: false, serve: two && served };
      } else if (shot && !shot.judged && shot.by !== 'bot') {
        // The shot's first bounce: on the other half, it's a fair one, and comes at the other player.
        shot.judged = true;
        const by = shot.by, fair = e.type === 'table' && (e.at.z >= 0 ? 0 : 1) !== by;
        if (!fair) { endRally(); continue; }
        rally += 1;
        if (!shot.serve) result.fair[by] += 1;
        if (two) comesAt(by === 0 ? 1 : 0);
      }
    }
    if (wasFlying && !round.flying) { waitedSince = t; endRally(); }
    if (!wasFlying && round.flying) result.waits.push(t - waitedSince);
    if (!round.flying) result.waiting += dt / seconds;
    wasFlying = round.flying;
  }
  endRally();
  result.best = Math.max(0, ...result.rallies);
  return result;
}

/** Several rounds' results added up (different seeds). */
export function simulateMany(options: SimOptions, rounds: number): SimResult {
  const all = Array.from({ length: rounds }, (_, i) => simulate({ ...options, seed: (options.seed ?? 1) + i * 101 }));
  const sum = (pick: (r: SimResult) => number[]) => all[0].came.map((_, i) => all.reduce((n, r) => n + pick(r)[i], 0));
  return {
    came: sum((r) => r.came), hits: sum((r) => r.hits), fair: sum((r) => r.fair), serves: sum((r) => r.serves),
    rallies: all.flatMap((r) => r.rallies), best: Math.max(...all.map((r) => r.best)),
    waiting: all.reduce((n, r) => n + r.waiting, 0) / rounds, waits: all.flatMap((r) => r.waits),
  };
}
