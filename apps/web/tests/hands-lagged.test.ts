import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepBall, v3 } from '../src/hands/ball.ts';
import type { Ball, PaddlePose } from '../src/hands/ball.ts';
import { LaggedBall } from '../src/hands/lagged.ts';

const FRAME = 1 / 60;
// Coming at about 5 m/s, back at the blade's height 0.2 s on, near z 1.5.
const coming = (): Ball => ({ pos: v3(0, 1, 0.56), vel: v3(0, 0.98, 5), cooldown: 0 });
/** The real blade, facing down the table. */
const blade = (z: number, y = 1): PaddlePose => ({ center: v3(0, y, z), normal: v3(0, 0, -1), radius: 0.075, halfThickness: 0.006 });
const dist = (a: Ball, b: Ball) => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);

/** Held low, out of the ball's way. */
const REST = blade(1.56, 0.4);
/**
 * The ball coming at 5 m/s; the player's real swing (12 cm towards it, in a frame) meets it after
 * 0.2 s at z 1.5, as the ball reaches it. The camera sees that swing `seenLate` seconds late.
 */
function play(lag: number, seenLate: number) {
  const lagged = new LaggedBall(coming());
  const swingAt = 0.2 + seenLate;
  let hitAt: number | null = null;
  for (let t = 0; t < 0.42; t += FRAME) {
    const swinging = Math.abs(t - swingAt) < FRAME / 2;
    const { hit } = lagged.step(FRAME, lag, swinging ? blade(1.56) : REST, swinging ? blade(1.44) : REST);
    if (hit) hitAt ??= t;
  }
  return { ball: lagged.ball, hitAt };
}

test('with no lag, it is the plain step', () => {
  const plain = coming(), lagged = new LaggedBall(coming());
  for (let i = 0; i < 20; i++) { stepBall(plain, FRAME, blade(1.56), blade(1.5)); lagged.step(FRAME, 0, blade(1.56), blade(1.5)); }
  assert.ok(dist(plain, lagged.ball) < 1e-9);
});

test('a swing on time, seen late, misses unless the lag is made up for', () => {
  const late = 0.1;
  assert.equal(play(0, late).hitAt, null, 'the ball has gone by when the late swing is seen');
  const made = play(late, late);
  assert.ok(made.hitAt !== null, 'compensated, it hits');
  // And the ball is now where an on-time hit, seen at once, would have put it.
  const truth = play(0, 0);
  assert.ok(truth.hitAt !== null);
  assert.ok(dist(made.ball, truth.ball) < 0.03, `where it should be (${dist(made.ball, truth.ball).toFixed(3)} m off)`);
});

test('a hit rewrites the past: the ball cannot be met again before it', () => {
  const lagged = new LaggedBall(coming());
  let hit = false;
  for (let t = 0; t < 0.6 && !hit; t += FRAME) { const swinging = Math.abs(t - 0.3) < FRAME / 2; hit = lagged.step(FRAME, 0.1, swinging ? blade(1.56) : REST, swinging ? blade(1.44) : REST).hit; }
  assert.ok(hit);
  const after = lagged.then(0.1);
  assert.ok(dist(after, lagged.ball) < 1e-9, 'its past starts at the hit');
});
