import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { V3 } from '../src/minigames/table-tennis/ball.ts';
import { AUTOPLAY, arrival, autoplayBlade, autoplayRaised, autoplayServe } from '../src/minigames/table-tennis/autoplay.ts';
import { SERVE, bounced, dead, endOf, heldBall, hit, mine, mineBall, newRally, served } from '../src/minigames/table-tennis/rally.ts';
import { REST, heldPose, newHandFilters, newRig, takeHand, wristFor } from '../src/minigames/table-tennis/rig.ts';
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

test('a dead ball is soon back with a player who is playing, and a ball left waiting goes to the other one', () => {
  // Nobody playing at the far end: every serve dies there, and comes straight back to the server.
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  rigs[0].autoplay = true; rigs[0].tracked = true;
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium', botAlways: true };
  const round = new Round(rigs, play, () => 0.5);
  const served: number[] = [], died: number[] = [];
  for (let t = 0; t < 20; t += FRAME) {
    const flying = round.flying;
    round.step(FRAME, t * 1000, true);
    if (!flying && round.flying) served.push(t);
    if (flying && !round.flying) { died.push(t); assert.equal(round.server(), 0, 'back with the player who is there'); }
  }
  assert.ok(served.length >= 4, `served again and again (${served.length})`);
  // It flew the table's length, bounced, and fell to the floor past the far end.
  assert.ok(died[0] - served[0] < 2.5, `dead ${(died[0] - served[0]).toFixed(2)} s after the serve`);
  assert.ok(served[1] - died[0] < 2, `served again ${(served[1] - died[0]).toFixed(2)} s later`);
  assert.ok(DEAD.floor < 0.5 && DEAD.second < 0.5 && SERVE.arm < 0.5);
  // Nobody playing at either end: the ball goes from one to the other, for whoever comes first.
  const idle = new Round([newRig(0, 'right'), newRig(1, 'right')], { ...play }, () => 0.5);
  const servers: number[] = [];
  for (let t = 0; t < SERVE.pass * 2.5; t += FRAME) { idle.step(FRAME, t * 1000, true); if (servers.at(-1) !== idle.server()) servers.push(idle.server()); }
  assert.deepEqual(servers, [0, 1, 0]);
});

/**
 * A server alone at the table (the far player stands away), their paddle hand going from its rest
 * to `to` (their own frame) over `rise` seconds from the first second on, seen by a 30 Hz camera
 * 90 ms late: when the ball was served, if it was.
 */
function reach(to: V3, rise: number): number | null {
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  for (const rig of rigs) rig.tracked = true;
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 'auto', assist: 'normal', botLevel: 'medium', botAlways: true };
  const round = new Round(rigs, play, () => 0.5);
  const filters = newHandFilters();
  const from = REST.right, target = wristFor(rigs[0], to);
  const queue: { at: number; wrist: V3 }[] = [];
  for (let t = 0; t < 3; t += FRAME) {
    if (Math.floor(t * 30) !== Math.floor((t - FRAME) * 30)) {
      const u = Math.min(1, Math.max(0, (t - 1) / rise)), k = u * u * (3 - 2 * u);
      queue.push({ at: t + 0.09, wrist: v3(from.x + (target.x - from.x) * k, from.y + (target.y - from.y) * k, from.z + (target.z - from.z) * k) });
    }
    while (queue.length && queue[0].at <= t) takeHand(rigs[0], 'right', heldPose('right', queue.shift()!.wrist), t * 1000, filters);
    round.step(FRAME, t * 1000, true);
    if (round.flying) return t;
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

test('Space serves at once, mid-rally too', () => {
  const rigs = [newRig(0, 'right'), newRig(1, 'right')];
  const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium', botAlways: true };
  const round = new Round(rigs, play, () => 0.5);
  play.serve = true;
  round.step(FRAME, 0, true);
  assert.ok(round.flying);
  for (let i = 1; i < 20; i++) round.step(FRAME, i * 1000 * FRAME, true);
  const served = round.servedAt;
  play.serve = true;
  round.step(FRAME, 21 * 1000 * FRAME, true);
  assert.ok(round.flying && round.servedAt > served, 'served again in the same frame');
});
