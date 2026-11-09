/*
 * Lag compensation for the /?hands demo's hits. The webcam and the tracker see the player's paddle
 * some time (the lag) after it was really there, and the player swung it at the ball they saw then.
 * So the paddle is met by the ball as it was a lag ago (replayed from the ball's recent past), and
 * a hit there plays forward to now: the return is where it would be had the hit been seen at once.
 * Times here are the ball's world's (slow motion included).
 */

import { PADDLE_COOLDOWN, stepBall } from './ball.ts';
import type { Ball, BallEvent, PaddlePose, StepOptions } from './ball.ts';

const copy = (b: Ball): Ball => ({ pos: { ...b.pos }, vel: { ...b.vel }, cooldown: b.cooldown });
/** How much of the ball's past is kept, in seconds. */
const KEPT = 0.6;

export class LaggedBall {
  ball: Ball;
  time = 0;
  private past: { t: number; ball: Ball }[] = [];

  constructor(ball: Ball, time = 0) {
    this.ball = ball;
    this.restart(ball, time);
  }

  /** Starts afresh from this ball (a serve): it has no past before now. */
  restart(ball: Ball, time = this.time) {
    this.ball = ball;
    this.time = time;
    this.past = [{ t: time, ball: copy(ball) }];
  }

  /** The ball as it was `ago` seconds back (or as far back as is known). */
  then(ago: number): Ball {
    const t = this.time - ago;
    let i = this.past.length - 1;
    while (i > 0 && this.past[i].t > t) i--;
    const kept = this.past[i];
    const b = copy(kept.ball);
    if (t > kept.t) stepBall(b, t - kept.t, null, null);
    return b;
  }

  /** The ball hit `ago` seconds back, leaving at vel: played forward to now (its past rewritten). */
  hitThen(ago: number, vel: (then: Ball) => Ball['vel']): BallEvent[] {
    const ghost = this.then(ago);
    ghost.vel = vel(ghost);
    ghost.cooldown = PADDLE_COOLDOWN;
    const events: BallEvent[] = [{ type: 'paddle', at: { ...ghost.pos }, speed: Math.hypot(ghost.vel.x, ghost.vel.y, ghost.vel.z) }];
    if (ago > 0) stepBall(ghost, ago, null, null, events);
    this.ball.pos = ghost.pos; this.ball.vel = ghost.vel; this.ball.cooldown = ghost.cooldown;
    this.past = [{ t: this.time, ball: copy(this.ball) }];
    return events;
  }

  /**
   * Moves the ball on by dt, with the paddle moving from `from` to `to` over it as the tracker saw
   * it, `lag` seconds late. Says what the ball hit, and whether the paddle hit it (the ball jumps).
   */
  step(dt: number, lag: number, from: PaddlePose | null, to: PaddlePose | null, opts: StepOptions = {}): { events: BallEvent[]; hit: boolean } {
    let events: BallEvent[] = [];
    let hit = false;
    if (lag <= 0 || !from || !to) {
      stepBall(this.ball, dt, from, to, events, opts);
      hit = events.some((e) => e.type === 'paddle');
    } else {
      // The ball a lag ago, through this frame's swing.
      const ghost = this.then(lag);
      const seen = stepBall(ghost, dt, from, to, [], opts);
      const at = seen.findIndex((e) => e.type === 'paddle');
      if (at >= 0) {
        // Hit then: from there on (its bounces since included) to now.
        hit = true;
        events = seen.slice(at);
        stepBall(ghost, lag, null, null, events);
        this.ball.pos = ghost.pos; this.ball.vel = ghost.vel; this.ball.cooldown = ghost.cooldown;
      } else {
        stepBall(this.ball, dt, null, null, events);
      }
    }
    this.time += dt;
    // A hit rewrites the ball's past: it can't be met again before it.
    if (hit) this.past = [];
    this.past.push({ t: this.time, ball: copy(this.ball) });
    while (this.past.length > 1 && this.past[1].t < this.time - KEPT) this.past.shift();
    return { events, hit };
  }
}
