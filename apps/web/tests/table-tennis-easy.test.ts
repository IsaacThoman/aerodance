import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, firstBounce, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../src/minigames/table-tennis/ball.ts';
import { EASY, contactOf, easyServe, easyShot, easySwing } from '../src/minigames/table-tennis/easy.ts';
import { heldPose, newHandFilters, newRig, takeHand } from '../src/minigames/table-tennis/rig.ts';
import { Round } from '../src/minigames/table-tennis/round.ts';
import type { Play } from '../src/minigames/table-tennis/round.ts';
import { botServe } from '../src/minigames/table-tennis/bot.ts';
import { holdPose, serveStrike } from '../src/minigames/table-tennis/robot.ts';

const FRAME = 1 / 60;
/** A blade moving at `vel` for `seconds`, sampled each frame (newest last), ending at `now`. */
const sweep = (vel: V3, seconds: number, now = 1) => Array.from({ length: Math.round(seconds / FRAME) }, (_, i) => ({ t: now - seconds + (i + 1) * FRAME, vel }));
const still = (seconds: number, now: number) => sweep(v3(), seconds, now);
/** A stroke at `vel` at its fastest, building up and dying away over `seconds` (a sine), ending at `now`. */
const stroke = (vel: V3, seconds: number, now = 1) => sweep(vel, seconds, now).map((s, i, all) => {
  const k = Math.sin((Math.PI * (i + 0.5)) / all.length);
  return { t: s.t, vel: v3(vel.x * k, vel.y * k, vel.z * k) };
});

test('a swing is the hand going fast and far enough towards the table, not back nor only across', () => {
  // Forward and across, as a forehand goes, over a quarter of a second, fastest in its middle.
  const forehand = [...still(0.3, 0.7), ...stroke(v3(-2, 0.4, -3.5), 0.25, 0.95), ...still(0.05, 1)];
  const swung = easySwing(forehand, 1);
  assert.ok(swung && Math.abs(swung.t - 0.825) < 0.03, `at ${swung?.t}`);
  // Back, winding up; across alone, getting there; too gentle; too short.
  assert.equal(easySwing([...sweep(v3(0.3, 0, 2.5), 0.25, 0.95), ...sweep(v3(), 0.05, 1)], 1), null);
  assert.equal(easySwing([...sweep(v3(2.5, 0, 0.1), 0.25, 0.95), ...sweep(v3(), 0.05, 1)], 1), null);
  assert.equal(easySwing([...sweep(v3(0, 0, -1.2), 0.4, 0.95), ...sweep(v3(), 0.05, 1)], 1), null);
  assert.equal(easySwing([...sweep(v3(0, 0, -3), 0.03, 0.95), ...sweep(v3(), 0.05, 1)], 1), null);
  // A smash: downwards and forwards.
  assert.ok(easySwing([...stroke(v3(0, -4, -3), 0.25, 0.95), ...still(0.05, 1)], 1));
  // Nothing from before `after` (the last one, and the arm's recovery).
  assert.equal(easySwing(forehand, 1, 0.99), null);
  // Still speeding up: not yet, whatever it's travelled; once it's past its fastest, the fastest's
  // time and speed (a 400 ms stroke, 4 m/s at its middle, seen as it goes).
  const long = stroke(v3(0, 0, -4), 0.4, 1);
  for (let n = 4; n <= long.length; n++) {
    const seen = long.slice(0, n), now = seen.at(-1)!.t, got = easySwing(seen, now);
    if (n <= long.length / 2) assert.equal(got, null, `${n} samples in: still accelerating`);
    else if (got) { assert.ok(Math.abs(got.t - 0.8) < 0.02, `peak at ${got.t.toFixed(3)}`); assert.ok(Math.hypot(got.vel.x, got.vel.y, got.vel.z) > 3.9); }
  }
  assert.ok(easySwing(long, 1), 'once it has slowed, it counts');
});

test('the ball is met as it crosses the hitting line after its bounce on the near half; one going long is let go', () => {
  const from = serveStrike(holdPose(0).pos);
  const serve = botServe(from, 'medium', () => 0.5)!;
  const ball: Ball = { pos: { ...from }, vel: { ...serve.vel }, cooldown: 0 };
  const c = contactOf(ball, false);
  assert.ok(c, 'met');
  assert.ok(Math.abs(c.at.z - EASY.hitZ) < 0.05 && c.at.y > TABLE.top && c.t > 0.5);
  // A shot flying over the near end without touching the table.
  const long: Ball = { pos: v3(0, 1.2, -1), vel: v3(0, 1.5, 7), cooldown: 0 };
  assert.equal(contactOf(long, false), null);
  // Going the other way.
  assert.equal(contactOf({ ...ball, vel: v3(0, 0, -3) }, true), null);
});

