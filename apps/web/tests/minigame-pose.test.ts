import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Puppet, REALISM } from '../src/pose/puppet/Puppet.ts';
import type { PuppetRealism } from '../src/pose/puppet/Puppet.ts';
import { PlayerTracker } from '../../../packages/pose/browser/tracker.ts';
import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';
import { WebcamCalibration } from '../src/game/webcamCalibration.ts';
import { JOINT, OneEuro, createPoseFollower } from '../src/minigames/pose/body.ts';
import type { PoseFollower } from '../src/minigames/pose/body.ts';
import {
  armAngle, armReach, createGestureSet, crouchDepth, elbowBend, handAt, handRaised, handsApart, jumpHeight, lean,
} from '../src/minigames/pose/gestures.ts';
import type { GestureEvent } from '../src/minigames/pose/gestures.ts';

const near = (a: number, b: number, tolerance: number, what = '') => assert.ok(Math.abs(a - b) <= tolerance, `${what} ${a.toFixed(3)} is not within ${tolerance} of ${b}`);
const INPUT = { width: 640, height: 480, mirrored: false };

/**
 * The camera pipeline without a browser: the puppet's frames through the player tracker into
 * records, the webcam calibration's stillness hold, then each player's pose follower and
 * gestures, as MinigameSession runs them. Frames are captured every frameMs, show the puppets
 * captureMs earlier and arrive inferenceMs later.
 */
function rig(playerCount: PlayerCount, realism: PuppetRealism = REALISM.real, seed = 5) {
  const clock = { t: 10000 };
  const puppet = new Puppet({ now: () => clock.t, realism, seed });
  puppet.follow(playerCount);
  const tracker = new PlayerTracker(playerCount);
  const calibration = new WebcamCalibration(playerCount);
  const followers: PoseFollower[] = Array.from({ length: playerCount }, (_, id) => createPoseFollower(id));
  const gestures = followers.map(() => createGestureSet());
  const events: GestureEvent[] = [];
  let seq = 0, last: Pose[] = [];
  const frameMs = realism.inferenceMs + 2;
  /** Runs the camera for ms. */
  const run = (ms: number) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t += frameMs;
      const captured = clock.t;
      const found = puppet.detect(captured - puppet.realism.captureMs);
      last = tracker.update(found.landmarks, INPUT, captured, found.looks);
      const record = { sessionId: 'puppet', seq: ++seq, input: INPUT, poses: last };
      const arrived = captured + realism.inferenceMs;
      if (calibration.accept(record, captured, arrived)) calibration.tracks?.forEach((track, id) => { if (followers[id].calibration !== track) followers[id].setCalibration(track); });
      for (const pose of last) {
        followers[pose.playerId].push(pose.landmarks, INPUT, captured);
        events.push(...gestures[pose.playerId].update(followers[pose.playerId].pose));
      }
      followers.forEach((f) => f.update(arrived));
    }
  };
  return { clock, puppet, tracker, calibration, followers, events, run, poses: (id: number) => followers[id].pose, last: () => last };
}
const kinds = (events: readonly GestureEvent[]) => events.map((e) => `${e.player}:${e.type}${e.direction ? `:${e.direction}` : ''}${e.hand ? `:${e.hand}` : ''}`);

test('two puppets are numbered left to right, hold still through calibration and come out in body space', () => {
  const r = rig(2);
  r.run(3200);
  assert.equal(r.calibration.status(r.clock.t).complete, true, 'calibrated after holding still');
  assert.ok(r.followers.every((f) => f.pose.calibrated && f.pose.present));
  // Puppet 0 stands on the left of the mirror: player 1.
  assert.ok(r.poses(0).screen[JOINT.nose].x < 0.5 && r.poses(1).screen[JOINT.nose].x > 0.5);
  // Standing: hands by the sides, a torso length apart from the hips to the shoulders.
  const p = r.poses(0);
  near(p.body[JOINT.rightShoulder].y, 1, 0.08, 'shoulder height');
  near(handAt(p, 'right').x, 0.5, 0.1, 'right hand out');
  near(handAt(p, 'left').x, -0.5, 0.1, 'left hand out');
  near(p.offset.x, 0, 0.05, 'standing where calibrated');
  // From the frame the browser saw to the pose arriving: tracking's time. (The camera's own delay
  // before the browser sees a frame can't be measured; the puppet's captureMs is on top of this.)
  near(p.ageMs, REALISM.real.inferenceMs, 1, 'pose age');
});

