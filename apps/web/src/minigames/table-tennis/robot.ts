/*
 * How Table Tennis's opponent, the Torven arm at the far end (packages/robots/arms/sixaxis), moves
 * its paddle, in ball.ts's table frame: plain maths, so it can be checked outside the browser. The
 * bot (bot.ts) says where it meets the ball; this says where the paddle is on the way: drawn back
 * before the ball comes, swung through it, followed through. Between rallies it holds the ball on
 * its paddle, face up, and serves by tossing it up off the paddle and striking it as it falls.
 * The arm's own inverse kinematics put the paddle where this says (RobotOpponent.tsx).
 */

import { DIM } from '../../../../../packages/robots/arms/sixaxis/kinematics.ts';
import { BALL_R, TABLE } from './ball.ts';
import type { V3 } from './ball.ts';
import { BOT } from './bot.ts';

const GRAVITY = 9.81;
/** From the paddle's centre to the ball's, the ball on its face. */
export const GAP = BALL_R + 0.005;
const UP: V3 = { x: 0, y: 1, z: 0 };
/**
 * Its paddle's face holding the ball: up, tipped a little towards the player. Dead flat, the arm
 * would hold the blade from in front, its forearm over the ball's toss; tipped, it holds it from
 * behind, clear of it.
 */
export const HOLD_NORMAL: V3 = { x: 0, y: Math.cos(0.14), z: Math.sin(0.14) };

/**
 * The rally's stroke: drawn back `back` (m), out to the side `side` and down `drop` over `prep`
 * (s), swung through over `swing` (s) to the ball, followed through `through`, across and up
 * `rise` over `follow`. Its face tilted up `tilt` (rad). Within `room` (m) of the edge of its
 * reach, the stroke is smaller.
 */
export const STROKE = { back: 0.22, side: 0.22, drop: 0.06, prep: 0.25, swing: 0.3, through: 0.22, rise: 0.14, follow: 0.32, tilt: 0.22, room: 0.35 } as const;

/**
 * The serve: the paddle flicks up `lift` (m) over `flick` (s), letting the ball go at `toss`
 * (m/s, up); it's struck as it falls back to `strike` (m) above where it was let go, the paddle
 * drawn back `back` (m) behind it and `side` out to its right by then and swung through it at
 * `swing` (m/s), then followed through `through` and across over `follow` (s).
 */
export const SERVE = { lift: 0.15, flick: 0.15, toss: 2.1, strike: 0.02, back: 0.2, side: 0.16, swing: 2.4, through: 0.22, follow: 0.3 } as const;

const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const unit = (a: V3): V3 => scale(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1));
const smooth = (u: number) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };

/** The paddle as the robot holds it: its centre, and its face's normal. */
export interface ArmPose { pos: V3; normal: V3; }

/** Which way a shot goes from `from` to `to`, seen from above (towards the player if they're the same). */
export function heading(from: V3, to: V3): V3 {
  const x = to.x - from.x, z = to.z - from.z;
  const l = Math.hypot(x, z);
  return l > 1e-6 ? { x: x / l, y: 0, z: z / l } : { x: 0, y: 0, z: 1 };
}

/** The robot's right, facing a shot's heading `dir` (from above). */
export const rightOf = (dir: V3): V3 => ({ x: -dir.z, y: 0, z: dir.x });

/** Whether the robot plays a ball at `at` on its forehand (its right, the table's −x, or near the middle) or backhand. */
export const forehand = (at: V3): boolean => at.x <= 0.15;

/** The face's normal for a shot heading `dir` (from above), tilted up by `tilt` (rad). */
export const faceNormal = (dir: V3, tilt: number = STROKE.tilt): V3 => unit({ x: dir.x * Math.cos(tilt), y: Math.sin(tilt), z: dir.z * Math.cos(tilt) });

/**
 * The stroke's offset from where the bot meets the ball (so its paddle is there on the strike):
 * `until`, seconds until it meets it (null: not coming), and `since`, seconds since it last struck
 * one, on its forehand side or not. Drawn back, out to that side and a little low as the ball
 * comes, swung through to the ball, followed through, across and up after it, along the shot's
 * heading: an arc the player sees from in front.
 */
export function strokeOffset(until: number | null, since: number, dir: V3, fore = true, room = Infinity): V3 {
  const { back, side, drop, prep, swing, through, rise, follow } = STROKE;
  // Smaller near the edge of its reach (`room`, m: bot.ts reachRoom), where it couldn't swing so far.
  const k = Math.min(1, Math.max(0, room / STROKE.room));
  let a = 0;
  if (until !== null) a = until >= swing ? smooth((swing + prep - until) / prep) : Math.sin((Math.PI / 2) * (until / swing));
  const f = since >= 0 && since < follow ? Math.sin(Math.PI * (since / follow)) : 0;
  const right = scale(rightOf(dir), fore ? side : -side);
  return scale(add(add(scale(dir, through * f - back * a), right, a - f), UP, rise * f - drop * a), k);
}

/** The ball resting on a paddle face up. */
export const onPaddle = (pose: ArmPose): V3 => add(pose.pos, pose.normal, GAP);

