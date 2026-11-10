import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIST, SWING, assistReturn, contactNudge, interceptNudge, landsFar, strongestSwing, swingHit } from '../src/minigames/table-tennis/assist.ts';
import { TABLE, stepBall, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { Ball, BallEvent, PaddlePose, V3 } from '../src/minigames/table-tennis/ball.ts';

const ball = (pos: V3, vel: V3): Ball => ({ pos, vel, cooldown: 0 });
/** The real blade, facing down the table, at the player's end. */
const blade = (center: V3): PaddlePose => ({ center, normal: v3(0, 0, -1), radius: 0.075, halfThickness: 0.006 });
const still = v3();

/** Flies a ball at 60 fps for a second, the paddle held still at p (shifted by nudge each frame, if given). */
function fly(b: Ball, p: PaddlePose, reach = 0): BallEvent[] {
  const events: BallEvent[] = [];
  for (let i = 0; i < 60; i++) {
    const nudge = contactNudge(b, p, still, 1, reach) ?? v3();
    const at = { ...p, center: v3(p.center.x + nudge.x, p.center.y + nudge.y, p.center.z + nudge.z) };
    stepBall(b, 1 / 60, at, at, events);
  }
  return events;
}
/** Where a ball off the paddle first comes down (on the table, the floor, or caught in the net). */
function landing(from: V3, vel: V3): BallEvent {
  const events: BallEvent[] = [];
  const b = ball({ ...from }, { ...vel });
  for (let i = 0; i < 300 && !events.length; i++) stepBall(b, 1 / 60, null, null, events);
  return events[0];
}
/** How far a point is from the far half of the table (0 on it). */
const offFarHalf = (p: V3) => Math.hypot(Math.max(0, Math.abs(p.x) - TABLE.halfWidth), Math.max(0, p.z, -p.z - TABLE.halfLength));

test('the contact assist slides the blade to a ball it would have missed', () => {
  // The ball coming at the player 12 cm to the side of a still blade, which misses it.
  const start = () => ball(v3(0.12, 1, 0.9), v3(0, 0, 5));
  const paddle = blade(v3(0, 1, 1.3));
  assert.ok(!fly(start(), paddle).some((e) => e.type === 'paddle'), 'it misses unhelped');
  assert.ok(!fly(start(), paddle, ASSIST.low.reach).some((e) => e.type === 'paddle'), 'too far off for the low assist');
  assert.ok(fly(start(), paddle, ASSIST.medium.reach).some((e) => e.type === 'paddle'), 'the medium one reaches it');
});

test('the contact assist slides only across the face, and only for a ball closing on it', () => {
  const paddle = blade(v3(0, 1, 1.3));
  const nudge = contactNudge(ball(v3(0.1, 1.05, 1.0), v3(0, 0, 5)), paddle, still, 1, ASSIST.high.reach);
  assert.ok(nudge && Math.abs(nudge.z) < 1e-9, 'not along its normal (the swing stays the player\'s)');
  assert.ok(nudge.x > 0.09 && nudge.y > 0, `towards the ball (${nudge.x.toFixed(2)}, ${nudge.y.toFixed(2)})`);
  assert.equal(contactNudge(ball(v3(0.1, 1, 1.0), v3(0, 0, -5)), paddle, still, 1, ASSIST.high.reach), null, 'not for a ball going away');
  assert.equal(contactNudge(ball(v3(0.1, 1, -0.5), v3(0, 0, 5)), paddle, still, 1, ASSIST.high.reach), null, 'not while it is still far off');
  assert.equal(contactNudge(ball(v3(0.6, 1, 1.0), v3(0, 0, 5)), paddle, still, 1, ASSIST.high.reach), null, 'not for a swing nowhere near it');
  assert.equal(contactNudge(ball(v3(0.05, 1, 1.0), v3(0, 0, 5)), paddle, still, 1, ASSIST.off.reach), null, 'not with the assist off');
});

test('the landing assist brings a long return down on the far half, in the same general direction', () => {
  const from = v3(0.1, 1.0, 1.5);
  // Hit hard and high, a little to the left: it would fly off the end of the table.
  const long = v3(-0.6, 2.2, -8);
  assert.ok(!landsFar(from, long), 'it goes long unhelped');
  const helped = assistReturn(from, long, ASSIST.high.landing);
  assert.ok(landsFar(from, helped), 'the high assist lands it');
  assert.ok(helped.x < 0 && helped.z < -4, `still left and down the table (${helped.x.toFixed(1)}, ${helped.y.toFixed(1)}, ${helped.z.toFixed(1)})`);
  // The low assist only bends it part of the way: closer, though maybe not on.
  const low = assistReturn(from, long, ASSIST.low.landing);
  assert.ok(offFarHalf(landing(from, low).at) < offFarHalf(landing(from, long).at), 'the low assist lands it closer');
});

test('the landing assist lifts a return out of the net, and leaves a good one alone', () => {
  const from = v3(0, 0.95, 1.4);
  const low = v3(0, 0.5, -7);
  assert.equal(landing(from, low).type, 'net', 'it catches in the net unhelped');
  assert.ok(landsFar(from, assistReturn(from, low, ASSIST.high.landing)), 'the high assist clears it');
  const good = v3(0.2, 2.2, -4);
  assert.ok(landsFar(from, good));
  assert.deepEqual(assistReturn(from, good, ASSIST.high.landing), good, 'a return that lands is left as it was');
  // A ball knocked back towards the player isn't a return to fix.
  assert.deepEqual(assistReturn(from, v3(0, 2, 1), ASSIST.high.landing), v3(0, 2, 1));
});

test('at max, a rough forward swing that passes near the ball hits it, and the return lands', () => {
  // The ball coming in; the blade 25 cm off to the side of it (and edge-on: its face doesn't matter),
  // the player having just swung forward and across at 3 m/s.
  const swing = v3(-1.2, 0.3, -2.7);
  const centre = v3(0.25, 1.05, 1.3);
  const coming = ball(v3(0, 1, 1.4), v3(0, 0, 5));
  // Not yet at its nearest: wait.
  assert.equal(swingHit(ball(v3(0, 1, 1.0), v3(0, 0, 5)), centre, swing, swing, 1), null);
  const vel = swingHit(coming, centre, swing, swing, 1);
  assert.ok(vel, 'it hits');
  assert.ok(vel.z < -1 && vel.x < 0, `down the table, the way the swing went (${vel.x.toFixed(1)}, ${vel.y.toFixed(1)}, ${vel.z.toFixed(1)})`);
  assert.ok(landsFar(coming.pos, assistReturn(coming.pos, vel, ASSIST.max.landing)), 'and the assist lands it');
});

test('at max, no swing, a pull back, or a ball well away is no hit', () => {
  const centre = v3(0.25, 1.05, 1.3);
  const coming = ball(v3(0, 1, 1.25), v3(0, 0, 5));
  assert.equal(swingHit(coming, centre, still, v3(0, 0, -0.3), 1), null, 'too slow to be a swing');
  assert.equal(swingHit(ball(v3(0.7, 1, 1.25), v3(0, 0, 5)), centre, still, v3(0, 0, -3), 1), null, `beyond ${SWING.zone} m`);
  assert.equal(swingHit(ball(v3(0, 1, 1.25), v3(0, 0, -5)), centre, still, v3(0, 0, -3), 1), null, 'a ball going away');
  // The swing is the strongest forward one lately, not the wind-up.
  const speeds = [{ t: 0.9, vel: v3(0, 0, 4) }, { t: 1.0, vel: v3(0, 0.5, -2) }, { t: 0.5, vel: v3(0, 0, -6) }];
  assert.deepEqual(strongestSwing(speeds, 1.05), v3(0, 0.5, -2));
});

test('at max, the blade reaches for the ball in 3D, including a swing that is early or late', () => {
  // The ball 15 cm short of where the blade is heading, and 20 cm to the side: the blade is sent there.
  const coming = ball(v3(0.2, 1, 0.9), v3(0, 0.5, 5));
  const nudge = interceptNudge(coming, v3(0, 1, 1.4), v3(0, 0, -2), 1, ASSIST.max.reach);
  assert.ok(nudge, 'it reaches');
  assert.ok(nudge.x > 0.15, `across (${nudge.x.toFixed(2)})`);
  assert.equal(interceptNudge(coming, v3(0, 1, 1.4), v3(0, 0, -2), 1, ASSIST.high.reach * 0), null, 'not with no reach');
});
