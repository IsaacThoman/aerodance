import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIST, SWING, strongestSwing } from '../src/minigames/table-tennis/assist.ts';
import { TABLE, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { PaddlePose, V3 } from '../src/minigames/table-tennis/ball.ts';
import { AUTOPLAY, arrival, autoplayBlade, autoplayRaised } from '../src/minigames/table-tennis/autoplay.ts';
import { flightStep } from '../src/minigames/table-tennis/flight.ts';
import type { Swinger } from '../src/minigames/table-tennis/flight.ts';
import { LaggedBall } from '../src/minigames/table-tennis/lagged.ts';
import { bounced, dead, endOf, heldBall, hit, mine, mineBall, newRally, tossBall, tossed } from '../src/minigames/table-tennis/rally.ts';
import type { End } from '../src/minigames/table-tennis/rally.ts';

const FRAME = 1 / 60;
const close = (a: V3, b: V3, eps = 1e-12) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < eps;

test('mine turns the table half round, and is its own inverse', () => {
  const p = v3(0.3, 1.1, -0.9);
  assert.deepEqual(mine(0, p), p);
  assert.ok(close(mine(1, p), v3(-0.3, 1.1, 0.9)));
  assert.ok(close(mine(1, mine(1, p)), p));
  const b = mineBall(1, { pos: p, vel: v3(1, 2, 3), cooldown: 0.05 });
  assert.ok(close(b.vel, v3(-1, 2, -3)));
  assert.equal(b.cooldown, 0.05);
  assert.equal(endOf(0.4), 0);
  assert.equal(endOf(-0.4), 1);
});

test("each server's ball is held over their own end, and tossed up towards them", () => {
  for (const end of [0, 1] as const) {
    const held = heldBall(end, 0), toss = tossBall(end);
    assert.equal(endOf(held.pos.z), end);
    assert.ok(Math.abs(held.pos.z) > TABLE.halfLength - 0.2);
    // Up, and towards its server (who stands at +z in their own frame).
    assert.ok(toss.vel.y > 2);
    assert.ok(mine(end, toss.vel).z > 0);
  }
});

test('the open rally counts shots in a row that land on the other half', () => {
  const r = newRally(0);
  tossed(r);
  hit(r, 0);
  assert.equal(bounced(r, 1), 'fair');
  // A second bounce on the same half changes nothing.
  assert.equal(bounced(r, 1), null);
  hit(r, 1);
  assert.equal(bounced(r, 0), 'fair');
  assert.equal(r.count, 2);
  // A shot that comes down on the hitter's own half doesn't count, and played back anyway, the count starts again.
  hit(r, 0);
  assert.equal(bounced(r, 0), 'short');
  assert.equal(r.count, 2);
  hit(r, 1);
  assert.equal(r.count, 0);
  assert.equal(r.best, 2);
  assert.equal(bounced(r, 0), 'fair');
  // Dead at the far end: the far player serves, and the count is banked.
  dead(r, 1);
  assert.equal(r.server, 1);
  assert.equal(r.count, 0);
  assert.equal(r.best, 2);
  // Hitting twice running ends a count too.
  tossed(r);
  hit(r, 1);
  bounced(r, 0);
  hit(r, 0);
  bounced(r, 1);
  hit(r, 0);
  assert.equal(r.count, 0);
  assert.equal(r.best, 2);
});

test('the stand-in lines up behind the ball and swings forward through it', () => {
  // Coming at it in its own frame, from the far half.
  const seen = { pos: v3(0.1, 1.05, -1), vel: v3(0, 1.2, 5.5), cooldown: 0 };
  const coming = arrival(seen);
  assert.ok(coming && coming.t > 0.2 && Math.abs(coming.at.z - AUTOPLAY.hitZ) < 0.03);
  const early = autoplayBlade({ ...coming, t: 0.5 }), late = autoplayBlade({ ...coming, t: 0 });
  assert.ok(early.z > late.z + 0.2, 'swung forward (towards −z)');
  assert.ok(Math.abs(late.z - AUTOPLAY.hitZ) < 1e-9);
  assert.equal(arrival({ ...seen, vel: v3(0, 0, -5) }), null, 'a ball going away is left');
  assert.ok(!autoplayRaised(null));
  assert.ok(!autoplayRaised(0.5));
  assert.ok(autoplayRaised(AUTOPLAY.serveAfter + 0.1));
});

/** The blade's face as the game's resting grip has it: forward, a little down. */
const FACE = v3(0, -0.6, -0.8);

/**
 * Two stand-ins rallying through the game's own flight step: each one's blade eased towards
 * where autoplay puts it (as the drawn hand eases onto the tracked one), in its own frame; the
 * serve held, then tossed when the server's hand goes up; the rally's rules on the ball's events.
 */
function rally(seconds: number, lag = 0) {
  const r = newRally(0);
  const players = ([0, 1] as const).map((end) => ({ end, blade: { ...AUTOPLAY.home }, prevBlade: null as V3 | null, prevPose: null as PaddlePose | null, speeds: [] as { t: number; vel: V3 }[] }));
  let lagged: LaggedBall | null = null, holding = 0, deadAt = Infinity;
  const hits: End[] = [];
  let fair = 0, tosses = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    for (const p of players) {
      const seen = lagged ? mineBall(p.end, lagged.then(lag)) : null;
      const target = autoplayBlade(seen && arrival(seen));
      const k = 1 - Math.exp(-24 * FRAME);
      p.prevBlade = { ...p.blade };
      p.blade = v3(p.blade.x + (target.x - p.blade.x) * k, p.blade.y + (target.y - p.blade.y) * k, p.blade.z + (target.z - p.blade.z) * k);
      p.speeds.push({ t, vel: v3((p.blade.x - p.prevBlade.x) / FRAME, (p.blade.y - p.prevBlade.y) / FRAME, (p.blade.z - p.prevBlade.z) / FRAME) });
      while (p.speeds.length && t - p.speeds[0].t > 0.5) p.speeds.shift();
    }
    if (!lagged) {
      holding += FRAME;
      if (autoplayRaised(holding)) {
        lagged = new LaggedBall(tossBall(r.server), t);
        tossed(r);
        tosses += 1;
        holding = 0;
        deadAt = Infinity;
      }
      continue;
    }
    const swingers: Swinger[] = players.map((p) => {
      const pose: PaddlePose = { center: mine(p.end, p.blade), normal: mine(p.end, FACE), radius: 0.075, halfThickness: 0.006 };
      const s: Swinger = {
        end: p.end, raw: p.blade, lag, from: p.prevPose ?? pose, to: pose,
        paddleVel: p.speeds.at(-1)?.vel, swing: strongestSwing(p.speeds, t),
      };
      p.prevPose = pose;
      return s;
    });
    const { events } = flightStep(lagged, FRAME, swingers, ASSIST.max, 1);
    for (const e of events) {
      if (e.type === 'paddle' && e.by !== undefined) { hit(r, e.by); hits.push(e.by); }
      if (e.type === 'table' && bounced(r, endOf(e.at.z)) === 'fair') fair += 1;
      if (e.type === 'floor' && deadAt === Infinity) deadAt = t + 1;
    }
    if (t > deadAt) { dead(r, endOf(lagged.ball.pos.z)); lagged = null; }
  }
  return { r, hits, fair, tosses };
}

test('two stand-ins keep a rally going through the mirrored flight step', () => {
  const { r, hits, fair, tosses } = rally(30);
  assert.ok(tosses >= 1);
  assert.ok(hits.includes(0) && hits.includes(1), 'both ends hit the ball');
  // Hits alternate between the ends (nobody hits their own shot), and land fair.
  for (let i = 1; i < hits.length; i++) assert.notEqual(hits[i], hits[i - 1], `hit ${i} alternates`);
  assert.ok(fair >= hits.length - 1 - tosses, `${fair} of ${hits.length} land fair`);
  assert.ok(Math.max(r.best, r.count) >= 20, `a long rally (${Math.max(r.best, r.count)})`);
});

test('with lag compensation the stand-ins still rally', () => {
  const { r, hits } = rally(20, 0.1);
  assert.ok(hits.includes(0) && hits.includes(1));
  assert.ok(Math.max(r.best, r.count) >= 10, `a rally (${Math.max(r.best, r.count)})`);
  assert.ok(SWING.minSpeed > 0);
});