// A Hermite curve between two keys (place and velocity), u from 0 to 1 over `span` seconds.
interface Key { t: number; pos: V3; vel: V3; }
function hermite(a: Key, b: Key, t: number): V3 {
  const span = b.t - a.t;
  const u = Math.min(1, Math.max(0, (t - a.t) / span));
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return {
    x: h00 * a.pos.x + h10 * span * a.vel.x + h01 * b.pos.x + h11 * span * b.vel.x,
    y: h00 * a.pos.y + h10 * span * a.vel.y + h01 * b.pos.y + h11 * span * b.vel.y,
    z: h00 * a.pos.z + h10 * span * a.vel.z + h01 * b.pos.z + h11 * span * b.vel.z,
  };
}

/** A serve under way: when it started, when the ball's let go and struck, and the paddle's path. */
export interface ServeMotion {
  start: number;
  release: number;
  strikeAt: number;
  end: number;
  /** Where the ball's let go, and where it's struck. */
  from: V3;
  strike: V3;
  /** The face's normal as it strikes. */
  normal: V3;
  keys: Key[];
}

/** Where a serve from the paddle held at `hold` strikes the ball (botServe's `from`). */
export const serveStrike = (hold: V3): V3 => add(add(hold, HOLD_NORMAL, GAP), UP, SERVE.lift + SERVE.strike);

/**
 * Plans a serve starting at `start` from the paddle held at `hold` (face up, HOLD_NORMAL, the ball on it),
 * struck towards `heading` (from above) with its face's normal `normal`. The ball's let go at the
 * top of the flick and struck where it falls back to, a little higher.
 */
export function planServe(start: number, hold: V3, dir: V3, normal: V3): ServeMotion {
  const { lift, flick, toss, strike: above, back, swing, through, follow } = SERVE;
  const release = start + flick;
  const from = add(add(hold, HOLD_NORMAL, GAP), UP, lift);
  // Up and back down to `above` over it: toss t − g t²/2 = above.
  const rise = (toss - Math.sqrt(toss * toss - 2 * GRAVITY * above)) / GRAVITY;
  const strikeAt = release + (2 * toss) / GRAVITY - rise;
  const strike = serveStrike(hold);
  const contact = add(strike, normal, -GAP);
  const right = rightOf(dir);
  const keys: Key[] = [
    { t: start, pos: hold, vel: { x: 0, y: 0, z: 0 } },
    { t: release, pos: add(hold, UP, lift), vel: { x: 0, y: toss * 0.85, z: 0 } },
    // Out from under it, drawn back and out to the right by the strike's swing time.
    { t: strikeAt - 0.16, pos: add(add(add(contact, dir, -back), right, SERVE.side), UP, -0.04), vel: { x: 0, y: 0, z: 0 } },
    { t: strikeAt, pos: contact, vel: add(add(scale(dir, swing), right, -1.2), UP, 0.3) },
    { t: strikeAt + follow, pos: add(add(add(contact, dir, through), right, -SERVE.side), UP, 0.1), vel: { x: 0, y: 0, z: 0 } },
  ];
  return { start, release, strikeAt, end: strikeAt + follow, from, strike, normal, keys };
}

/** Where the paddle is `t` into a serve, and its face. */
export function servePose(serve: ServeMotion, t: number): ArmPose {
  const { keys } = serve;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const pos = hermite(keys[i], keys[i + 1], t);
  // Face up until the ball's let go, then turned onto the strike's face before the swing.
  const turn = smooth((t - serve.release) / (serve.strikeAt - 0.16 - serve.release));
  const normal = unit(add(scale(HOLD_NORMAL, 1 - turn), serve.normal, turn));
  return { pos, normal };
}

/** Where the ball is `t` into a serve: on the paddle until it's let go, then tossed straight up (null once it's struck). */
export function serveBall(serve: ServeMotion, t: number, paddle: ArmPose): V3 | null {
  if (t >= serve.strikeAt) return null;
  if (t < serve.release) return onPaddle(paddle);
  const s = t - serve.release;
  return add(serve.from, UP, SERVE.toss * s - 0.5 * GRAVITY * s * s);
}

/** Where the robot holds the ball between rallies, its paddle face up (HOLD_NORMAL), the ball at BOT.home: breathing a little. */
export const holdPose = (time: number): ArmPose => ({ pos: add(add(BOT.home, HOLD_NORMAL, -GAP), UP, 0.008 * Math.sin(time * 2.2)), normal: HOLD_NORMAL });

/**
 * A point or direction in the table's frame in the arm's station frame (the frame it's drawn and
 * solved in): its origin on the floor under the far end's middle, +X down the table (the table's
 * +z), +Z to the arm's right as it faces the player (the table's −x).
 */
export const toStation = (p: V3, point = true): V3 => ({ x: p.z + (point ? TABLE.halfLength : 0), y: p.y, z: -p.x });

/** The carriage takes this share of the paddle's way across the table... */
const FOLLOW = 0.8;
/** ...eased off towards its end stops: its place on the track for a paddle at `z` across (station frame). */
export const carriageFor = (z: number): number => DIM.travel * Math.tanh((FOLLOW * z) / DIM.travel);
