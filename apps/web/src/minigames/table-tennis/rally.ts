/*
 * Table Tennis with two players: the table's two ends, the frames the players play in, and their
 * open rally. There's no match, only a count of the shots in a row that land on the other half.
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
 * The serve, in the server's own frame: the ball held over their end of the table, in front of
 * their paddle hand, then tossed up and towards them, to come down where a swing can meet it
 * (it falls past the end of the table, so a miss doesn't bounce on it).
 */
export const TOSS = {
  hold: v3(0.14, TABLE.top + 0.38, TABLE.halfLength - 0.12),
  vel: v3(0, 2.3, 0.45),
  /** How far the held ball bobs (m), and how fast (radians a second). */
  bob: 0.012,
  bobRate: 2.2,
} as const;

/** The ball held for the server (in the table's frame), bobbing at the time t. */
export function heldBall(server: End, t: number): Ball {
  const at = v3(TOSS.hold.x, TOSS.hold.y + TOSS.bob * Math.sin(t * TOSS.bobRate), TOSS.hold.z);
  return { pos: mine(server, at), vel: v3(), cooldown: 0 };
}

/** The server's toss, leaving the held spot (in the table's frame). */
export function tossBall(server: End): Ball {
  return { pos: mine(server, { ...TOSS.hold }), vel: mine(server, { ...TOSS.vel }), cooldown: 0 };
}

/**
 * The open rally: who serves, who hit the ball last and how their shot went, and the count of
 * shots in a row that landed on the other half (and the best count so far).
 */
export interface Rally {
  server: End;
  /** Who hit the ball last since it was tossed (null: nobody yet). */
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

/** The server tosses the ball up: nobody has hit it yet. */
export function tossed(r: Rally): void {
  r.last = null;
  r.shot = null;
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
