import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { V3 } from '../src/minigames/table-tennis/ball.ts';
import { AUTOPLAY, arrival, autoplayBlade, autoplayRaised, autoplayServe } from '../src/minigames/table-tennis/autoplay.ts';
import { SERVE, bounced, dead, endOf, heldBall, hit, mine, mineBall, newRally, served } from '../src/minigames/table-tennis/rally.ts';
import { newRig } from '../src/minigames/table-tennis/rig.ts';
import { DEAD, Round } from '../src/minigames/table-tennis/round.ts';
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

test('the open rally counts shots in a row that land on the other half', () => {
  const r = newRally(0);
  // The serve is the server's shot, and counts when it lands.
  served(r);
  assert.equal(r.last, 0);
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
  served(r);
  bounced(r, 0);
  hit(r, 0);
  bounced(r, 1);
  hit(r, 1);
  bounced(r, 0);
  assert.equal(r.count, 3);
  hit(r, 0);
  hit(r, 0);
  assert.equal(r.count, 0);
  assert.equal(r.best, 3);
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
  // Serving, it waits behind the ball, then swings forward through it.
  const waiting = v3(0.3, 1.12, 1.27);
  assert.ok(autoplayServe(0.1, waiting).z > waiting.z + 0.2);
  assert.ok(autoplayServe(AUTOPLAY.serveWait + AUTOPLAY.serveWind + AUTOPLAY.swingS, waiting).z < waiting.z - 0.2);
});

/** A round of two stand-ins (autoplay.ts) through the game's own round, for `seconds`: its hits in order, and its serves. */
function rally(seconds: number, hitLag: Play['hitLag'] = 0) {
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  for (const rig of rigs) { rig.autoplay = true; rig.tracked = true; rig.latency = 0.1; }
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag, assist: 'normal', botLevel: 'medium', botAlways: true };
  const round = new Round(rigs, play, () => 0.5);
  const hits: number[] = [];
  let serves = 0, waited = 0, waits = 0, since = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    const servedAt = round.servedAt, flying = round.flying;
    round.step(FRAME, t * 1000, true);
    if (round.servedAt !== servedAt) { serves += 1; if (serves > 1) { waited += t - since; waits += 1; } }
    else for (const e of round.events) if (e.type === 'paddle' && e.by !== undefined) hits.push(e.by);
    if (flying && !round.flying) since = t;
  }
  return { round, hits, serves, meanWait: waits ? waited / waits : 0 };
}

test('two stand-ins serve by swinging through the waiting ball, and keep a rally going', () => {
  const { round, hits, serves } = rally(40);
  assert.ok(serves >= 1, 'the ball was served');
  assert.ok(hits.includes(0) && hits.includes(1), 'both ends hit the ball');
  assert.equal(round.hits, hits.length + serves);
  const best = Math.max(round.duel.best, round.duel.count);
  assert.ok(best >= 15, `a long rally (${best})`);
});

test('with lag compensation the stand-ins still rally', () => {
  const { round, hits } = rally(30, 0.1);
  assert.ok(hits.includes(0) && hits.includes(1));
  const best = Math.max(round.duel.best, round.duel.count);
  assert.ok(best >= 8, `a rally (${best})`);
});

test('a dead ball is soon back with a server, and a ball left waiting goes to the other one', () => {
  // Nobody at the far end: every serve dies there, and the ball is back in under a second.
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  rigs[0].autoplay = true; rigs[0].tracked = true;
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium', botAlways: true };
  const round = new Round(rigs, play, () => 0.5);
  let diedAt: number | null = null, servedAt: number | null = null, passedAt: number | null = null;
  for (let t = 0; t < 30 && passedAt === null; t += FRAME) {
    const flying = round.flying, server = round.server();
    round.step(FRAME, t * 1000, true);
    if (!flying && round.flying) servedAt ??= t;
    if (flying && !round.flying) diedAt ??= t;
    if (diedAt !== null && server === 1 && round.server() === 0) passedAt = t;
  }
  assert.ok(servedAt !== null && diedAt !== null, 'served, and dead');
  // It flew the table's length, bounced, and fell to the floor past the far end.
  assert.ok(diedAt - servedAt < 2.5, `dead ${(diedAt - servedAt).toFixed(2)} s after the serve`);
  assert.equal(endOf(round.ball.pos.z), 0, 'back with the first player, in the end');
  assert.ok(passedAt !== null && passedAt - diedAt > SERVE.pass - 0.1 && passedAt - diedAt < SERVE.pass + 0.5, 'the far player, not there, loses the serve');
  assert.ok(DEAD.floor < 0.5 && DEAD.second < 0.5 && SERVE.arm < 0.5);
});
