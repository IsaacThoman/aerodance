import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIST, PACE, SERVE_SWING, SWING, assistReturn, interceptNudge, landsFar, reachesFarEnd, serveHit, strongestSwing, swingHit } from '../src/minigames/table-tennis/assist.ts';
import { TABLE, stepBall, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { Ball, BallEvent, V3 } from '../src/minigames/table-tennis/ball.ts';

const ball = (pos: V3, vel: V3): Ball => ({ pos, vel, cooldown: 0 });
const still = v3();

/** Where a ball off the paddle first comes down (on the table, the floor, or caught in the net). */
function landing(from: V3, vel: V3): BallEvent {
  const events: BallEvent[] = [];
  const b = ball({ ...from }, { ...vel });
  for (let i = 0; i < 300 && !events.length; i++) stepBall(b, 1 / 60, null, null, events);
  return events[0];
}
/** How far a point is from the far half of the table (0 on it). */
const offFarHalf = (p: V3) => Math.hypot(Math.max(0, Math.abs(p.x) - TABLE.halfWidth), Math.max(0, p.z, -p.z - TABLE.halfLength));

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

test("with two players, the hardest shot still leaves the other time to get to it", () => {
  const from = v3(0.25, 1.06, 1.45);
  // Off a real arm's swing: the ball at 6 to 14 m/s, flat, long, or already a good return.
  for (const hard of [v3(0, 1.5, -6), v3(-1, 0.5, -9), v3(1.5, 3, -11), v3(0.4, -1, -14), v3(0.2, 2.2, -6.5)]) {
    const unpaced = assistReturn(from, hard, 1);
    assert.ok(reachesFarEnd(from, unpaced) < 0.6, `unpaced, it's there in ${reachesFarEnd(from, unpaced).toFixed(2)} s`);
    const paced = assistReturn(from, hard, 1, PACE.rally);
    assert.ok(landsFar(from, paced), 'it lands');
    const reach = reachesFarEnd(from, paced);
    assert.ok(reach >= PACE.rally.least && reach < PACE.rally.gentle + 0.1, `paced, in ${reach.toFixed(2)} s`);
    assert.ok(Math.sign(paced.x) === Math.sign(hard.x) || Math.abs(hard.x) < 0.5, 'still the way it was hit');
    // Not lobbed out of sight: its top no higher than the robot's easy shots go.
    let top = 0;
    const b = ball({ ...from }, { ...paced });
    for (let i = 0; i < 120; i++) { stepBall(b, 1 / 120, null, null); top = Math.max(top, b.pos.y - TABLE.top); }
    assert.ok(top < 1, `its top ${top.toFixed(2)} m over the table`);
    // And it comes up to the other player's hand, not at the table's edge.
    const bounce = landing(from, paced).at;
    assert.ok(bounce.z <= -PACE.near + 0.05 && bounce.z >= -PACE.far - 0.05, `bounces ${(-bounce.z).toFixed(2)} m past the net`);
  }
  // A gentle shot takes longer than a hard one, and a serve longer than either.
  const gentle = reachesFarEnd(from, assistReturn(from, v3(0, 1.5, -2.6), 1, PACE.rally));
  const hard = reachesFarEnd(from, assistReturn(from, v3(0, 1.5, -9), 1, PACE.rally));
  assert.ok(gentle > hard + 0.08, `gentle ${gentle.toFixed(2)} s, hard ${hard.toFixed(2)} s`);
  assert.ok(reachesFarEnd(from, assistReturn(from, v3(0, 1.5, -9), 1, PACE.serve)) >= PACE.serve.least);
  // With the assist off a shot that misses goes where it was hit, only no faster than a paced one.
  const raw = v3(0.3, 2.5, -10), off = assistReturn(from, raw, 0, PACE.rally);
  const speed = (v: V3) => Math.hypot(v.x, v.y, v.z);
  assert.ok(!landsFar(from, off) && speed(off) < 6 && Math.abs(off.x / off.z - raw.x / raw.z) < 1e-9 && Math.abs(off.y / off.z - raw.y / raw.z) < 1e-9, `the same way, at ${speed(off).toFixed(1)} m/s`);
  // At any level, though, a shot that lands keeps to the pace: a part bent and a part left as hit don't make a quicker one.
  for (const share of [0, ASSIST.normal.block, ASSIST.low.landing, 0.8]) {
    for (const hit of [v3(0, 1.5, -9), v3(0.3, 4, -9), v3(-1, 3, -7), v3(1.5, 3, -11)]) {
      const shot = assistReturn(from, hit, share, PACE.rally);
      if (landsFar(from, shot)) assert.ok(reachesFarEnd(from, shot) >= PACE.rally.least, `bent ${share} of the way, there in ${reachesFarEnd(from, shot).toFixed(2)} s`);
    }
  }
  assert.ok(landsFar(from, assistReturn(from, v3(0, 1.5, -9), ASSIST.low.landing, PACE.rally)), "Low's still lands");
  // Alone (no pace) nothing changes: a return that lands is left as it was.
  const good = v3(0.2, 2.2, -4);
  assert.ok(landsFar(v3(0, 0.95, 1.4), good) && reachesFarEnd(v3(0, 0.95, 1.4), good) < PACE.rally.least);
  assert.deepEqual(assistReturn(v3(0, 0.95, 1.4), good, 1), good);
  assert.notDeepEqual(assistReturn(v3(0, 0.95, 1.4), good, 1, PACE.rally), good);
});

test('a forward swing that passes the ball within the zone hits it, and the return lands', () => {
  // The ball coming in; the blade 15 cm off to the side of it and 20 cm short of it in depth (and
  // edge-on: its face doesn't matter), the player having just swung forward and across at 3 m/s.
  const swing = v3(-1.2, 0.3, -2.7);
  const centre = v3(0.15, 1.05, 1.5);
  const coming = ball(v3(0, 1, 1.6), v3(0, 0, 5));
  // Not yet at its nearest: wait.
  assert.equal(swingHit(ball(v3(0, 1, 1.15), v3(0, 0, 5)), centre, swing, swing, 1, ASSIST.normal), null);
  const vel = swingHit(coming, centre, swing, swing, 1, ASSIST.normal);
  assert.ok(vel, 'it hits');
  assert.ok(vel.z < -1 && vel.x < 0, `down the table, the way the swing went (${vel.x.toFixed(1)}, ${vel.y.toFixed(1)}, ${vel.z.toFixed(1)})`);
  assert.ok(landsFar(coming.pos, assistReturn(coming.pos, vel, ASSIST.normal.landing)), 'and the assist lands it');
});

test('the zone is tight across and up, where the camera sees well, and deep along the table, where it does not', () => {
  const swing = v3(0, 0, -3), centre = v3(0, 1.05, 1.3);
  const at = (x: number, y: number, z: number) => swingHit(ball(v3(x, y, z), v3(0, 0, 0.01)), centre, still, swing, 1, ASSIST.normal);
  assert.ok(at(0, 1.05, 1.3 + 0.4), '40 cm off in depth is met');
  assert.equal(at(0.4, 1.05, 1.3), null, '40 cm off to the side is not');
  assert.equal(at(0, 1.45, 1.3), null, 'nor 40 cm above');
  assert.ok(at(0.2, 1.05, 1.3), '20 cm to the side is');
  // Each level reaches further than the last, and none plays a ball a body's width away.
  for (const [low, high] of [['low', 'normal'], ['normal', 'high']] as const) {
    assert.ok(ASSIST[low].across < ASSIST[high].across && ASSIST[low].depth < ASSIST[high].depth);
    assert.ok(ASSIST[high].depth > ASSIST[high].across);
  }
  assert.ok(ASSIST.high.across < 0.4);
});

test('no swing, a pull back, a ball well away or the assist off is no hit', () => {
  const centre = v3(0.1, 1.05, 1.3);
  const coming = ball(v3(0, 1, 1.25), v3(0, 0, 5));
  assert.equal(swingHit(coming, centre, still, v3(0, 0, -0.3), 1, ASSIST.high), null, 'too slow to be a swing');
  assert.equal(swingHit(coming, centre, still, still, 1, ASSIST.high), null, 'a paddle held still is helped to nothing');
  assert.equal(swingHit(ball(v3(0.7, 1, 1.25), v3(0, 0, 5)), centre, still, v3(0, 0, -3), 1, ASSIST.high), null, 'beyond the zone');
  assert.equal(swingHit(ball(v3(0, 1, 1.25), v3(0, 0, -5)), centre, still, v3(0, 0, -3), 1, ASSIST.high), null, 'a ball going away');
  assert.equal(swingHit(coming, centre, still, v3(0, 0, -3), 1, ASSIST.off), null, 'the assist off');
});

/** The blade's speeds through a move at `vel` for `seconds`, a sample every 60th of a second, ending at `end`. */
const moving = (vel: V3, seconds: number, end: number) => { const n = Math.round(seconds * 60); return Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) / 60, vel })); };

