/*
 * Table Tennis's opponent, in ball.ts's table frame: the Torven arm at the far end (robot.ts
 * moves it). It watches the player's return, and if it bounces fairly on the far half it goes to
 * where the ball will reach it (as it crosses the bot's line behind the table, or before it drops
 * too low, wherever the arm can reach) and sends it back onto the near half, somewhere a little
 * different each time. Its shots are as hard as its level (BOT_LEVELS: faster, and spread wider);
 * set to return everything, it also plays the player's misses (long, wide, or off their own half),
 * meeting them before they're gone. It serves too (botServe): off its own half, onto the player's.
 * In a match it makes mistakes as Wii Sports' players do (botMistake, missShot): more at its easy
 * level, and more against a hard-hit ball.
 */

import { BALL_R, NET, TABLE, aimServe, aimShot, stepBall, v3 } from './ball.ts';
import type { Ball, BallEvent, V3 } from './ball.ts';

export const BOT = {
  /** Where it waits, its paddle's middle (and holds the ball between rallies, to serve). */
  home: v3(-0.4, TABLE.top + 0.3, -TABLE.halfLength - 0.35),
  /** It meets the ball as it crosses this line (z), behind the far end... */
  line: -TABLE.halfLength - 0.15,
  /** ...or earlier, if it would drop this low over the table first. */
  low: TABLE.top + 0.14,
  /**
   * Where the arm can put its paddle (fitted to its kinematics, with a margin): within `radius` of
   * a line across the table at `z` and `y` (out to `track` either side, its carriage's travel),
   * not out over the table past `front`, nor back past `back`, nor lower than `floor`.
   */
  reach: { z: -TABLE.halfLength - 1.65, y: 0.7, track: 0.62, radius: 1.8, front: -TABLE.halfLength + 0.25, back: -TABLE.halfLength - 0.9, floor: 0.45 },
  /** How fast it moves (m/s, the ball's world's); returning everything, as fast as it needs to. */
  speed: 3.5,
} as const;

/** How far a point is inside the arm's reach (BOT.reach), in metres: below 0, it's out of it. */
export function reachRoom(p: V3): number {
  const r = BOT.reach;
  return Math.min(r.front - p.z, p.z - r.back, p.y - r.floor, r.radius - Math.hypot(p.z - r.z, p.y - r.y, Math.max(0, Math.abs(p.x) - r.track)));
}

/** Whether the arm can reach a point. */
export const reaches = (p: V3): boolean => reachRoom(p) >= 0;

export type BotLevel = 'easy' | 'medium' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];
/**
 * Each level's shots: their flight to their bounce (s; shorter is faster, and lower; much longer
 * and they're lobs), and where on the near half they're aimed: x within `spread` either side of
 * `x` (easy ones to the player's forehand, where the paddle is), z from the net.
 */
export const BOT_SHOTS: Record<BotLevel, { flight: number; aim: { x: number; spread: number; near: number; far: number } }> = {
  easy: { flight: 0.68, aim: { x: 0.2, spread: 0.12, near: 0.7, far: 0.95 } },
  medium: { flight: 0.6, aim: { x: 0, spread: 0.45, near: 0.45, far: 1.0 } },
  hard: { flight: 0.46, aim: { x: 0, spread: 0.62, near: 0.3, far: 1.18 } },
};

const STEP = 1 / 240;

/** Whether a point is over the table's far half (a ball dropping there will bounce on it). */
const overFar = (p: V3) => Math.abs(p.x) <= TABLE.halfWidth && p.z <= 0 && p.z >= -TABLE.halfLength;

/**
 * Where and when (in seconds from now) the bot meets a ball flying at it, or null if it won't: the
 * ball must be coming its way and bounce once on the far half first (`bounced`: it already has),
 * and come within the arm's reach. Returning everything (`always`), it takes the player's misses
 * too: one going long or wide it meets as it crosses its line or drops low beside the table, and
 * one off the player's own half it lets come on; only one in the net, or gone the player's way, it
 * can't. It meets the ball at the first such place it can reach (past its line, further back).
 */
