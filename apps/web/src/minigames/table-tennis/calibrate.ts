/*
 * Table Tennis's miss readout and paddle calibration, in ball.ts's table frame. Each time a
 * ball comes at the player, where it passed nearest the paddle (as the player saw it, a lag ago)
 * is kept: a hit or a miss, it says how far off the paddle was and which way. If the tracking puts
 * the paddle a steady way off from where the player's hand feels it is, swings miss the same way
 * time after time, so the paddle is shifted, a share at a time, by the way they missed: across and
 * up or down only (a miss nearer or further down the table is mostly the swing's timing).
 */

import { v3 } from './ball.ts';
import type { Ball, V3 } from './ball.ts';

export const CALIBRATE = {
  /** The share of each pass's miss the paddle is shifted by. */
  rate: 0.3,
  /** Passes nearer than this (m) count, if swung at: further off, the player wasn't trying for it. */
  counts: 0.6,
  /** The furthest the paddle is shifted (m). */
  max: 0.35,
  /** A ball this far (m) past the paddle has gone by it. */
  past: 0.5,
} as const;

/** A ball's pass by the paddle: how near it came, the paddle's offset from it then, and the swing's speed then (m/s). */
export interface Pass { nearest: number; offset: V3; swing: number; }
/** How a pass went: hit, missed swinging, or missed without a swing. */
export interface PassResult extends Pass { kind: 'hit' | 'miss' | 'still'; }

/** The pass so far, with this frame's ball (as seen) and paddle (its centre, as tracked) in it. */
export function trackPass(pass: Pass | null, ball: Ball, paddle: V3, swing: number): Pass {
  const offset = v3(paddle.x - ball.pos.x, paddle.y - ball.pos.y, paddle.z - ball.pos.z);
  const nearest = Math.hypot(offset.x, offset.y, offset.z);
  return pass && pass.nearest <= nearest ? pass : { nearest, offset, swing };
}

/** Whether a ball is coming at the player (not yet gone past the paddle at z). */
export const coming = (ball: Ball, paddleZ: number) => ball.vel.z > 0 && ball.cooldown <= 0 && ball.pos.z - paddleZ < CALIBRATE.past;

export function endPass(pass: Pass, hit: boolean, minSwing: number): PassResult {
  return { ...pass, kind: hit ? 'hit' : pass.swing >= minSwing ? 'miss' : 'still' };
}

/** The paddle's shift after a pass: moved a share of the way it missed by (if it counts). */
export function recalibrate(shift: V3, pass: PassResult, rate: number = CALIBRATE.rate): V3 {
  if (pass.kind === 'still' || pass.nearest > CALIBRATE.counts) return shift;
  const x = shift.x - pass.offset.x * rate, y = shift.y - pass.offset.y * rate;
  const k = Math.min(1, CALIBRATE.max / (Math.hypot(x, y) || 1));
  return v3(x * k, y * k, shift.z);
}

const cm = (m: number) => Math.round(Math.abs(m) * 100);
/** Which way a paddle offset is from the ball, its parts of 5 cm or more ("30 cm low, 12 cm right"). */
export function offsetWords(offset: V3): string {
  const parts = [
    [offset.y, 'high', 'low'],
    [offset.x, 'right', 'left'],
    [offset.z, 'back', 'forward'],
  ] as const;
  const said = parts.filter(([m]) => cm(m) >= 5).map(([m, up, down]) => `${cm(m)} cm ${m > 0 ? up : down}`);
  return said.length ? said.join(', ') : 'centred';
}

/** A pass, said for the HUD. */
export function describePass(pass: PassResult): string {
  if (pass.kind === 'hit') return `Hit · paddle ${offsetWords(pass.offset)}`;
  if (pass.kind === 'still') return `Missed · no swing as it passed (${cm(pass.nearest)} cm away)`;
  return `Missed by ${cm(pass.nearest)} cm · paddle ${offsetWords(pass.offset)}`;
}

/** The paddle's shift, said for the HUD ("8 cm up, 4 cm left"). */
export function shiftWords(shift: V3): string {
  const parts = [[shift.y, 'up', 'down'], [shift.x, 'right', 'left']] as const;
  const said = parts.filter(([m]) => cm(m) >= 1).map(([m, up, down]) => `${cm(m)} cm ${m > 0 ? up : down}`);
  return said.length ? said.join(', ') : 'none yet';
}
