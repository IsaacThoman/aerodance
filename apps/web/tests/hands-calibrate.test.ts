import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALIBRATE, coming, describePass, endPass, offsetWords, recalibrate, shiftWords, trackPass } from '../src/hands/calibrate.ts';
import { stepBall, v3 } from '../src/hands/ball.ts';
import type { Ball, V3 } from '../src/hands/ball.ts';

/** A ball flown at 60 fps past a still paddle at p: its pass, ended as it goes by. */
function pass(p: V3, swing: number, hit = false) {
  const b: Ball = { pos: v3(0, 1, 0.9), vel: v3(0, 0, 5), cooldown: 0 };
  let kept = null;
  for (let i = 0; i < 120 && coming(b, p.z); i++) {
    kept = trackPass(kept, b, p, swing);
    stepBall(b, 1 / 60, null, null);
  }
  assert.ok(kept && !coming(b, p.z), 'the ball goes by');
  return endPass(kept, hit, 0.8);
}

test('a pass keeps where the ball came nearest, and which way the paddle was off', () => {
  // The paddle 25 cm low and 10 cm right of the ball's line.
  const p = pass(v3(0.1, 0.75, 1.3), 2);
  assert.equal(p.kind, 'miss');
  assert.ok(Math.abs(p.offset.x - 0.1) < 0.01 && Math.abs(p.offset.y + 0.25) < 0.04 && Math.abs(p.offset.z) < 0.05, JSON.stringify(p.offset));
  assert.match(describePass(p), /^Missed by 2\d cm · paddle 2\d cm low, 10 cm right$/);
  assert.equal(pass(v3(0.1, 0.75, 1.3), 0).kind, 'still', 'not swung at');
  assert.match(describePass(pass(v3(0.1, 0.75, 1.3), 2, true)), /^Hit · paddle 2\d cm low, 10 cm right$/);
});

test('the calibration shifts the paddle by the steady way swings miss, across and up only', () => {
  let shift = v3();
  // Swings that miss 20 cm low and 8 cm left, a little noisily.
  for (let i = 0; i < 12; i++) {
    const noise = i % 2 ? 0.04 : -0.04;
    shift = recalibrate(shift, { kind: 'miss', nearest: 0.25, swing: 2, offset: v3(-0.08 + noise + shift.x, -0.2 - noise + shift.y, 0.1) });
  }
  assert.ok(Math.abs(shift.x - 0.08) < 0.03 && Math.abs(shift.y - 0.2) < 0.03 && shift.z === 0, JSON.stringify(shift));
  assert.equal(shiftWords(shift).includes('cm up') && shiftWords(shift).includes('cm right'), true);
});

test('the calibration leaves passes that do not count, and is held to its furthest', () => {
  const none = v3();
  assert.deepEqual(recalibrate(none, { kind: 'still', nearest: 0.2, swing: 0, offset: v3(0, -0.2, 0) }), none, 'not swung at');
  assert.deepEqual(recalibrate(none, { kind: 'miss', nearest: CALIBRATE.counts + 0.1, swing: 2, offset: v3(0, -0.7, 0) }), none, 'nowhere near');
  let shift = v3();
  for (let i = 0; i < 30; i++) shift = recalibrate(shift, { kind: 'miss', nearest: 0.55, swing: 2, offset: v3(-0.4, -0.4, 0) });
  assert.ok(Math.abs(Math.hypot(shift.x, shift.y) - CALIBRATE.max) < 1e-9);
  assert.equal(offsetWords(v3(0.02, -0.03, 0.01)), 'centred');
});
