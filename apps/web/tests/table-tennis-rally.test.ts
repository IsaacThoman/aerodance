import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { V3 } from '../src/minigames/table-tennis/ball.ts';
import { AUTOPLAY, arrival, autoplayBlade, autoplayRaised, autoplayServe } from '../src/minigames/table-tennis/autoplay.ts';
import { SERVE, TOSS_S, endOf, heldBall, mine, mineBall, tossedBall } from '../src/minigames/table-tennis/rally.ts';
import { REST, heldPose, newHandFilters, newRig, takeHand, wristFor } from '../src/minigames/table-tennis/rig.ts';
import { PACE } from '../src/minigames/table-tennis/assist.ts';
import { BEAT, DEAD, Round } from '../src/minigames/table-tennis/round.ts';
import type { Play } from '../src/minigames/table-tennis/round.ts';

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

test("each server's ball waits over their own end, on the side of their paddle hand", () => {
  for (const end of [0, 1] as const) {
    const held = heldBall(end, 0);
    assert.equal(endOf(held.pos.z), end);
    assert.ok(Math.abs(held.pos.z) > TABLE.halfLength - 0.3);
    assert.deepEqual(held.vel, v3());
    // Their right, in their own frame, for a right-handed server; their left for a left-handed one.
    assert.ok(mine(end, held.pos).x > 0.1);
    assert.ok(mine(end, heldBall(end, 0, 'left').pos).x < -0.1);
  }
});

test('the serve tossed goes straight up from where it waited, comes back down, and is back waiting once it has dropped past', () => {
  const waiting = heldBall(0, 0, 'right').pos;
  const top = tossedBall(0, SERVE.toss / 9.81, 'right')!;
  assert.ok(Math.abs(top.pos.y - waiting.y - (SERVE.toss * SERVE.toss) / (2 * 9.81)) < 0.02, 'up to its height');
  assert.ok(Math.abs(top.pos.x - waiting.x) < 1e-9 && Math.abs(top.pos.z - waiting.z) < 1e-9, 'straight up');
  assert.ok(Math.abs(top.vel.y) < 1e-9);
  const falling = tossedBall(0, TOSS_S - 0.05, 'right')!;
  assert.ok(falling.vel.y < 0 && falling.pos.y < waiting.y, 'coming back down past where it was');
  assert.equal(tossedBall(0, TOSS_S + 0.01, 'right'), null);
  // The far player's, in their own frame, is the same.
  assert.ok(close(mine(1, tossedBall(1, 0.3, 'left')!.pos), tossedBall(0, 0.3, 'left')!.pos));
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
  assert.ok(!autoplayRaised(AUTOPLAY.serveAfter - 0.1));
  assert.ok(autoplayRaised(AUTOPLAY.serveAfter + 0.1));
  // Serving, it waits behind the ball, untossed and tossed, then swings forward through it as it comes down.
  const waiting = v3(0.3, 1.12, 1.27);
  assert.ok(autoplayServe(null, waiting).z > waiting.z + 0.2);
  assert.ok(autoplayServe(0.1, waiting).z > waiting.z + 0.2);
  assert.ok(autoplayServe(AUTOPLAY.swingAt + AUTOPLAY.swingS, waiting).z < waiting.z - 0.2);
});

const PLAY: Play = { mode: 'match', forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium' };

/** A round of two stand-ins (autoplay.ts) through the game's own round, for `seconds`: its hits in order, and its serves. */
function rally(seconds: number, hitLag: Play['hitLag'] = 0) {
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  for (const rig of rigs) { rig.autoplay = true; rig.tracked = true; rig.latency = 0.1; }
  const round = new Round(rigs, { ...PLAY, hitLag }, () => 0.5);
  const hits: number[] = [];
  let serves = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    const servedAt = round.servedAt;
    round.step(FRAME, t * 1000, true);
    if (round.servedAt !== servedAt) serves += 1;
    else for (const e of round.events) if (e.type === 'paddle' && e.by !== undefined) hits.push(e.by);
  }
  return { round, hits, serves, best: Math.max(round.best, round.rally) };
}

