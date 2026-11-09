/*
 * Table Tennis with two players: the table's two ends, the frames the players play in, their
 * serve and their open rally. There's no match, only a count of the shots in a row that land on
 * the other half.
 *
 * ball.ts's table frame has its own player at the near end (+z), so everything the solo game
 * works out for its player (assist.ts, calibrate.ts) assumes that. The far player plays in the
 * table's frame turned half round (`mine`), where they're at +z too: their paddle, swings and
 * the ball go into it, the same sums run, and what comes out goes back.
 */

import { TABLE, v3 } from './ball.ts';
import type { Ball, V3 } from './ball.ts';

/** A player's end of the table: 0 the near end (+z, Player 1's), 1 the far end (Player 2's). */
export type End = 0 | 1;

/** A point or a direction in the table's frame as the player at `end` has it (at +z), or back again: it's its own inverse. */
export const mine = (end: End, v: V3): V3 => (end === 0 ? v : v3(-v.x, v.y, -v.z));
/** The ball as the player at `end` has it (mine), or back again. */
export const mineBall = (end: End, b: Ball): Ball => (end === 0 ? b : { pos: mine(1, b.pos), vel: mine(1, b.vel), cooldown: b.cooldown });
/** The end whose half a point is over. */
export const endOf = (z: number): End => (z >= 0 ? 0 : 1);
export const otherEnd = (end: End): End => (end === 0 ? 1 : 0);

/**
 * The serve: the ball waits in the air over the server's end, on their paddle hand's side at
 * about chest height, where a forehand swing meets it; a swing through it serves (assist.ts
 * serveHit). `hold` is a right-handed server's spot in their own frame (a left-handed one's is
 * across from it). It can't be served for `arm` seconds after it gets there: the last shot's
 * follow-through isn't a serve. A player who leaves it waiting loses the serve to the other.
 */
export const SERVE = {
  hold: v3(0.3, TABLE.top + 0.36, TABLE.halfLength - 0.1),
  /** How far the waiting ball bobs (m), and how fast (radians a second). */
  bob: 0.012,
  bobRate: 2.2,
  arm: 0.35,
  /** Left waiting this long (s), the ball goes to the other player to serve. */
  pass: 8,
  /** Space's serve (development, or no camera), in the server's own frame. */
  key: v3(0, 1.4, -4.4),
} as const;

/** The ball waiting for the server (in the table's frame), bobbing at the time t, on the side of their paddle hand. */
export function heldBall(server: End, t: number, hand: 'left' | 'right' = 'right'): Ball {
  const at = v3(SERVE.hold.x * (hand === 'left' ? -1 : 1), SERVE.hold.y + SERVE.bob * Math.sin(t * SERVE.bobRate), SERVE.hold.z);
  return { pos: mine(server, at), vel: v3(), cooldown: 0 };
}

/**
 * The open rally: who serves, who hit the ball last and how their shot went, and the count of
 * shots in a row that landed on the other half (and the best count so far).
 */
export interface Rally {
  server: End;
  /** Who hit the ball last since it was served (null: it's waiting to be). */
  last: End | null;
  /** The last hit's shot: still to land, landed on the other half (fair), or not (on the hitter's own). */
  shot: 'flying' | 'fair' | 'short' | null;
  count: number;
  best: number;
}

export const newRally = (server: End = 0): Rally => ({ server, last: null, shot: null, count: 0, best: 0 });

function endCount(r: Rally) {
  r.best = Math.max(r.best, r.count);
  r.count = 0;
}

/** The server serves: a new ball's first shot, theirs. */
export function served(r: Rally): void {
  r.last = r.server;
  r.shot = 'flying';
}

/**
 * The player at `end` hit the ball. Played back after a shot that didn't land on their half (or
 * hit twice running), the count starts again.
 */
export function hit(r: Rally, end: End): void {
  if (r.last !== null && (r.shot !== 'fair' || r.last === end)) endCount(r);
  r.last = end;
  r.shot = 'flying';
}

/**
 * The ball came down on the table, on the half of `end`. The first bounce after a hit says how
 * that shot went: on the other half, it counts. Later bounces change nothing. Returns the shot's
 * verdict when this bounce gave it.
 */
export function bounced(r: Rally, end: End): 'fair' | 'short' | null {
  if (r.shot !== 'flying' || r.last === null) return null;
  r.shot = end === r.last ? 'short' : 'fair';
  if (r.shot === 'fair') r.count += 1;
  return r.shot;
}

/**
 * The ball is dead (on the floor, settled, or left too long): the count is over, and whoever's
 * end it finished at serves next, as a player picks up a ball that rolled to them.
 */
export function dead(r: Rally, at: End): void {
  endCount(r);
  r.server = at;
  r.last = null;
  r.shot = null;
}
