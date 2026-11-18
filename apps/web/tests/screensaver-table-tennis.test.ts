import assert from 'node:assert/strict';
import test from 'node:test';
import { TABLE, stepBall, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../src/minigames/table-tennis/ball.ts';
import { botShot } from '../src/minigames/table-tennis/bot.ts';
import { TABLE_Z, newRig } from '../src/minigames/table-tennis/rig.ts';
import { Round } from '../src/minigames/table-tennis/round.ts';
import { DancerPlayer, GRIP, newPose, predictContact } from '../src/screensavers/table-tennis/dancer.ts';
import { Match, holdBlade, missShot } from '../src/screensavers/table-tennis/match.ts';
import type { Miss, Scenario } from '../src/screensavers/table-tennis/match.ts';
import { VIEW_IDS, turnForPreview, views } from '../src/screensavers/table-tennis/views.ts';
import { seeded, squareTo, unit } from '../src/screensavers/table-tennis/vec.ts';

const FRAME = 1 / 60;
const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A ball the far end sends to a player (their own frame): the bot's own shot, onto their half. */
const FROM = v3(-0.2, TABLE.top + 0.3, -1.55);
const incoming = (): Ball => ({ pos: { ...FROM }, vel: botShot(FROM, 'medium', () => 0.5), cooldown: 0 });

test('a player finds where it meets a ball coming its way, after the ball bounces once on its half', () => {
  const c = predictContact(incoming());
  assert.ok(c, 'met');
  assert.ok(c.bounce.z > 0 && c.bounce.z < TABLE.halfLength, `bounced on its half (${c.bounce.z.toFixed(2)})`);
  assert.ok(c.at.z > c.bounce.z && c.at.z > 1.2, `met past the bounce, near its end (${c.at.z.toFixed(2)})`);
  assert.ok(c.at.y > TABLE.top + 0.05 && c.at.y < TABLE.top + 0.7, `at a height it can play (${c.at.y.toFixed(2)})`);
  // The ball really is there then.
  const b = incoming();
  stepBall(b, c.t, null, null);
  assert.ok(dist(b.pos, c.at) < 0.03, 'where the ball flies');
  // Going away, into the net or long: not its ball.
  assert.equal(predictContact({ ...incoming(), vel: v3(0, 0.8, -4) }), null, 'going away');
  assert.equal(predictContact({ pos: v3(0, TABLE.top + 0.2, -1.2), vel: v3(0, -0.6, 4), cooldown: 0 }), null, 'into the net');
  assert.equal(predictContact({ pos: v3(0, TABLE.top + 0.4, -1.4), vel: v3(0, 1.5, 9), cooldown: 0 }), null, 'long');
});

test("a serve may bounce on the server's half first", () => {
  const serve: Ball = { pos: v3(0.3, TABLE.top + 0.4, -1.5), vel: v3(0, -0.5, 3.4), cooldown: 0 };
  const b = { ...serve, pos: { ...serve.pos }, vel: { ...serve.vel } };
  const first = stepBall(b, 0.4, null, null).find((e) => e.type === 'table');
  assert.ok(first && first.at.z < 0, 'the test serve bounces on the far half first');
  assert.equal(predictContact(serve, false), null, 'not as a rally shot');
  assert.ok(predictContact(serve, true), 'but as a serve');
});

test("a stand-in's blade is handed to the round exactly as it's put", () => {
  const rig = newRig(0, 'right');
  rig.tracked = true;
  const round = new Round([rig], { forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium', botAlways: false });
  const n = unit(v3(-0.2, 0.3, -1)), c = v3(0.35, 1.05, 1.4), d = squareTo(v3(0.5, 0.6, -0.2), n);
  for (let i = 0; i < 3; i++) { holdBlade(rig, { c, n, d }, i * 16); round.step(FRAME, i * 16, true); }
  const got = rig.blade!;
  assert.ok(dist({ x: got.center.x, y: got.center.y, z: got.center.z - TABLE_Z }, c) < 1e-6, 'the blade where it was put');
  assert.ok(dist(got.normal, n) < 1e-6, 'its face turned as it was put');
});

test('missed shots go into the net, wide or long, by the ball\'s own physics', () => {
  const rand = seeded(5);
  const from = v3(0.2, TABLE.top + 0.3, 1.4);
  for (const kind of ['net', 'wide', 'long'] as Miss[]) {
    for (let i = 0; i < 5; i++) {
      const vel = missShot(from, kind, rand);
      assert.ok(vel, `a ${kind} shot`);
      const b: Ball = { pos: { ...from }, vel, cooldown: 0 };
      const events = [];
      for (let t = 0; t < 3 && !events.length; t += 1 / 240) events.push(...stepBall(b, 1 / 240, null, null));
      assert.equal(events[0].type, kind === 'net' ? 'net' : 'floor', `${kind}: first hits the ${events[0].type}`);
    }
  }
});

/** A match played for `seconds`: its points, and how far the drawn paddle was from the ball at each stand-in's hit. */
function play(scenario: Scenario, seconds: number, seed = 2) {
  const match = new Match(scenario, seed);
  const gaps: number[] = [];
  let serves = 0, finite = true;
  for (let t = 0; t < seconds; t += FRAME) {
    match.step(FRAME);
    for (const e of match.events) {
      if (e.type !== 'paddle') continue;
      if (match.serving) serves += 1;
      if (e.by !== undefined) {
        const b = match.rigs[e.by].blade!.center;
        gaps.push(dist({ x: b.x, y: b.y, z: b.z - TABLE_Z }, e.at));
      }
    }
    const p = match.round.ball.pos;
    finite &&= Number.isFinite(p.x + p.y + p.z);
  }
  return { match, gaps, serves, finite };
}

for (const scenario of ['robot', 'dancers', 'robots'] as const) {
  test(`${scenario}: points are served, rallied and won by both ends, the paddles meeting the ball`, () => {
    const { match, gaps, serves, finite } = play(scenario, 240);
    assert.ok(finite, 'the ball stays somewhere');
    const { points } = match;
    assert.ok(points.length >= 12, `points played (${points.length})`);
    assert.ok(serves >= points.length, 'every point is served');
    assert.ok(points.some((p) => p.winner === 0) && points.some((p) => p.winner === 1), 'both ends win points');
    assert.ok(points.some((p) => p.shots >= 8), 'some long rallies');
    const mean = match.meanShots();
    assert.ok(mean >= 4 && mean <= 13, `rallies of several shots (${mean.toFixed(1)})`);
    assert.ok(points.some((p) => p.how === 'net') && points.some((p) => p.how === 'out'), 'points end in the net and out');
    // The ball meets the paddle that's drawn: within its blade (drawn 11 cm across the middle).
    assert.ok(gaps.length > 20);
    assert.ok(Math.max(...gaps) < 0.13, `the ball on the paddle at every hit (worst ${Math.max(...gaps).toFixed(3)} m)`);
  });
}

test('the same seed plays the same match', () => {
  const a = play('robot', 60, 9).match, b = play('robot', 60, 9).match;
  assert.deepEqual(a.points, b.points);
});

test("a dancer's feet stay planted (lifted only a little, while stepping) under it, and its hands within reach", () => {
  const match = new Match('dancers', 4);
  const pose = newPose();
  for (let t = 0; t < 90; t += FRAME) {
    match.step(FRAME);
    for (const p of match.players) {
      if (!(p instanceof DancerPlayer)) continue;
      p.pose(pose);
      for (const foot of p.feet) {
        assert.ok(foot.at.y >= 0 && foot.at.y < 0.07, 'on the floor or a small step up');
        assert.ok(Math.hypot(foot.at.x - p.bx.x, foot.at.z - p.bz.x) < 0.65, 'under the body');
        if (!foot.stepping) assert.equal(foot.at.y, 0, 'planted');
      }
      assert.ok(p.bz.x > TABLE.halfLength + 0.3, 'never in the table');
      // The paddle hand round the paddle's handle; both hands within an arm's reach of the shoulders.
      const grip = { x: p.blade.c.x - p.blade.d.x * GRIP, y: p.blade.c.y - p.blade.d.y * GRIP, z: p.blade.c.z - p.blade.d.z * GRIP };
      assert.ok(Math.hypot(grip.x - p.bx.x - 0.22 * p.side, grip.y - 1.0, grip.z - p.bz.x) < 1.0, 'the paddle hand within reach of its shoulder');
      for (const v of [...pose.body, ...pose.head, ...pose.leftHand, ...pose.rightHand, ...pose.leftFoot, ...pose.rightFoot]) assert.ok(Number.isFinite(v));
    }
  }
});

test('the views keep their cameras off the table and turn left for the preview', () => {
  const shots = views({ x: 0.2 }, false);
  for (const id of VIEW_IDS) {
    for (const t of [0, 13, 47, 120]) {
      const f = shots[id](t);
      const [x, y, z] = f.position;
      assert.ok(y > TABLE.top + 0.15 || Math.abs(x) > TABLE.halfWidth + 0.3 || Math.abs(z - TABLE_Z) > TABLE.halfLength + 0.3, `${id} at ${t}s clear of the table`);
      assert.deepEqual(turnForPreview(f, id, 0), f, 'no turn full screen');
      const turned = turnForPreview(f, id, 0.16);
      // Turned left: the target goes to the camera's left (its right is forward × up).
      const fwd = { x: f.target[0] - x, z: f.target[2] - z }, to = { x: turned.target[0] - x, z: turned.target[2] - z };
      assert.ok(fwd.x * to.z - fwd.z * to.x < 0, `${id} turns left`);
    }
  }
});
