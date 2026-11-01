import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Puppet, REALISM, applyPatch } from '../src/pose/puppet/Puppet.ts';
import { bodyPoints, landmarksOf, reach, STAND, UPPER_ARM, FOREARM } from '../src/pose/puppet/rig.ts';
import type { Vec3 } from '../src/pose/puppet/rig.ts';
import { namedPose } from '../src/pose/puppet/poses.ts';
import { runPuppetCommand, words } from '../src/pose/puppet/commands.ts';
import { puppetWorker } from '../src/pose/puppet/puppetCamera.ts';
import { standingPose } from '../src/pose/ReplayPoseSource.ts';
import type { PoseWorkerResponse } from '../../../packages/pose/browser/pose.worker.ts';

const near = (a: number, b: number, tolerance: number, what = '') => assert.ok(Math.abs(a - b) <= tolerance, `${what} ${a} is not within ${tolerance} of ${b}`);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clock = () => { const c = { t: 1000, now: () => c.t }; return c; };

test('the puppet stands like standingPose: hips at 0.56, shoulders at 0.32, ankles at 0.88, P1 on the camera\'s right', () => {
  const lm = landmarksOf(STAND), reference = standingPose(0.5);
  for (const i of [0, 11, 12, 15, 16, 23, 24, 25, 26, 27, 28]) {
    near(lm[i].y, reference[i].y, 0.02, `landmark ${i} y`);
    near(lm[i].x, reference[i].x, 0.02, `landmark ${i} x`);
  }
  // The person's right shoulder (12) is on the left of the unmirrored picture.
  assert.ok(lm[12].x < lm[11].x);
  assert.ok(lm.every((j) => j.visibility > 0.85), 'everything in view is sure');
});

test('arms and legs keep their lengths whatever the hands and feet reach for', () => {
  for (const name of ['tpose', 'armsUp', 'punchRight', 'clap', 'crouch', 'star', 'kickLeft']) {
    const p = bodyPoints(applyPatch(STAND, namedPose(name)));
    near(dist(p[12], p[14]), UPPER_ARM, 1e-6, `${name} upper arm`);
    near(dist(p[14], p[16]), FOREARM, 1e-6, `${name} forearm`);
  }
  // Out of reach: the arm stretches straight towards the target.
  const { mid, end } = reach({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 1, 1, { x: 0, y: -1, z: 0 });
  near(end.x, 2, 0.01);
  near(mid.x, 1, 0.01);
  // T-pose: wrists at shoulder height, an arm's length out.
  const t = bodyPoints(applyPatch(STAND, namedPose('tpose')));
  near(t[16].y, 1, 0.02, 'right wrist height');
  near(t[16].x, 1.36, 0.02, 'right wrist out');
  near(t[15].x, -1.36, 0.02, 'left wrist out');
});

test('a crouch keeps the feet planted, a jump lifts everything, and stepping close takes the feet out of the picture', () => {
  const stand = landmarksOf(STAND);
  const crouch = landmarksOf(applyPatch(STAND, { crouch: 1 }));
  near(crouch[27].y, stand[27].y, 0.01, 'ankle stays');
  assert.ok(crouch[23].y > stand[23].y + 0.1, 'hips drop');
  const jump = landmarksOf(applyPatch(STAND, { lift: 0.5 }));
  near(stand[27].y - jump[27].y, 0.12, 0.005, 'ankles rise half a torso');
  const close = landmarksOf(applyPatch(STAND, { depth: 0.7 }));
  assert.ok(close[27].y > 1 && close[27].visibility < 0.3, 'feet out of the picture are unsure');
  assert.ok(close[11].visibility > 0.9);
});

test('the timeline tweens, holds, loops and answers for the past', () => {
  const c = clock();
  const puppet = new Puppet({ now: c.now, realism: REALISM.clean });
  puppet.lineUp(1);
  const person = puppet.people[0];
  puppet.pose(0, 'tpose', { ms: 400, ease: 'linear' });
  c.t += 200;
  near(puppet.poseAt(person, c.t).rightHand.y, (0.05 + 1) / 2, 0.01, 'halfway');
  c.t += 300;
  near(puppet.poseAt(person, c.t).rightHand.y, 1, 1e-9, 'there');
  // Asking for the past still sees the arm on its way up.
  near(puppet.poseAt(person, c.t - 400).rightHand.y, 0.05 + 0.95 * 0.25, 0.01, 'the past');
  // A change mid-tween starts from wherever the arm had got to.
  puppet.pose(0, 'stand', { ms: 1000 });
  c.t += 100;
  puppet.set(0, { lean: 10 });
  const cut = puppet.poseAt(person, c.t);
  assert.equal(cut.lean, 10);
  assert.ok(cut.rightHand.y < 1 && cut.rightHand.y > 0.8, 'held where the tween was cut');
  // Loops lay their laps down as time reaches them.
  puppet.play(0, [{ patch: { lean: 20 }, ms: 100 }, { patch: { lean: -20 }, ms: 100 }], { loop: true });
  c.t += 1050;
  near(Math.abs(puppet.poseAt(person, c.t).lean), 10, 10.01);
  c.t += 50;
  assert.equal(puppet.poseAt(person, c.t).lean, 20);
  c.t += 100;
  assert.equal(puppet.poseAt(person, c.t).lean, -20);
});

test('detect reports MediaPipe-shaped people in no stable order, with jitter, dropouts and unsure joints', () => {
  const c = clock();
  const puppet = new Puppet({ now: c.now, realism: REALISM.clean, seed: 3 });
  puppet.lineUp(4);
  const orders = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const { landmarks, looks } = puppet.detect(c.t);
    assert.equal(landmarks.length, 4);
    assert.equal(looks.length, 4);
    assert.ok(landmarks.every((p) => p.length === 33 && p.every((j) => 'visibility' in j && 'presence' in j)));
    orders.add(landmarks.map((p) => p[0].x.toFixed(2)).join());
  }
  assert.ok(orders.size > 1, 'the order changes');
  // Clean: the same pose twice is the same landmarks; real jitters.
  puppet.auto = false;
  puppet.lineUp(1);
  assert.deepEqual(puppet.detect(c.t).landmarks, puppet.detect(c.t).landmarks);
  puppet.realism = { ...REALISM.real };
  assert.notDeepEqual(puppet.detect(c.t).landmarks, puppet.detect(c.t).landmarks);
  puppet.realism = { ...REALISM.clean, dropout: 0.5 };
  const seen = Array.from({ length: 200 }, () => puppet.detect(c.t).landmarks.length).reduce((a, b) => a + b, 0);
  assert.ok(seen > 60 && seen < 140, `about half the frames miss the person (${seen}/200)`);
  // The face and hands flicker; the torso and legs of somebody in view don't.
  puppet.realism = { ...REALISM.clean, jointDropout: 1 };
  const unsure = puppet.detect(c.t).landmarks[0];
  assert.ok([0, 5, 15, 16, 19].every((i) => unsure[i].visibility <= 0.2));
  assert.ok([11, 12, 23, 24, 27, 28].every((i) => unsure[i].visibility > 0.9));
  // Walked out of the picture: gone.
  puppet.realism = { ...REALISM.clean };
  puppet.move(0, -0.4, { ms: 0 });
  assert.equal(puppet.detect(c.t).landmarks.length, 0);
});

