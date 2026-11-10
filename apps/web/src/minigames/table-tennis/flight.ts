/*
 * One frame of the ball's flight with the players' paddles (one player against the robot, or two
 * against each other), in ball.ts's table frame. Each player's own sums (assist.ts) run in their
 * own frame (rally.ts mine), where they stand at +z.
 *
 * At max aim assist a swing that passes near the ball, as that player saw it a lag ago, hits it
 * (swingHit), the first player's to do so this frame; otherwise the paddle at the end the ball is
 * over meets it as it really moves (LaggedBall.step). Either way a return is bent towards the
 * other half as it leaves the paddle.
 */

import { assistReturn, swingHit } from './assist.ts';
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

export interface FlightAssist { swing: boolean; landing: number; }

/**
 * Moves the ball on by dt (the ball's seconds) with the players' paddles: what it hit, and
 * whether a swing hit it or the paddle did.
 */
export function flightStep(lagged: LaggedBall, dt: number, players: readonly Swinger[], help: FlightAssist, timeScale: number): { events: FlightEvent[]; swung: boolean; hit: boolean } {
  const events: FlightEvent[] = [];
  let swung = false;
  if (help.swing) {
    for (const p of players) {
      if (!p.raw || !p.paddleVel) continue;
      const vel = swingHit(mineBall(p.end, lagged.then(p.lag)), p.raw, p.paddleVel, p.swing, timeScale);
      if (!vel) continue;
      for (const e of lagged.hitThen(p.lag, (hit) => mine(p.end, assistReturn(mine(p.end, hit.pos), vel, help.landing)))) events.push(e.type === 'paddle' ? { ...e, by: p.end } : e);
      swung = true;
      break;
    }
  }
  // The paddle at the ball's end (alone against the robot, the player's).
  const at = players.length === 1 ? players[0] : players.find((p) => p.end === endOf(lagged.ball.pos.z));
  const onHit = at && help.landing > 0 ? (hit: Ball) => {
    const own = mineBall(at.end, hit);
    hit.vel = mine(at.end, assistReturn(own.pos, own.vel, help.landing));
  } : undefined;
  const stepped = lagged.step(dt, at?.lag ?? 0, at?.from ?? null, at?.to ?? null, { paddleVel: at?.paddleVel && mine(at.end, at.paddleVel), onHit });
  for (const e of stepped.events) events.push(e.type === 'paddle' && at ? { ...e, by: at.end } : e);
  return { events, swung, hit: stepped.hit };
}