test('a swing is a fast move of some length the same way, not a wind-up or a twitch', () => {
  // A forward swing of 0.15 s at 3 m/s after a wind-up back at 4 m/s.
  const speeds = [...moving(v3(0, 0, 4), 0.1, 0.85), ...moving(v3(0, 0.5, -3), 0.15, 1)];
  assert.deepEqual(strongestSwing(speeds, 1.02), v3(0, 0.5, -3), 'the forward swing, not the wind-up');
  assert.deepEqual(strongestSwing(speeds, 1.5), still, 'not long after it');
  // One fast frame among still ones went nowhere: a twitch of the tracking.
  const twitch = [...moving(still, 0.2, 0.95), { t: 0.967, vel: v3(0, 0, -4) }, ...moving(still, 0.03, 1)];
  assert.deepEqual(strongestSwing(twitch, 1.02), still);
  // A slow drift isn't one either.
  assert.deepEqual(strongestSwing(moving(v3(0, 0, -0.6), 0.4, 1), 1.02), still);
  // A serve's swing has to go further than a rally's.
  const short = moving(v3(0, 0, -2), 0.1, 1);
  assert.deepEqual(strongestSwing(short, 1.02), v3(0, 0, -2));
  assert.deepEqual(strongestSwing(short, 1.02, SERVE_SWING.travel), still);
  assert.ok(SWING.travel < SERVE_SWING.travel);
});

