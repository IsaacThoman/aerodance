/*
 * One frame of the ball's flight with the players' paddles (one player against the robot, or two
 * against each other), in ball.ts's table frame. Each player's own sums (assist.ts) run in their
 * own frame (rally.ts mine), where they stand at +z.
 *
 * A swing that passes the ball within the assist's zone, as that player saw it a lag ago, hits it
 * (swingHit), the first player's to do so this frame; otherwise the paddle at the end the ball is
 * over meets it as it really moves (LaggedBall.step). Either way a
 * return is bent towards the other half as it leaves the paddle: a swing's by the assist's
 * landing share, a block's (no swing) by less; and with two players, slowed to their pace
 * (assist.ts PACE), so the other has time to get to it.
 */

import { SWING, assistReturn, swingHit } from './assist.ts';
import type { Assist, Pace } from './assist.ts';
import type { Ball, BallEvent, PaddlePose, V3 } from './ball.ts';
import type { LaggedBall } from './lagged.ts';
import { endOf, mine, mineBall } from './rally.ts';
import type { End } from './rally.ts';

/** A player's paddle this frame. */
export interface Swinger {
  end: End;
  /** The blade's centre where the player has it (without the assist's slide), in their own frame. */
  raw: V3 | null;
  /** How fast they're moving it (their own seconds), in their own frame. */
  paddleVel: V3 | undefined;
  /** Their strongest recent forward swing (assist.ts strongestSwing), in their own frame. */
  swing: V3;
  /** How late their paddle is to the ball, in the ball's seconds. */
  lag: number;
  /** The blade as drawn last frame and this one, in the table's frame. */
  from: PaddlePose | null;
  to: PaddlePose | null;
}

/** What the ball hit; a paddle says whose. */
export type FlightEvent = BallEvent & { by?: End };

/**
 * Moves the ball on by dt (the ball's seconds) with the players' paddles: what it hit, and
 * whether a swing hit it or the paddle did. `pace`: how soon a shot may reach the other player
 * (two players), or none.
 */
export function flightStep(lagged: LaggedBall, dt: number, players: readonly Swinger[], help: Assist, timeScale: number, pace?: Pace): { events: FlightEvent[]; swung: boolean; hit: boolean } {
  const events: FlightEvent[] = [];
  let swung = false;
  for (const p of players) {
    if (!p.raw || !p.paddleVel) continue;
    const vel = swingHit(mineBall(p.end, lagged.then(p.lag)), p.raw, p.paddleVel, p.swing, timeScale, help);
    if (!vel) continue;
    for (const e of lagged.hitThen(p.lag, (hit) => mine(p.end, assistReturn(mine(p.end, hit.pos), vel, help.landing, pace)))) events.push(e.type === 'paddle' ? { ...e, by: p.end } : e);
    swung = true;
    break;
  }
  // The paddle at the ball's end (alone against the robot, the player's).
  const at = players.length === 1 ? players[0] : players.find((p) => p.end === endOf(lagged.ball.pos.z));
  const share = at ? (Math.hypot(at.swing.x, at.swing.y, at.swing.z) >= SWING.minSpeed ? help.landing : help.block) : 0;
  const onHit = at && (share > 0 || pace) ? (hit: Ball) => {
    const own = mineBall(at.end, hit);
    hit.vel = mine(at.end, assistReturn(own.pos, own.vel, share, pace));
  } : undefined;
  const stepped = lagged.step(dt, at?.lag ?? 0, at?.from ?? null, at?.to ?? null, { paddleVel: at?.paddleVel && mine(at.end, at.paddleVel), onHit });
  for (const e of stepped.events) events.push(e.type === 'paddle' && at ? { ...e, by: at.end } : e);
  return { events, swung, hit: stepped.hit };
}