test('two stand-ins serve by tossing the ball and swinging through it, and keep a rally going', () => {
  const { round, hits, serves, best } = rally(40);
  assert.ok(serves >= 1, 'the ball was served');
  assert.ok(hits.includes(0) && hits.includes(1), 'both ends hit the ball');
  assert.equal(round.hits, hits.length + serves);
  assert.ok(best >= 15, `a long rally (${best})`);
});

test('with lag compensation the stand-ins still rally', () => {
  const { hits, best } = rally(30, 0.1);
  assert.ok(hits.includes(0) && hits.includes(1));
  assert.ok(best >= 8, `a rally (${best})`);
});

test('a serve nobody answers is the server\'s point, the next serve comes after a beat, and the serve changes every two points', () => {
  // Nobody playing at the far end: Player 1's serves land and get by.
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  rigs[0].autoplay = true; rigs[0].tracked = true;
  const round = new Round(rigs, { ...PLAY }, () => 0.5);
  const served: number[] = [], won: number[] = [];
  for (let t = 0; t < 15; t += FRAME) {
    const flying = round.flying, point = round.point;
    round.step(FRAME, t * 1000, true);
    if (!flying && round.flying) served.push(t);
    if (round.point !== point) {
      won.push(t);
      assert.equal(round.point!.to, 0, "the server's point");
      assert.ok(round.point!.reason === 'double' || round.point!.reason === 'missed', round.point!.reason);
    }
  }
  assert.equal(served.length, 2, 'two serves, then it was the other player\'s');
  assert.deepEqual(round.match.score, [2, 0]);
  assert.equal(round.server(), 1);
  assert.ok(round.holding(), 'waiting for Player 2, who is not there');
  // It flew the table's length and bounced again or fell to the floor past the far end.
  assert.ok(won[0] - served[0] < 2.5, `won ${(won[0] - served[0]).toFixed(2)} s after the serve`);
  assert.ok(served[1] - won[0] > BEAT.point - 0.05, `served again ${(served[1] - won[0]).toFixed(2)} s later`);
  assert.ok(served[1] - won[0] < BEAT.point + SERVE.arm + 2, `served again ${(served[1] - won[0]).toFixed(2)} s later`);
  assert.ok(DEAD.floor < 0.5 && DEAD.second < 0.5 && SERVE.arm < 0.5);
});

/**
 * A server alone at the table (the far player stands away), who raises their free hand at 1 s to
 * toss the ball, their paddle hand going from its rest to `to` (their own frame) over `rise`
 * seconds as the ball comes back down (centred on its coming back past a hand's breadth over where
 * it waited), seen by a 30 Hz camera 90 ms late: when the ball was served, if it was.
 */
function reach(to: V3, rise: number, served?: (round: Round, t: number) => void, toss = true): number | null {
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  // (The camera's delay, as the tracker measures it: the hits allow for it.)
  for (const rig of rigs) { rig.tracked = true; rig.latency = 0.09; }
  const round = new Round(rigs, { ...PLAY, hitLag: 'auto' }, () => 0.5);
  const filters = newHandFilters();
  const from = REST.right, target = wristFor(rigs[0], to);
  const queue: { at: number; side: 'left' | 'right'; wrist: V3 }[] = [];
  const meet = (SERVE.toss + Math.sqrt(SERVE.toss * SERVE.toss - 2 * 9.81 * 0.08)) / 9.81;
  let tossed: number | null = null;
  for (let t = 0; t < 4; t += FRAME) {
    if (Math.floor(t * 30) !== Math.floor((t - FRAME) * 30)) {
      // (Without a toss, the swing comes at 1 s.)
      const start = !toss ? 1 : tossed === null ? Infinity : tossed + meet - rise / 2;
      const u = Math.min(1, Math.max(0, (t - start) / rise)), k = u * u * (3 - 2 * u);
      queue.push({ at: t + 0.09, side: 'right', wrist: v3(from.x + (target.x - from.x) * k, from.y + (target.y - from.y) * k, from.z + (target.z - from.z) * k) });
      queue.push({ at: t + 0.09, side: 'left', wrist: toss && t >= 1 && t < 1.3 ? v3(-0.05, 0.3, -0.15) : v3(-0.05, -0.4, -0.1) });
    }
    while (queue.length && queue[0].at <= t) { const q = queue.shift()!; takeHand(rigs[0], q.side, heldPose(q.side, q.wrist), t * 1000, filters); }
    round.step(FRAME, t * 1000, true);
    if (tossed === null && round.tossAt !== null) tossed = t;
    if (round.flying) { served?.(round, t); return t; }
  }
  return null;
}