test('the swinging blade reaches for the ball it will meet, and a still one does not', () => {
  // The ball 15 cm to the side of where the blade is heading: the blade is sent there.
  const coming = ball(v3(0.15, 1, 0.9), v3(0, 0.5, 5));
  const swing = v3(0, 0, -2);
  const nudge = interceptNudge(coming, v3(0, 1, 1.4), swing, swing, 1, ASSIST.normal);
  assert.ok(nudge, 'it reaches');
  assert.ok(nudge.x > 0.1, `across (${nudge.x.toFixed(2)})`);
  assert.equal(interceptNudge(coming, v3(0, 1, 1.4), still, still, 1, ASSIST.normal), null, 'not without a swing');
  assert.equal(interceptNudge(coming, v3(0, 1, 1.4), swing, swing, 1, ASSIST.off), null, 'not with the assist off');
  assert.equal(interceptNudge(ball(v3(0.6, 1, 0.9), v3(0, 0.5, 5)), v3(0, 1, 1.4), swing, swing, 1, ASSIST.normal), null, 'not for a ball passing outside the zone');
});

test('the waiting ball is served by a firm swing that goes past it, down the table', () => {
  const waiting = v3(0.3, 1.12, 1.27);
  const swing = v3(-0.8, 0.4, -2.4);
  // The blade 10 cm from it, having passed it.
  const vel = serveHit(waiting, v3(0.26, 1.14, 1.2), swing, ASSIST.normal);
  assert.ok(vel && vel.z <= -2.5, 'served down the table');
  assert.ok(landsFar(waiting, assistReturn(waiting, vel, 1)), 'and it lands');
  assert.equal(serveHit(waiting, v3(0.26, 1.14, 1.2), v3(0, 0, -0.9), ASSIST.normal), null, 'a gentle move is no serve');
  assert.equal(serveHit(waiting, v3(0.26, 1.14, 1.2), still, ASSIST.normal), null, 'nor a paddle resting by it');
  assert.equal(serveHit(waiting, v3(-0.3, 1.14, 1.2), swing, ASSIST.normal), null, 'nor a swing nowhere near it');
  // Still on its way to the ball, or stopped short of it (a paddle raised to get ready): no serve.
  assert.equal(serveHit(waiting, v3(0.3, 1.1, 1.6), swing, ASSIST.normal), null);
  assert.equal(serveHit(waiting, v3(0.25, 1.24, 1.37), v3(0.2, 0.8, -1.8), ASSIST.normal), null, 'brought up behind it');
  // Right on it counts, passed or not.
  assert.ok(serveHit(waiting, v3(0.31, 1.11, 1.3), swing, ASSIST.normal));
  assert.ok(serveHit(waiting, v3(0.28, 1.13, 1.22), swing, ASSIST.off), 'the serve works with the assist off, close to');
});
