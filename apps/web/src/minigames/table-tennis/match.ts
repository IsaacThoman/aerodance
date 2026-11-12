/*
 * Table Tennis's rules, without the ball: a match's score and serve (Match), and the referee that
 * says when a shot has won or lost the point (Shot, judge). round.ts feeds them what the ball does.
 *
 * A match is Wii Sports Resort's: first to 6, by 2 clear, the serve changing every 2 points and,
 * from 5-all, every point. A point is lost by the player whose shot doesn't land on the other half
 * (out, into the net, or onto their own half), or who lets a shot that did land get by them (it
 * bounces twice, or reaches the floor). Volleys are allowed, and there are no lets.
 *
 * Ends are rally.ts's: 0 the near end (Player 1, or the one player), 1 the far end (Player 2, or
 * the robot).
 */

import type { End } from './rally.ts';

export const MATCH = { firstTo: 6, winBy: 2, servesEach: 2 } as const;

/** Why a point was won: shown as the call (Hud), and kept for tests and the session log. */
export type PointReason =
  /** The shot didn't come down on the table (long or wide). */
  | 'out'
  /** It caught in the net, or dropped back off it. */
  | 'net'
  /** It came down on the hitter's own half. */
  | 'own'
  /** It landed, and bounced again without the other player getting to it. */
  | 'double'
  /** It landed, and was gone past the other player (the floor) without their getting to it. */
  | 'missed'
  /** Return Challenge: the player's return landed. */
  | 'return';

export const otherOf = (end: End): End => (end === 0 ? 1 : 0);

export interface Match {
  score: [number, number];
  /** Who served the match's first point. */
  first: End;
  /** Who won it, once someone has. */
  winner: End | null;
}

export const newMatch = (first: End = 0): Match => ({ score: [0, 0], first, winner: null });

/** Whose serve it is: changing every servesEach points, and every point once both are a point from winning. */
export function serverOf(m: Match, rules = MATCH): End {
  const [a, b] = m.score, played = a + b;
  const deuceAt = 2 * (rules.firstTo - 1);
  const turns = played < deuceAt ? Math.floor(played / rules.servesEach) : Math.ceil(deuceAt / rules.servesEach) + (played - deuceAt);
  return turns % 2 === 0 ? m.first : otherOf(m.first);
}

/** A point to `to`; the match is theirs if it takes them to firstTo by winBy. */
export function award(m: Match, to: End, rules = MATCH): void {
  if (m.winner !== null) return;
  m.score[to] += 1;
  const [a, b] = m.score;
  if (Math.max(a, b) >= rules.firstTo && Math.abs(a - b) >= rules.winBy) m.winner = a > b ? 0 : 1;
}

/** The player one point from winning the match, if there is one. */
export function matchPointFor(m: Match, rules = MATCH): End | null {
  if (m.winner !== null) return null;
  for (const end of [0, 1] as const) {
    const mine = m.score[end], theirs = m.score[otherOf(end)];
    if (mine + 1 >= rules.firstTo && mine + 1 - theirs >= rules.winBy) return end;
  }
  return null;
}

/** Level at firstTo - 1 or more apiece: whoever wins two points in a row wins. */
export const deuce = (m: Match, rules = MATCH) => m.winner === null && m.score[0] === m.score[1] && m.score[0] >= rules.firstTo - 1;

/**
 * The shot in the air, as the referee follows it: who hit it, whether it's a serve allowed one
 * bounce on its own half first (the robot's serves are real ones), whether it has landed on the
 * other half yet, and whether it has touched the net (for the call).
 */
export interface Shot { by: End; ownFirst: boolean; landed: boolean; net: boolean; }

export const newShot = (by: End, ownFirst = false): Shot => ({ by, ownFirst, landed: false, net: false });

/** A point decided: to whom, and why. */
export interface Verdict { to: End; reason: PointReason; }

/**
 * What the ball touching something does to the shot in the air (`half`: the end whose half a
 * bounce was on): a point, or nothing yet.
 */
export function judge(shot: Shot, e: { type: 'table' | 'net' | 'floor'; half: End }): Verdict | null {
  const other = otherOf(shot.by);
  if (e.type === 'net') { shot.net = true; return null; }
  if (e.type === 'floor') return shot.landed ? { to: shot.by, reason: 'missed' } : { to: other, reason: shot.net ? 'net' : 'out' };
  if (shot.landed) return { to: shot.by, reason: 'double' };
  if (e.half === other) { shot.landed = true; return null; }
  if (shot.ownFirst) { shot.ownFirst = false; return null; }
  return { to: other, reason: shot.net ? 'net' : 'own' };
}

/** The ball gone dead with nothing decided (settled, or left too long): whoever was to play it next loses it. */
export const deadVerdict = (shot: Shot): Verdict =>
  (shot.landed ? { to: shot.by, reason: 'missed' } : { to: otherOf(shot.by), reason: shot.net ? 'net' : 'out' });

/**
 * Return Challenge: the robot serves, faster as the player goes on, and the player returns as many
 * as they can; the first one they don't ends it. Every `every` returns the serves step up a level.
 */
export const CHALLENGE = { every: 5, levels: 8 } as const;
export const challengeLevel = (returns: number) => Math.min(CHALLENGE.levels - 1, Math.floor(returns / CHALLENGE.every));