test('the line-up follows the game\'s player count until people are placed by hand', () => {
  const c = clock();
  const puppet = new Puppet({ now: c.now });
  puppet.follow(3);
  assert.deepEqual(puppet.state().people.map((p) => [p.id, p.x]), [[0, 0.17], [1, 0.5], [2, 0.83]]);
  runPuppetCommand(puppet, 'players 1');
  puppet.follow(2);
  assert.equal(puppet.state().people.length, 1);
  runPuppetCommand(puppet, 'players auto');
  assert.equal(puppet.state().people.length, 2);
});

test('the command line poses, moves, plays and reports, and says what went wrong', () => {
  const c = clock();
  const puppet = new Puppet({ now: c.now, realism: REALISM.clean });
  assert.deepEqual(words(`set 0 '{"lean": 20}' --ms 300`), ['set', '0', '{"lean": 20}', '--ms', '300']);
  assert.deepEqual(words('set 0 {"lean": 20, "crouch": 0.5}'), ['set', '0', '{"lean": 20, "crouch": 0.5}']);
  runPuppetCommand(puppet, 'players 2');
  runPuppetCommand(puppet, 'pose p2 armsUp --ms 0');
  assert.ok(puppet.poseAt(puppet.people[1], c.t).rightHand.y > 1.8);
  runPuppetCommand(puppet, 'hand 0 right 1.2,1.5 --ms 0');
  assert.deepEqual(puppet.poseAt(puppet.people[0], c.t).rightHand, { x: 1.2, y: 1.5, z: 0.05 });
  runPuppetCommand(puppet, 'joint 0 nose 0.3,1.6 --ms 0');
  assert.deepEqual(bodyPoints(puppet.poseAt(puppet.people[0], c.t))[0], { x: 0.3, y: 1.6, z: 0.05 });
  runPuppetCommand(puppet, 'joint 0 nose off');
  assert.equal(puppet.poseAt(puppet.people[0], c.t).joints[0], undefined);
  const state = runPuppetCommand(puppet, ['to', 'all', '{"lean":15}', '--ms', '0']) as ReturnType<Puppet['state']>;
  assert.deepEqual(state.people.map((p) => p.lean), [15, 15]);
  // Named poses move nobody: everyone keeps their own place.
  runPuppetCommand(puppet, 'play all tpose:0 armsUp:0');
  c.t += 10;
  assert.deepEqual(puppet.state().people.map((p) => p.x), [0.25, 0.75]);
  runPuppetCommand(puppet, 'play 1 tpose:100+100 stand:100 --loop');
  assert.equal(puppet.state().people[1].moving, true);
  runPuppetCommand(puppet, 'gesture 0 swipeLeft --speed 2');
  assert.equal(puppet.state().people[0].moving, true);
  assert.deepEqual(runPuppetCommand(puppet, 'realism rough'), REALISM.rough);
  assert.match(String(runPuppetCommand(puppet, 'help')), /gesture <who>/);
  assert.throws(() => runPuppetCommand(puppet, 'pose 7 tpose'), /0-3, p1-p4 or all/);
  assert.throws(() => runPuppetCommand(puppet, 'pose 0 cartwheel'), /Unknown pose/);
  assert.throws(() => runPuppetCommand(puppet, 'gesture 0 moonwalk'), /Unknown gesture/);
  assert.throws(() => runPuppetCommand(puppet, 'dance'), /Unknown puppet command/);
});

