/*
 * Table Tennis played without a screen: pretend people at a pretend webcam, through the game's
 * own round (round.ts), to measure how the game feels to someone who plays well, badly, or not at
 * all (table-tennis-agency.test.ts; tools/table-tennis/agency.ts prints the tables).
 *
 * A person (Person) moves their real paddle hand, in their own frame (rally.ts mine), by what
 * they see of the ball now. A camera (Camera) sees the hand late and wrongly: sampled at its
 * rate, each sample arriving a delay later with noise on it (little across and up the picture,
 * more in depth, as arms.ts reads it), now and then a wild one or none at all. What arrives goes
 * through the game's own filters (rig.ts takeHand), eased hands and paddle, and the round's
 * frames at the screen's rate.
 */

import { TABLE, v3 } from '../../src/minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../../src/minigames/table-tennis/ball.ts';
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

/** How a camera and its tracking see a hand. */
export interface Tracking {
  /** Poses a second, and how long after the hand was there each arrives (s), give or take `jitter`. */
  hz: number;
  delay: number;
  jitter: number;
  /** Each pose's error (m, standard deviation): across and up the picture, and in depth. */
  across: number;
  depth: number;
  /** A steady error on top (m, the player's own frame). */
  bias: V3;
  /** The share of poses that are wild (the depth read the wrong way round: `wild` metres off), and of those with no hand at all. */
  wildRate: number;
  wild: number;
  dropout: number;
}
export const TRACKING = {
  /** A camera that sees everything exactly, at once. */
  perfect: { hz: 60, delay: 0, jitter: 0, across: 0, depth: 0, bias: v3(), wildRate: 0, wild: 0, dropout: 0 },
  /** A good webcam and a fast machine, one player. */
  good: { hz: 30, delay: 0.09, jitter: 0.01, across: 0.015, depth: 0.05, bias: v3(0.02, -0.02, 0.04), wildRate: 0.005, wild: 0.25, dropout: 0.01 },
  /** What two players at one webcam get: slower, later, smaller in the picture. */
  rough: { hz: 20, delay: 0.14, jitter: 0.02, across: 0.03, depth: 0.1, bias: v3(0.04, -0.05, 0.1), wildRate: 0.03, wild: 0.3, dropout: 0.04 },
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

  /** The blade's real place at `now` for a stroke: to its backswing by the time the swing starts, through the ball, and on. */
  private along(stroke: Stroke, now: number): V3 {
    const { swing } = this.skill;
    const back = add(stroke.at, v3(0.04 * sign(this.hand), -0.03, 0.28));
    const through = add(stroke.at, v3(-0.04 * sign(this.hand), 0.04, -0.28));
    const u = (now - (stroke.t - swing)) / swing;
    if (u <= 0) return mix(stroke.start, back, smooth((now - stroke.startT) / Math.max(0.08, stroke.t - swing - stroke.startT)));
    // Through the ball at u = 1, at a steady speed, and on to u = 2.
    return u <= 2 ? mix(back, through, u / 2) : through;
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
      // Their serve: after a moment, a swing through the waiting ball.
      if (this.serveAt === null || seen.serve.since > this.serveAt + 1.2) {
        this.serveAt = seen.serve.since + 0.5 + random.rand() * 0.5;
        this.begin(seen.serve.ball, now + (this.serveAt - seen.serve.since) + skill.swing + 0.2, now);
      }
    } else {
      this.serveAt = null;
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
      // Over: back to ready.
      if (now > this.stroke.t + skill.swing * 1.6) { this.stroke = null; }
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
  constructor(tracking: Tracking, random: Random) { this.tracking = tracking; this.random = random; this.next = random.rand() / tracking.hz; }

  /** Takes a picture if one's due at `now` (s), and gives the rig any poses that have arrived. */
  see(rig: Rig, person: Person, blade: V3, now: number) {
    const { tracking: k, random } = this;
    if (now >= this.next) {
      this.next += 1 / k.hz;
      const lost = random.rand() < k.dropout;
      const wild = random.rand() < k.wildRate ? (random.rand() < 0.5 ? -k.wild : k.wild) : 0;
      const seen = add(blade, v3(k.bias.x + random.normal() * k.across, k.bias.y + random.normal() * k.across, k.bias.z + random.normal() * k.depth + wild));
      this.queue.push({ at: now + Math.max(0, k.delay + random.normal() * k.jitter), taken: now, wrist: lost ? null : wristOf(person.hand, seen), raised: person.raised });
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
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 'auto', assist: options.assist ?? 'normal', botLevel: options.botLevel ?? 'medium', botAlways: options.botAlways ?? true };
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