test('bringing the paddle up to the waiting ball to get ready does not serve it; swinging through it does', () => {
  const ball = mine(0, heldBall(0, 0, 'right').pos);
  for (const rise of [0.2, 0.3, 0.4, 0.5]) {
    assert.equal(reach(AUTOPLAY.home, rise), null, `to the ready place in ${rise} s`);
    assert.equal(reach(v3(ball.x - 0.05, ball.y + 0.12, ball.z + 0.1), rise), null, `to just above and behind the ball in ${rise} s`);
    assert.equal(reach(v3(ball.x + 0.02, ball.y - 0.1, ball.z + 0.12), rise), null, `to just below and behind it in ${rise} s`);
  }
  // On through the ball, a paddle's length past it: served.
  for (const rise of [0.2, 0.3]) assert.ok(reach(v3(ball.x - 0.05, ball.y + 0.05, ball.z - 0.25), rise) !== null, `through it in ${rise} s`);
});

test("however hard it's swung, a serve gives the other player time to get ready for it", () => {
  const ball = mine(0, heldBall(0, 0, 'right').pos);
  // Through the ball and well past it, in a tenth of a second or three.
  for (const rise of [0.1, 0.15, 0.3]) {
    let flight = 0;
    const at = reach(v3(ball.x - 0.1, ball.y + 0.1, ball.z - 0.5), rise, (round, t) => {
      // On to the other end of the table.
      for (let u = t + FRAME; u < t + 3 && round.ball.pos.z > -TABLE.halfLength; u += FRAME) { round.step(FRAME, u * 1000, true); flight += FRAME; }
      assert.equal(round.returns, 1, 'it landed on their half');
    });
    assert.ok(at !== null, `served in ${rise} s`);
    assert.ok(flight >= PACE.serve.least - 0.03 && flight < PACE.serve.gentle + 0.15, `a ${rise} s swing's serve is there in ${flight.toFixed(2)} s`);
  }
});

test('the waiting ball is not served without a toss, however it is swung at', () => {
  const ball = mine(0, heldBall(0, 0, 'right').pos);
  for (const rise of [0.2, 0.3]) assert.equal(reach(v3(ball.x - 0.05, ball.y + 0.05, ball.z - 0.25), rise, undefined, false), null, `through it in ${rise} s, untossed`);
});

test('Space serves at once, whoever is to serve', () => {
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  const play: Play = { ...PLAY };
  const round = new Round(rigs, play, () => 0.5);
  play.serve = true;
  round.step(FRAME, 0, true);
  assert.ok(round.flying, "a player's serve");
  const alone = new Round([newRig(0, 'right')], { ...PLAY }, () => 0.5);
  // Alone, the robot serves the match's third point: give the player the first two.
  alone.match.score = [1, 1];
  alone.play.serve = true;
  for (let i = 0; i < 120 && !alone.flying; i++) alone.step(FRAME, i * 1000 * FRAME, true);
  assert.ok(alone.flying && alone.shot?.by === 1, "the robot's serve, as soon as it's ready");
});