test('timing sets the angle: early pulls it across, late pushes it the other way; the harder the swing, the faster', () => {
  const from = v3(0.1, TABLE.top + 0.25, EASY.hitZ), swing = v3(0, 0.2, -4);
  // (A random source whose normal draws are all 0: no stray.)
  const zero = () => 0.25;
  const landing = (vel: V3) => firstBounce({ pos: { ...from }, vel, cooldown: 0 })!;
  const early = landing(easyShot(from, swing, -1, 'right', zero).vel), late = landing(easyShot(from, swing, 1, 'right', zero).vel), on = landing(easyShot(from, swing, 0, 'right', zero).vel);
  assert.ok(early.at.x < on.at.x - 0.3 && late.at.x > on.at.x + 0.3, `early ${early.at.x.toFixed(2)}, on ${on.at.x.toFixed(2)}, late ${late.at.x.toFixed(2)}`);
  for (const l of [early, late, on]) assert.ok(Math.abs(l.at.x) < TABLE.halfWidth && l.at.z < 0 && l.at.z > -TABLE.halfLength, 'on the far half');
  // Left-handed, the other way round.
  assert.ok(landing(easyShot(from, swing, -1, 'left', zero).vel).at.x > on.at.x + 0.3);
  // Harder, sooner.
  const gentle = landing(easyShot(from, v3(0, 0, -2), 0, 'right', zero).vel), hard = landing(easyShot(from, v3(0, 0, -6), 0, 'right', zero).vel);
  assert.ok(hard.t < gentle.t - 0.2, `hard ${hard.t.toFixed(2)} s, gentle ${gentle.t.toFixed(2)} s`);
  // A high ball met swinging hard downwards is a smash, and quick.
  const high = v3(0, TABLE.top + 0.5, EASY.hitZ);
  const smash = easyShot(high, v3(0, -3.5, -3), 0, 'right', zero);
  assert.ok(smash.smash);
  assert.ok(firstBounce({ pos: { ...high }, vel: smash.vel, cooldown: 0 })!.t < 0.45);
  assert.ok(!easyShot(from, v3(0, -3.5, -3), 0, 'right', zero).smash, 'not off a low ball');
});

test('off-centre timing and power make shots stray, sometimes off the table; dead-on gentle ones nearly always land', () => {
  let seed = 3;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const from = v3(0, TABLE.top + 0.25, EASY.hitZ);
  const lands = (u: number, speed: number) => {
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const b = firstBounce({ pos: { ...from }, vel: easyShot(from, v3(0, 0, -speed), u, 'right', rand).vel, cooldown: 0 });
      if (b && b.at.z < 0 && Math.abs(b.at.x) < TABLE.halfWidth) n += 1;
    }
    return n / 200;
  };
  const best = lands(0, 2.5), worst = lands(1, 6);
  assert.ok(best > 0.95, `dead on and gentle: ${best}`);
  assert.ok(worst < best - 0.1, `late and hard: ${worst}`);
  // A serve goes over onto the far half.
  const served = firstBounce({ pos: v3(0.3, TABLE.top + 0.4, TABLE.halfLength - 0.1), vel: easyServe(v3(0.3, TABLE.top + 0.4, TABLE.halfLength - 0.1), v3(-0.5, 0.3, -3), () => 0.5), cooldown: 0 })!;
  assert.ok(served.at.z < 0 && Math.abs(served.at.x) < TABLE.halfWidth);
});

// (The hand's fed in at once, with no camera; the drawn hand's easing still shows a swing's fastest
// moment a few hundredths late, which the hit timing allows for as it would a camera's delay.)
const PLAY: Play = { mode: 'match', controls: 'easy', forgiving: false, serve: false, timeScale: 1, hitLag: 0.06, assist: 'normal', botLevel: 'medium' };

/**
 * Alone, the robot serving: a paddle hand held far off to the side, still, that swings forward
 * (wherever it is) `offset` seconds from when the serve reaches the player's hitting line. How
 * the swing went (the round's call).
 */
function swingAtServe(offset: number) {
  const rig = newRig(0, 'right');
  rig.tracked = true;
  const round = new Round([rig], { ...PLAY }, () => 0.5);
  round.match.first = 1;
  const filters = newHandFilters();
  const wrist = v3(-0.45, -0.25, -0.3);
  let reach: number | null = null, swingFrom: number | null = null;
  for (let t = 0; t < 4; t += FRAME) {
    // Where the swing should peak: the serve's arrival, once it's known.
    if (reach === null && round.flying && round.shot?.by === 1) {
      const c = contactOf(round.ball, round.bouncedOn === 0);
      if (c) { reach = t + c.t; swingFrom = reach + offset - 0.12; }
    }
    // The hand: still, then a quarter-second swing forward (across the body), fastest in its middle.
    const u = swingFrom === null ? 0 : Math.min(1, Math.max(0, (t - swingFrom) / 0.24)), k = u * u * (3 - 2 * u);
    takeHand(rig, 'right', heldPose('right', v3(wrist.x - 0.25 * k, wrist.y + 0.1 * k, wrist.z - 0.55 * k)), t * 1000, filters);
    takeHand(rig, 'left', heldPose('left', v3(-0.05, -0.4, -0.1)), t * 1000, filters);
    round.step(FRAME, t * 1000, true);
    if (round.swingCall) return round.swingCall.kind;
  }
  return null;
}

test('Easy: a swing timed to the ball hits it wherever the hand is; well early or late, it is a whiff', () => {
  assert.equal(swingAtServe(0), 'hit');
  assert.equal(swingAtServe(-0.08), 'hit');
  assert.equal(swingAtServe(0.08), 'hit');
  assert.equal(swingAtServe(-0.4), 'early');
  assert.equal(swingAtServe(0.25), 'late');
});