test('measures read the pose the puppet holds: arms, elbows, lean, crouch, jumps, raised hands', () => {
  const r = rig(1);
  r.run(3000);
  r.puppet.pose(0, 'tpose', { ms: 200 });
  r.run(800);
  const p = r.poses(0);
  near(armAngle(p, 'right'), 90, 8, 'T arm angle');
  near(armAngle(p, 'left'), 90, 8, 'T left arm angle');
  near(elbowBend(p, 'right'), 0, 15, 'straight elbow');
  near(armReach(p, 'right'), 1, 0.08, 'full reach');
  near(handAt(p, 'right').y, 1, 0.08, 'wrist at shoulder height');
  r.puppet.pose(0, 'armsUp', { ms: 200 });
  r.run(800);
  assert.ok(handRaised(p, 'left') && handRaised(p, 'right'));
  near(armAngle(p, 'right'), 175, 15, 'arm up');
  r.puppet.pose(0, 'leanRight', { ms: 200 });
  r.run(800);
  near(lean(p), 22, 5, 'lean');
  assert.equal(handRaised(p, 'right'), false);
  r.puppet.pose(0, 'crouch', { ms: 300 });
  r.run(900);
  assert.ok(crouchDepth(p) > 0.7, `crouch ${crouchDepth(p)}`);
  r.puppet.set(0, { crouch: 0, lift: 0.5 });
  r.run(400);
  near(jumpHeight(p), 0.5, 0.06, 'off the ground');
  r.puppet.pose(0, 'clap', { ms: 200 });
  r.run(600);
  assert.ok(handsApart(p) < 0.2);
  // Stepping across the picture moves the offset, not the body.
  r.puppet.pose(0, 'stand', { ms: 0 });
  r.puppet.move(0, 0.7, { ms: 300 });
  r.run(900);
  assert.ok(p.offset.x > 0.5, `stepped right ${p.offset.x}`);
  near(handAt(p, 'right').x, 0.5, 0.1, 'hands where they were on the body');
});

test('gestures fire once each from the puppet\'s moves, through a realistic camera', () => {
  const r = rig(1);
  r.run(3000);
  const after = (from: number) => kinds(r.events.slice(from));
  // [what, move, the events it makes, whether those are all]: a jump's arms swing up and down
  // fast enough to be swipes, and so does the test's own quick raise.
  const cases: [string, () => void, string[], boolean][] = [
    ['swipe left', () => r.puppet.gesture(0, 'swipeLeft'), ['0:swipe:left:right'], true],
    ['swipe right with the left hand', () => r.puppet.gesture(0, 'swipeRight', { side: 'left' }), ['0:swipe:right:left'], true],
    ['swipe up', () => r.puppet.gesture(0, 'swipeUp'), ['0:swipe:up:right', '0:raise:right'], true],
    ['jump', () => r.puppet.gesture(0, 'jump'), ['0:jump', '0:land'], false],
    ['clap', () => r.puppet.gesture(0, 'clap'), ['0:clap'], true],
    ['punch', () => r.puppet.gesture(0, 'punch', { side: 'left' }), ['0:punch:forward:left'], true],
    ['squat', () => r.puppet.gesture(0, 'squat'), ['0:crouch', '0:rise'], true],
    ['raise', () => { r.puppet.pose(0, 'rightUp', { ms: 200 }); r.run(1000); r.puppet.pose(0, 'stand'); }, ['0:raise:right'], false],
  ];
  for (const [what, move, want, exact] of cases) {
    const from = r.events.length;
    move();
    r.run(2200);
    const got = after(from);
    if (exact) { assert.deepEqual(got, want, what); continue; }
    let at = 0;
    for (const w of want) {
      const i = got.indexOf(w, at);
      assert.ok(i >= 0, `${what}: expected ${want.join(', ')}, got ${got.join(', ') || 'nothing'}`);
      at = i + 1;
    }
    assert.equal(got.filter((g) => g === want[0]).length, 1, `${what} fired once: ${got.join(', ')}`);
  }
});

test('a swipe straight from a T-pose is a swipe, not a punch', () => {
  const r = rig(2);
  r.run(3000);
  r.puppet.pose('all', 'tpose', { ms: 300 });
  r.run(1500);
  const from = r.events.length;
  r.puppet.gesture(1, 'swipeLeft');
  r.run(2500);
  assert.deepEqual(kinds(r.events.slice(from)), ['1:swipe:left:right']);
});

test('standing still, or swaying on a rough camera, fires nothing', () => {
  for (const realism of [REALISM.real, REALISM.rough]) {
    const r = rig(2, realism, 9);
    r.run(3000);
    const from = r.events.length;
    r.puppet.play('all', [{ patch: { lean: 6, x: 0.27 }, ms: 900 }, { patch: { lean: -6, x: 0.23 }, ms: 900 }], { loop: true });
    r.run(8000);
    assert.deepEqual(kinds(r.events.slice(from)), [], `no gestures with ${JSON.stringify(realism)}`);
  }
});

