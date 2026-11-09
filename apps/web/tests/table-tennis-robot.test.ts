import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { forward, makePose, solve } from '../../../packages/robots/arms/sixaxis/kinematics.ts';
import { makeTarget } from '../../../packages/robots/shared/rally.ts';
import { NET, TABLE, firstBounce, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { V3 } from '../src/minigames/table-tennis/ball.ts';
import { BOT, BOT_LEVELS, botServe, botTarget, reachRoom, reaches } from '../src/minigames/table-tennis/bot.ts';
import {
  GAP, STROKE, carriageFor, faceNormal, heading, holdPose, onPaddle, planServe, serveBall, servePose, serveStrike, strokeOffset, toStation,
} from '../src/minigames/table-tennis/robot.ts';
import type { ArmPose } from '../src/minigames/table-tennis/robot.ts';

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

// How far the arm's paddle ends up from a pose (table frame), solved as RobotOpponent poses it.
const target = makeTarget(), pose = makePose(), m = new THREE.Matrix4(), got = new THREE.Vector3();
const joints = { j2: new THREE.Vector3(), j3: new THREE.Vector3(), wrist: new THREE.Vector3(), flange: new THREE.Vector3() };
function miss(arm: ArmPose): number {
  const p = toStation(arm.pos), n = toStation(arm.normal, false);
  target.position.set(p.x, p.y, p.z);
  target.normal.set(n.x, n.y, n.z).normalize();
  solve(target, carriageFor(p.z), pose);
  return got.setFromMatrixPosition(forward(pose, m, joints)).distanceTo(target.position);
}
// How near a ball (table frame) comes to the arm's links' middles, as last solved (upper arm, forearm, wrist).
function clearance(ball: V3): number {
  const at = toStation(ball);
  const p = new THREE.Vector3(at.x, at.y, at.z);
  const segment = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Line3(a, b).closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
  return Math.min(segment(joints.j2, joints.j3), segment(joints.j3, joints.wrist), segment(joints.wrist, joints.flange));
}

test('the arm puts its paddle anywhere the bot reaches, facing any shot, through its whole stroke', () => {
  let checked = 0;
  for (let x = -2.6; x <= 2.6; x += 0.1) {
    for (let y = 0.6; y <= 2.6; y += 0.1) {
      for (let z = -3.4; z <= -0.9; z += 0.1) {
        const at = v3(x, y, z);
        if (!reaches(at)) continue;
        for (const aim of [v3(-0.6, 0, 0.5), v3(0.6, 0, 1.1), v3(0, 0, 0.8)]) {
          for (const tilt of [-0.2, 0.22, 0.35]) {
            const dir = heading(at, aim);
            const normal = faceNormal(dir, tilt);
            // The paddle's middle a ball's width behind it, and drawn back or followed through for the stroke, on either side.
            for (const [until, since] of [[null, 5], [STROKE.swing, 5], [null, STROKE.follow / 2]] as const) {
              for (const fore of [true, false]) {
                const o = strokeOffset(until, since, dir, fore, reachRoom(at));
                const d = miss({ pos: v3(at.x - normal.x * GAP + o.x, at.y - normal.y * GAP + o.y, at.z - normal.z * GAP + o.z), normal });
                assert.ok(d < 0.02, `(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) aiming ${aim.x}, ${aim.z} at ${tilt}, ${until} ${since} ${fore}: ${(d * 100).toFixed(1)} cm off`);
                checked++;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 10000, `${checked} poses`);
  assert.ok(reaches(BOT.home) && reaches(v3(1.5, TABLE.top + 0.3, BOT.line)) && reaches(v3(-1.5, TABLE.top + 0.3, BOT.line)), 'it covers the table and more');
  assert.ok(!reaches(v3(0, TABLE.top + 0.2, -0.5)), 'not out over the table');
});

test("the bot's serves bounce on its own half, clear the net and land on the player's, at every level", () => {
  const from = serveStrike(holdPose(0).pos);
  for (const level of BOT_LEVELS) {
    for (let i = 0; i < 6; i++) {
      const serve = botServe(from, level, rand);
      assert.ok(serve, `${level}: a serve`);
      assert.ok(serve.first.z < -0.1 && serve.first.z > -TABLE.halfLength && Math.abs(serve.first.x) < TABLE.halfWidth, `${level}: first bounce ${serve.first.x.toFixed(2)}, ${serve.first.z.toFixed(2)}`);
      assert.ok(serve.second.z > 0.2 && serve.second.z < TABLE.halfLength && Math.abs(serve.second.x) < TABLE.halfWidth, `${level}: second bounce ${serve.second.x.toFixed(2)}, ${serve.second.z.toFixed(2)}`);
      const first = firstBounce({ pos: { ...from }, vel: serve.vel, cooldown: 0 });
      assert.ok(first && first.at.z < 0, 'its own half first');
      assert.ok(Math.abs(serve.second.x) < NET.halfWidth);
    }
  }
});

test('the serve: the ball on the paddle, let go at the top of the flick, struck by the paddle where it falls back to', () => {
  const hold = holdPose(0);
  const from = serveStrike(hold.pos);
  const flight = botServe(from, 'medium', rand);
  assert.ok(flight);
  const dir = heading(from, flight.second);
  const serve = planServe(10, hold.pos, dir, faceNormal(dir, 0.1));
  // Held, then tossed straight up and back down, a little above where it was let go.
  const held = serveBall(serve, 10, servePose(serve, 10));
  assert.ok(held && Math.abs(held.y - onPaddle(hold).y) < 1e-6);
  assert.ok(serve.strikeAt - serve.release > 0.3 && serve.strikeAt - serve.release < 0.5, `in the air ${(serve.strikeAt - serve.release).toFixed(2)} s`);
  const top = serveBall(serve, serve.release + 0.2, servePose(serve, serve.release + 0.2));
  assert.ok(top && top.y > serve.from.y + 0.15, 'up in the air');
  assert.equal(serveBall(serve, serve.strikeAt, servePose(serve, serve.strikeAt)), null, 'struck');
  // At the strike, the paddle's face is on the ball.
  const at = servePose(serve, serve.strikeAt);
  const ball = onPaddle(at);
  assert.ok(Math.hypot(ball.x - serve.strike.x, ball.y - serve.strike.y, ball.z - serve.strike.z) < 0.005);
  // The paddle moves smoothly (no jumps), clear of the ball while it's up, and the arm keeps it on its target.
  let last: ArmPose | null = null;
  for (let t = serve.start; t <= serve.end; t += 1 / 120) {
    const p = servePose(serve, t);
    if (last) assert.ok(Math.hypot(p.pos.x - last.pos.x, p.pos.y - last.pos.y, p.pos.z - last.pos.z) < 4.5 / 120, `a jump at ${(t - serve.start).toFixed(3)} s`);
    assert.ok(miss(p) < 0.02, `the arm ${(miss(p) * 100).toFixed(1)} cm off at ${(t - serve.start).toFixed(3)} s`);
    const up = serveBall(serve, t, p);
    if (up && t > serve.release + 0.02) {
      const gap = Math.hypot(up.x - p.pos.x, up.y - p.pos.y, up.z - p.pos.z);
      assert.ok(gap > GAP, `the paddle in the ball at ${(t - serve.start).toFixed(3)} s`);
      // Its links (about 10 cm round their middles) stay clear of the tossed ball.
      assert.ok(clearance(up) > 0.15, `the arm ${(clearance(up) * 100).toFixed(0)} cm from the ball at ${(t - serve.start).toFixed(3)} s`);
    }
    last = p;
  }
});

test("the rally's stroke: drawn back as the ball comes, at the ball on the strike, followed through, and smooth", () => {
  const dir = heading(v3(), botTarget('medium', rand));
  const at = (until: number | null, since: number): V3 => strokeOffset(until, since, dir);
  const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
  assert.ok(len(at(null, 5)) < 1e-9, 'still between strokes');
  assert.ok(len(at(0, 0)) < 1e-9, 'on the ball as it strikes');
  assert.ok(at(0.3, 5).z * dir.z < 0, 'drawn back');
  assert.ok(at(null, 0.16).z * dir.z > 0, 'followed through');
  for (let t = 1; t > 0; t -= 1 / 240) assert.ok(len({ x: at(t, 5).x - at(t + 1 / 240, 5).x, y: at(t, 5).y - at(t + 1 / 240, 5).y, z: at(t, 5).z - at(t + 1 / 240, 5).z }) < 3 / 240);
});