test('the puppet worker speaks pose.worker.ts\'s protocol: ready, then each frame\'s people after inferenceMs', async () => {
  const c = clock();
  const puppet = new Puppet({ now: c.now, realism: { ...REALISM.clean, inferenceMs: 5 } });
  const worker = puppetWorker(puppet, { now: c.now, random: () => 0.5 });
  const replies: PoseWorkerResponse[] = [];
  worker.onmessage = ({ data }) => replies.push(data);
  worker.postMessage({ type: 'initialize', sessionId: 's', playerCount: 4, looks: true, modelUrl: '', modelHash: '', wasmUrl: '', tiles: [{ x: 0, width: 0.4 }, { x: 0.3, width: 0.4 }, { x: 0.6, width: 0.4 }] });
  // WebcamPoseSource sends frames once the worker is ready.
  await new Promise((resolve) => setTimeout(resolve, 50));
  let closed = 0;
  worker.postMessage({ type: 'frame', bitmap: { close: () => { closed++; } } as unknown as ImageBitmap, seq: 1, timestampMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(closed, 1, 'the picture is let go');
  assert.equal(puppet.state().people.length, 3, 'three strips: three players line up');
  assert.deepEqual(replies.map((r) => r.type), ['ready', 'result']);
  const result = replies[1];
  assert.ok(result.type === 'result' && result.seq === 1 && result.landmarks.length === 3 && result.looks?.length === 3);
  worker.postMessage({ type: 'frame', bitmap: { close() {} } as unknown as ImageBitmap, seq: 2, timestampMs: 33 });
  worker.terminate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(replies.length, 2, 'nothing after terminate');
});

test('through a real WebcamPoseSource, the puppet worker\'s people come out as tracked, numbered records', async () => {
  const { WebcamPoseSource } = await import('../../../packages/pose/browser/WebcamPoseSource.ts');
  const puppet = new Puppet({ realism: { ...REALISM.clean, inferenceMs: 4 } });
  // The camera, video and bitmap fakes implement only what WebcamPoseSource uses (as webcam.test.ts's).
  const camera: { frame: VideoFrameRequestCallback | null } = { frame: null };
  const track = { muted: false, stop() {}, getSettings: () => ({ deviceId: 'puppet' }), addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const video = {
    videoWidth: 640, videoHeight: 480, currentTime: 0, play: async () => {}, pause() {}, remove() {}, addEventListener() {},
    requestVideoFrameCallback(fn: VideoFrameRequestCallback) { camera.frame = fn; return 1; }, cancelVideoFrameCallback() { camera.frame = null; },
  } as unknown as HTMLVideoElement;
  const source = new WebcamPoseSource({
    mediaDevices: { getUserMedia: async () => stream, enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'puppet', label: 'Puppet camera' } as MediaDeviceInfo] },
    createVideo: () => video, bitmap: async () => ({ close() {} }) as ImageBitmap, createWorker: () => puppetWorker(puppet),
    assetUrl: () => 'http://127.0.0.1/', settingsKey: 'puppet-test',
  });
  await source.setPlayerCount(2);
  const records: { poses: { playerId: number; landmarks: { x: number }[] }[] }[] = [];
  source.subscribeRecords((e) => { if ('record' in e) records.push(e.record); });
  await source.connect();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(source.view.status, 'initializing');
  assert.equal(puppet.state().people.length, 2, 'two players asked for: two puppets in view');
  // Frames from the camera, one at a time, as fast as tracking answers.
  for (let i = 1; i <= 25; i++) {
    camera.frame?.(i * 33, { mediaTime: i / 30 } as VideoFrameCallbackMetadata);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  source.disconnect();
  assert.equal(records.length > 15, true, `${records.length} records`);
  const last = records.at(-1)!;
  assert.deepEqual(last.poses.map((p) => p.playerId), [0, 1], 'both numbered once all were in view');
  // P1 stands on the left of the mirror: the right of the camera's picture.
  assert.ok(last.poses[0].landmarks[0].x > last.poses[1].landmarks[0].x);
});
