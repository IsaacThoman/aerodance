import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALL_R, TABLE, aimServe, firstBounce, stepBall, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { Ball, BallEvent, PaddlePose } from '../src/minigames/table-tennis/ball.ts';

const ball = (x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): Ball => ({ pos: v3(x, y, z), vel: v3(vx, vy, vz), cooldown: 0 });
/** A paddle facing down the table (its face's normal towards the board, −z). */
const paddle = (z: number, y = 1, x = 0, forgiving = false): PaddlePose => ({ center: v3(x, y, z), normal: v3(0, 0, -1), radius: forgiving ? 0.12 : 0.075, halfThickness: forgiving ? 0.04 : 0.005 });
/** Runs a ball for seconds at 60 fps, the paddle (optional) moving from a to b over the first frame and then still. */
function run(b: Ball, seconds: number, a?: PaddlePose, z?: PaddlePose): BallEvent[] {
  const events: BallEvent[] = [];
  for (let t = 0, first = true; t < seconds; t += 1 / 60, first = false) stepBall(b, 1 / 60, a ? (first ? a : z!) : null, z ?? null, events);
  return events;
}

test('a dropped ball bounces on the near half', () => {
  const b = ball(0, 1.2, 0.8);
  const events = run(b, 0.6);
  const bounce = events.find((e) => e.type === 'table');
  assert.ok(bounce, 'it hits the table');
  assert.ok(b.pos.y > TABLE.top, 'and is back up above it');
});

test('a ball tossed straight up comes back down to about where it started', () => {
  const b = ball(0.2, 1.1, 1.0, 0, 2.4, 0);
  run(b, 0.3);
  assert.ok(b.pos.y > 1.3, `it rises (${b.pos.y.toFixed(2)})`);
  assert.ok(Math.abs(b.pos.x - 0.2) < 1e-6 && Math.abs(b.pos.z - 1.0) < 1e-6);
});

test('a paddle swung through a hanging ball sends it over the net onto the far half', () => {
  // The ball at rest in the air, the paddle sweeping 5 cm at it in one frame (3 m/s), its face tipped up a little.
  const b = ball(0, 1.05, 1.3, 0, 0, 0);
  const up = (z: number): PaddlePose => ({ ...paddle(z, 1.05), normal: v3(0, 0.29, -0.96) });
  const events = run(b, 1.2, up(1.35), up(1.3));
  assert.ok(events.some((e) => e.type === 'paddle'), 'the paddle hits it');
  assert.ok(events.some((e) => e.type === 'table' && e.side === 'far'), `it lands on the far half (${events.map((e) => e.type).join(', ')})`);
});

test('a fast swing does not pass through the ball', () => {
  // 30 cm in one frame (18 m/s), from behind the ball to well past it.
  const b = ball(0, 1, 1.3);
  const events: BallEvent[] = [];
  stepBall(b, 1 / 60, paddle(1.45), paddle(1.15), events);
  assert.equal(events[0]?.type, 'paddle');
  assert.ok(b.vel.z < -5, `it leaves fast, down the table (${b.vel.z.toFixed(1)} m/s)`);
});

test('the forgiving paddle hits a ball the real one would miss', () => {
  const miss = ball(0.1, 1, 1.3), reach = ball(0.1, 1, 1.3);
  const real = run(miss, 0.1, paddle(1.4), paddle(1.25));
  const kind = run(reach, 0.1, paddle(1.4, 1, 0, true), paddle(1.25, 1, 0, true));
  assert.ok(!real.some((e) => e.type === 'paddle'), 'the real blade misses at 10 cm off centre');
  assert.ok(kind.some((e) => e.type === 'paddle'), 'the forgiving one reaches it');
});

test('a low, flat shot catches in the net', () => {
  const b = ball(0, TABLE.top + 0.1, 0.3, 0, 0, -6);
  const events = run(b, 1);
  assert.equal(events[0]?.type, 'net');
  assert.ok(b.pos.z > 0, 'and drops back on the near side');
  assert.ok(b.pos.y >= BALL_R);
});

test("the launcher's serve clears the net and first bounces where it was aimed", () => {
  const from = v3(0, TABLE.top + 0.3, -TABLE.halfLength - 0.25);
  for (const target of [v3(0, 0, 0.7), v3(-0.4, 0, 0.9), v3(0.35, 0, 0.5)]) {
    for (const flight of [0.6, 0.9]) {
      const vel = aimServe(from, target, flight);
      const landed = firstBounce({ pos: { ...from }, vel, cooldown: 0 });
      assert.ok(landed, `it lands (${flight} s at ${target.x}, ${target.z})`);
      assert.ok(Math.hypot(landed.at.x - target.x, landed.at.z - target.z) < 0.03, `on target (${landed.at.x.toFixed(2)}, ${landed.at.z.toFixed(2)})`);
    }
  }
});

test("in slow motion the paddle still hits at the player's own speed", () => {
  // The same 6 m/s swing over a 60th of a second, the world running at a quarter speed.
  const real = ball(0, 1, 1.3), slow = ball(0, 1, 1.3), naive = ball(0, 1, 1.3);
  stepBall(real, 1 / 60, paddle(1.4), paddle(1.3));
  stepBall(slow, 1 / 240, paddle(1.4), paddle(1.3), [], { paddleVel: v3(0, 0, -6) });
  // Without saying how fast the player swung, the swing would count four times as fast.
  stepBall(naive, 1 / 240, paddle(1.4), paddle(1.3));
  assert.ok(Math.abs(real.vel.z - slow.vel.z) < 0.15, `the same speed off the paddle (${real.vel.z.toFixed(2)} vs ${slow.vel.z.toFixed(2)})`);
  assert.ok(naive.vel.z < real.vel.z * 3, `not ${naive.vel.z.toFixed(1)} m/s`);
});