export function planReturn(ball: Ball, bounced = false, always = false): { t: number; at: V3 } | null {
  if (ball.vel.z >= 0) return null;
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: 0 };
  // Where it meets it: past its line, or dropping low (once bounced, or, for a miss, beside the table).
  const meets = () => (bounced || always) && (b.pos.z <= BOT.line || (b.vel.y < 0 && b.pos.y < BOT.low && (bounced || (!overFar(b.pos) && b.pos.z < 0)))) && reaches(b.pos);
  if (meets()) return { t: 0, at: { ...b.pos } };
  const events: BallEvent[] = [];
  for (let t = STEP; t < 2.5; t += STEP) {
    events.length = 0;
    for (const e of stepBall(b, STEP, null, null, events)) {
      // Its one fair bounce; anything else (the net, the near half, a second bounce, the floor) is the
      // player's miss, which it leaves, unless it returns everything and it can still get there.
      if (e.type === 'table' && e.side === 'far' && !bounced) bounced = true;
      else if (!always || e.type === 'net' || e.type === 'floor' || (e.type === 'table' && e.side === 'far')) return null;
    }
    // Gone the other way, or by it out of reach.
    if (b.vel.z >= 0 || b.pos.z < BOT.reach.back) return null;
    if (meets()) return { t, at: { ...b.pos } };
  }
  return null;
}

/** The side of the player's forehand, across the table: their paddle hand's (+x for the right). */
const forehandX = (hand: 'left' | 'right') => (hand === 'left' ? -1 : 1);

/**
 * Where the bot aims a shot, as its level does: a spot on the near half (x across, z from the
 * net) that rand picks, its easy ones to the forehand of a player whose paddle is in `hand`.
 */
export function botTarget(level: BotLevel = 'medium', rand: () => number = Math.random, hand: 'left' | 'right' = 'right'): V3 {
  const { aim } = BOT_SHOTS[level];
  return v3(aim.x * forehandX(hand) + (rand() * 2 - 1) * aim.spread, 0, aim.near + rand() * (aim.far - aim.near));
}

/** The bot's shot from where it meets the ball, as hard as its level: onto the near half, at `target` (botTarget). */
export function botShot(from: V3, level: BotLevel = 'medium', rand: () => number = Math.random, target: V3 = botTarget(level, rand)): V3 {
  const { flight } = BOT_SHOTS[level];
  // Slower if it must be to clear the net; from out wide, across the table if it can't go down the line.
  for (const x of [target.x, -target.x, 0]) {
    for (const f of [flight, flight * 1.2, flight * 1.45, flight * 1.75]) {
      const vel = aimShot(from, v3(x, 0, target.z), f);
      if (vel) return vel;
    }
  }
  return aimServe(from, v3(0, 0, target.z), flight * 1.75);
}

/**
 * A serve: how long it takes from the strike to its bounce on the player's half (s), and where on
 * it it's aimed (as BOT_SHOTS's aim).
 */
export interface ServeSpec { time: number; aim: { x: number; spread: number; near: number; far: number } }
/** Each level's serves. */
export const BOT_SERVES: Record<BotLevel, ServeSpec> = {
  easy: { time: 1.05, aim: { x: 0.2, spread: 0.15, near: 0.6, far: 0.95 } },
  medium: { time: 0.9, aim: { x: 0, spread: 0.4, near: 0.45, far: 1.05 } },
  hard: { time: 0.75, aim: { x: 0, spread: 0.55, near: 0.35, far: 1.15 } },
};

/**
 * Return Challenge's serves at each of its levels (match.ts challengeLevel, from 0): easy's to
 * begin with, then quicker and wider each level, to a little past hard's.
 */
export function challengeServe(level: number): ServeSpec {
  const u = Math.min(1, Math.max(0, level / 7));
  const mix = (a: number, b: number) => a + (b - a) * u;
  return { time: mix(1.05, 0.68), aim: { x: mix(0.2, 0), spread: mix(0.12, 0.6), near: mix(0.6, 0.3), far: mix(0.95, 1.18) } };
}

/**
 * How often the bot's shot goes wrong at each level, against a gentle ball; every m/s the ball
 * came at it faster than `easyPace` adds `perPace` more, up to `most`.
 */
export const BOT_MISTAKES = { rate: { easy: 0.14, medium: 0.08, hard: 0.04 } as Record<BotLevel, number>, easyPace: 5, perPace: 0.035, most: 0.4 } as const;
export type Mistake = 'long' | 'wide' | 'net';

/** Whether the bot gets this shot wrong, and how, against a ball that came at it at `speed` (m/s). */
export function botMistake(level: BotLevel, speed: number, rand: () => number = Math.random): Mistake | null {
  const m = BOT_MISTAKES;
  const chance = Math.min(m.most, m.rate[level] + Math.max(0, speed - m.easyPace) * m.perPace);
  if (rand() >= chance) return null;
  const pick = rand();
  return pick < 0.4 ? 'net' : pick < 0.75 ? 'long' : 'wide';
}

