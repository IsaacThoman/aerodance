/*
 * Table Tennis's two ends, the frames the players play in, and a player's serve. (The match
 * itself, its score and who serves, is match.ts.)
 *
 * ball.ts's table frame has its own player at the near end (+z), so everything the solo game
 * works out for its player (assist.ts, calibrate.ts) assumes that. The far player plays in the
 * table's frame turned half round (`mine`), where they're at +z too: their paddle, swings and
 * the ball go into it, the same sums run, and what comes out goes back.
 */

import { TABLE, v3 } from './ball.ts';
import type { Ball, V3 } from './ball.ts';

/** A player's end of the table: 0 the near end (+z, Player 1's), 1 the far end (Player 2's, or the robot's). */
export type End = 0 | 1;

/** A point or a direction in the table's frame as the player at `end` has it (at +z), or back again: it's its own inverse. */
export const mine = (end: End, v: V3): V3 => (end === 0 ? v : v3(-v.x, v.y, -v.z));
/** The ball as the player at `end` has it (mine), or back again. */
export const mineBall = (end: End, b: Ball): Ball => (end === 0 ? b : { pos: mine(1, b.pos), vel: mine(1, b.vel), cooldown: b.cooldown });
/** The end whose half a point is over. */
export const endOf = (z: number): End => (z >= 0 ? 0 : 1);
export const otherEnd = (end: End): End => (end === 0 ? 1 : 0);

/**
 * A player's serve, as Wii Sports Resort's: the ball waits in the air over the server's end, on
 * their paddle hand's side at about chest height (`hold`: a right-handed server's spot in their own
 * frame; a left-handed one's is across from it). Raising the free hand tosses it straight up
 * (`toss`, m/s), and a swing through it as it comes down serves it (assist.ts serveHit). Let fall
 * `drop` metres below where it was tossed from, it's back where it waited, to be tossed again.
 * It can't be tossed for `arm` seconds after it gets there: the last shot's follow-through isn't
 * a serve.
 */
export const SERVE = {
  hold: v3(0.3, TABLE.top + 0.36, TABLE.halfLength - 0.1),
  /** How far the waiting ball bobs (m), and how fast (radians a second). */
  bob: 0.012,
  bobRate: 2.2,
  arm: 0.35,
  toss: 3,
  drop: 0.3,
  /** Space's serve (development, or no camera), in the server's own frame. */
  key: v3(0, 1.4, -4.4),
} as const;

const GRAVITY = 9.81;

/** Where the server's ball waits (in their own frame), on the side of their paddle hand. */
const holdFor = (hand: 'left' | 'right') => v3(SERVE.hold.x * (hand === 'left' ? -1 : 1), SERVE.hold.y, SERVE.hold.z);

/** The ball waiting for the server (in the table's frame), bobbing at the time t, on the side of their paddle hand. */
export function heldBall(server: End, t: number, hand: 'left' | 'right' = 'right'): Ball {
  const at = holdFor(hand);
  return { pos: mine(server, v3(at.x, at.y + SERVE.bob * Math.sin(t * SERVE.bobRate), at.z)), vel: v3(), cooldown: 0 };
}

/**
 * The server's tossed ball (in the table's frame) `since` seconds after the toss, or null once it
 * has dropped back past where it can be served (it's back waiting).
 */
export function tossedBall(server: End, since: number, hand: 'left' | 'right' = 'right'): Ball | null {
  const at = holdFor(hand);
  const rise = SERVE.toss * since - 0.5 * GRAVITY * since * since;
  if (since < 0 || rise < -SERVE.drop) return null;
  return { pos: mine(server, v3(at.x, at.y + rise, at.z)), vel: mine(server, v3(0, SERVE.toss - GRAVITY * since, 0)), cooldown: 0 };
}

/** How long a toss stays up (s): from the toss until it has dropped back past where it can be served. */
export const TOSS_S = (SERVE.toss + Math.sqrt(SERVE.toss * SERVE.toss + 2 * GRAVITY * SERVE.drop)) / GRAVITY;