test('four puppets keep their numbers while one leaves and comes back', () => {
  const r = rig(4);
  r.run(3200);
  assert.equal(r.calibration.status(r.clock.t).complete, true);
  const spot = (id: number) => r.poses(id).screen[JOINT.leftHip].x;
  assert.ok(spot(0) < spot(1) && spot(1) < spot(2) && spot(2) < spot(3), 'P1 to P4 left to right');
  r.puppet.leave(2);
  r.run(1000);
  assert.equal(r.poses(2).present, false);
  assert.ok([0, 1, 3].every((id) => r.poses(id).present));
  r.puppet.enter(2);
  r.run(2500);
  assert.equal(r.poses(2).present, true);
  near(spot(2), 0.625, 0.08, 'player 3 back in their place');
});

test('the One Euro filter steadies a still point and keeps up with a fast one', () => {
  const f = new OneEuro({ minCutoff: 1.4, beta: 0.5, dCutoff: 3 });
  let s = 1;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
  const out: number[] = [];
  for (let i = 0; i < 100; i++) out.push(f.next(noise(), i * 40));
  const spread = Math.max(...out.slice(50)) - Math.min(...out.slice(50));
  assert.ok(spread < 0.05, `still: ${spread} of 0.1 jitter`);
  // A step of 2 torso lengths: most of the way there within 3 samples, and the velocity sees it.
  for (let i = 100; i < 103; i++) f.next(2, i * 40);
  assert.ok(f.value > 1.4, `fast: ${f.value}`);
  assert.ok(f.velocity > 5);
});

test('a follower without a calibration estimates one, and a calibration resets it', () => {
  const r = rig(1, REALISM.clean);
  const follower = createPoseFollower(0);
  r.run(100);
  follower.push(r.last()[0].landmarks, INPUT, r.clock.t);
  follower.update(r.clock.t);
  assert.equal(follower.pose.calibrated, false);
  near(follower.pose.body[JOINT.rightShoulder].y, 1, 0.05);
  follower.setCalibration({ inputWidth: 640, inputHeight: 480, torsoLength: 0.12, baseHip: { x: 0.5, y: 0.56, z: 0 }, floorY: 0.9, profileVersion: 1 });
  follower.push(r.last()[0].landmarks, INPUT, r.clock.t + 40);
  assert.equal(follower.pose.calibrated, true);
  near(follower.pose.body[JOINT.rightShoulder].y, 2, 0.1, 'measured in the calibrated torso');
  follower.update(r.clock.t + 1000);
  assert.equal(follower.pose.present, false);
});

test('raw is the newest pose as it arrived: unfiltered, unmirrored, a new one each time, with its world landmarks and hands when it had them', () => {
  const r = rig(1, REALISM.clean);
  r.run(600);
  const p = r.poses(0), [last] = r.last();
  assert.equal(p.raw?.landmarks, last.landmarks, 'the record\'s own landmarks');
  assert.deepEqual([p.raw?.world, p.raw?.hands, p.raw?.input], [null, null, INPUT]);
  assert.equal(p.raw?.capturedAt, p.capturedAt);
  // The screen is the mirror; raw is the camera's picture.
  near(p.screen[JOINT.rightWrist].x, 1 - p.raw!.landmarks[JOINT.rightWrist].x, 0.01);
  // A pose from a camera asked for the hands detail: the puppet's, through the tracker, with its extras.
  const found = r.puppet.detect(r.clock.t, { world: true, hands: true });
  const [pose] = r.tracker.update(found.landmarks, INPUT, r.clock.t + 40, found.looks, { world: found.world, hands: found.hands });
  const follower = createPoseFollower(0);
  const raw = () => follower.pose.raw;
  assert.equal(raw(), null, 'none before the first');
  follower.push(pose.landmarks, { width: 640, height: 480 }, r.clock.t + 40, pose);
  const first = raw();
  assert.equal(first?.world?.length, 33);
  assert.deepEqual(first?.hands?.map((h) => h.side), ['left', 'right']);
  assert.deepEqual(first?.input, INPUT, 'unmirrored, as records always are');
  follower.push(pose.landmarks, INPUT, r.clock.t + 80);
  assert.notEqual(raw(), first);
  assert.deepEqual([raw()?.world, raw()?.hands, raw()?.capturedAt], [null, null, r.clock.t + 80]);
});