/**
 * A shot from `from` that goes wrong so (botMistake): long past the near end, wide of the table,
 * or low into the net. Without air it would come down well past the table's edge, so with air
 * (which only shortens it a little) it still does.
 */
export function missShot(from: V3, mistake: Mistake, rand: () => number = Math.random): V3 {
  const side = rand() < 0.5 ? -1 : 1;
  if (mistake === 'net') {
    // Flat and fast, at a spot just over the net: it crosses the net's line lower than its top.
    const aim = v3((rand() * 2 - 1) * 0.4, 0, 0.15);
    for (let flight = 0.22; flight < 0.8; flight += 0.02) {
      const vel = ballistic(from, aim, flight);
      const t = (0 - from.z) / vel.z;
      const y = from.y + vel.y * t - 0.5 * GRAVITY * t * t;
      if (y > TABLE.top + 0.03 && y < TABLE.top + NET.height - 0.03) return vel;
    }
    return ballistic(from, aim, 0.3);
  }
  const aim = mistake === 'long'
    ? v3((rand() * 2 - 1) * 0.4, 0, TABLE.halfLength + 0.45)
    : v3(side * (TABLE.halfWidth + 0.35), 0, 0.5 + rand() * 0.5);
  return ballistic(from, aim, 0.55 + rand() * 0.15);
}

const GRAVITY = 9.81;
/** The velocity that, without air, comes down at `aim` (at the table's height) after `flight` seconds. */
const ballistic = (from: V3, aim: V3, flight: number): V3 =>
  v3((aim.x - from.x) / flight, (TABLE.top + BALL_R - from.y + 0.5 * GRAVITY * flight * flight) / flight, (aim.z - from.z) / flight);

/** A serve's flight: its first bounce (on the server's half), then where (and when) it comes down on the receiver's. */
export interface ServeFlight { vel: V3; first: V3; second: V3; t: number; }

/** Where a ball struck at `vel` from `from` bounces, first and second, and when it comes down the second time; null if not a fair serve (its own half, then over the net onto the near half). */
export function serveFlight(from: V3, vel: V3): ServeFlight | null {
  const b: Ball = { pos: { ...from }, vel: { ...vel }, cooldown: 0 };
  const events: BallEvent[] = [];
  let first: V3 | null = null;
  for (let t = STEP; t < 2.5; t += STEP) {
    events.length = 0;
    for (const e of stepBall(b, STEP, null, null, events)) {
      if (e.type !== 'table') return null;
      if (!first) { if (e.side !== 'far') return null; first = e.at; continue; }
      return e.side === 'near' ? { vel, first, second: e.at, t } : null;
    }
  }
  return null;
}

/**
 * The bot's serve from where it strikes the ball, as hard as its level: down onto its own half and
 * over the net onto the player's, at a spot rand picks, about its level's time after the strike.
 * The ball flies straight (seen from above: no spin), so its first bounce is on the line to the
 * spot; it searches that bounce's place and the time to it for the serve that lands nearest. Null
 * if none does (from somewhere it can't serve from).
 */
export function botServe(from: V3, level: BotLevel | ServeSpec = 'medium', rand: () => number = Math.random, hand: 'left' | 'right' = 'right'): ServeFlight | null {
  const { time, aim } = typeof level === 'string' ? BOT_SERVES[level] : level;
  const target = v3(aim.x * forehandX(hand) + (rand() * 2 - 1) * aim.spread, 0, aim.near + rand() * (aim.far - aim.near));
  let best: { serve: ServeFlight; score: number } | null = null;
  for (let share = 0.2; share <= 0.75; share += 0.05) {
    // The first bounce, a share of the way from `from` to the spot (along z), on the far half.
    const z = from.z + (target.z - from.z) * share;
    if (z > -0.15 || z < -TABLE.halfLength + 0.08) continue;
    const k = (z - from.z) / (target.z - from.z);
    const first = v3(from.x + (target.x - from.x) * k, 0, z);
    for (let flight = 0.14; flight <= 0.5; flight += 0.03) {
      const vel = aimShot(from, first, flight);
      const serve = vel && serveFlight(from, vel);
      if (!serve) continue;
      const score = Math.hypot(serve.second.x - target.x, serve.second.z - target.z) + 0.25 * Math.abs(serve.t - time);
      if (!best || score < best.score) best = { serve, score };
    }
  }
  if (best) return best.serve;
  // Somewhere it can't bounce one off its own half from: straight onto the player's (as a launcher would).
  const vel = aimServe(from, target, time * 0.7);
  return { vel, first: target, second: target, t: time * 0.7 };
}
