import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebcamCalibration, WEBCAM_MISS_MS, WEBCAM_STILL_MS, WEBCAM_FRAME_GAP_MS } from '../src/game/webcamCalibration.ts';
import type { CalibrationRecord } from '../src/game/webcamCalibration.ts';
import { standingPose } from '../src/pose/ReplayPoseSource.ts';
import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';

const laneX = (count: PlayerCount, id: number) => (count === 1 ? 0.5 : count === 2 ? 0.3 + id * 0.4 : (id + 0.5) / count);
const poses = (count: PlayerCount = 2): Pose[] => Array.from({ length: count }, (_, playerId) => ({ playerId, landmarks: standingPose(laneX(count, playerId)) }));
function camera(count: PlayerCount = 2) {
  const calibration = new WebcamCalibration(count);
  let seq = 0;
  const send = (time: number, players = poses(count), patch: Partial<CalibrationRecord> = {}, lag = 0) => calibration.accept({
    sessionId: 'camera', seq: ++seq, input: { width: 1280, height: 720 }, poses: players, ...patch,
  }, time, time + lag);
  const hold = (start: number, end: number, transform = (p: Pose[], _time: number) => p) => {
    for (let time = start; time <= end; time += 100) send(time, transform(poses(count), time));
  };
  return { calibration, send, hold };
}

test('four players hold together; anyone missing or moving restarts the hold', () => {
  const { calibration, send, hold } = camera(4);
  hold(0, 2000, p => p.filter(pose => pose.playerId !== 2));
  assert.deepEqual(calibration.status(2000).players, ['holding', 'holding', 'missing', 'holding']);
  assert.equal(calibration.status(2000).progress, 0);
  hold(2100, 3000);
  hold(3100, 3100, p => { p[3].landmarks.forEach(j => { j.x += 0.05; }); return p; });
  assert.equal(calibration.status(3100).players[3], 'moving');
  hold(3200, 5600);
  assert.equal(send(5700), true);
  assert.deepEqual(calibration.status(5700).players, ['ready', 'ready', 'ready', 'ready']);
  assert.equal(calibration.tracks?.length, 4);
  for (const [id, track] of (calibration.tracks ?? []).entries()) assert.ok(Math.abs(track.baseHip.x - laneX(4, id)) < 0.003);
});

test('both players hold together for 2.5 seconds; jitter is allowed and each stance is calibrated', () => {
  const { calibration, send, hold } = camera();
  hold(0, 2000, p => [p[0]]);
  assert.equal(calibration.status(2000).progress, 0);
  hold(2100, 4500, (p, time) => {
    p.forEach(pose => pose.landmarks.forEach(j => { j.x += Math.sin(time) * 0.002; }));
    return p;
  });
  assert.equal(calibration.status(4500).complete, false);
  assert.equal(send(4600), true);
  assert.deepEqual(calibration.status(4600), { players: ['ready', 'ready'], progress: 1, complete: true });
  assert.ok(calibration.tracks);
  assert.equal(calibration.tracks.length, 2);
  for (const [id, track] of calibration.tracks.entries()) {
    assert.equal(track.profileVersion, 2);
    assert.equal(track.cameraScaleMode, 'body-relative');
    assert.equal(track.inputWidth, 1280);
    assert.ok(Math.abs(track.baseHip.x - (0.3 + id * 0.4)) < 0.003);
    assert.equal(track.floorY, 0.88);
  }
});

test('body or wrist movement from either player resets the shared hold', () => {
  for (const joint of [23, 15]) {
    const { calibration, send, hold } = camera();
    hold(0, 1500);
    const moved = poses(); moved[1].landmarks[joint].x += 0.1;
    send(1600, moved);
    assert.equal(calibration.status(1600).progress, 0);
    assert.deepEqual(calibration.status(1600).players, ['holding', 'moving']);
    hold(1700, 4100);
    assert.equal(calibration.status(4100).complete, false);
    assert.equal(send(4200), true);
  }
});

test('slow drift is measured against the initial stance, not just the previous frame', () => {
  const { calibration, hold } = camera(1);
  hold(0, 2500, (p, time) => {
    p[0].landmarks.forEach(j => { j.x += time / 100 * 0.003; });
    return p;
  });
  assert.equal(calibration.status(2500).complete, false);
  assert.ok(calibration.status(2500).progress < 0.5);
});

test('missing players, low confidence and feet outside the image reset the hold', () => {
  const partials: ((p: Pose[]) => Pose[])[] = [p => [p[0]], p => { p[1].landmarks[27].confidence = 0.1; return p; }, p => { p[1].landmarks[28].y = 1.1; return p; }];
  for (const [i, partial] of partials.entries()) {
    const { calibration, send, hold } = camera();
    hold(0, 1500);
    // Missing for longer than the model misses somebody for; the rest at once.
    const until = i === 0 ? 1500 + WEBCAM_MISS_MS + 100 : 1600;
    for (let time = 1600; time <= until; time += 100) send(time, partial(poses()));
    assert.equal(calibration.status(until).progress, 0);
    assert.equal(calibration.tracks, null);
    hold(until + 100, until + 2500);
    assert.equal(calibration.status(until + 2500).complete, false);
    assert.equal(send(until + 2600), true);
  }
});

test('a player the model misses for a moment is still holding', () => {
  const { calibration, send, hold } = camera(3);
  hold(0, 1500);
  for (let time = 1600; time <= 1500 + WEBCAM_MISS_MS; time += 100) send(time, poses(3).filter(p => p.playerId !== 1));
  assert.deepEqual(calibration.status(1500 + WEBCAM_MISS_MS).players, ['holding', 'holding', 'holding']);
  assert.ok(calibration.status(1500 + WEBCAM_MISS_MS).progress > 0.6);
  hold(1600 + WEBCAM_MISS_MS, 2500);
  assert.equal(calibration.status(2500).complete, true);
  assert.equal(calibration.tracks?.length, 3);
});

test('render ticks, duplicate and old frames cannot advance calibration', () => {
  const { calibration, send } = camera(1);
  send(0);
  const duplicate = { sessionId: 'camera', seq: 1, input: { width: 1280, height: 720 }, poses: poses(1) };
  assert.equal(calibration.accept(duplicate, 100, 100), false);
  assert.equal(calibration.status(200).progress, 0);
  assert.equal(calibration.accept({ ...duplicate, seq: 2 }, 0, 200), false);
  assert.equal(calibration.accept({ ...duplicate, seq: 3 }, 100, 600), false);
  assert.deepEqual(calibration.status(600), { players: ['missing'], progress: 0, complete: false });
  assert.equal(calibration.accept({ ...duplicate, seq: 4 }, 800, 700), false, 'future capture timestamps are ignored');
  assert.equal(calibration.status(WEBCAM_STILL_MS).complete, false);
});

test('capture gaps and camera or dimension boundaries discard previous samples', () => {
  for (const patch of [{ sessionId: 'new-camera', seq: 1 }, { input: { width: 640, height: 480 } }]) {
    const { calibration, send, hold } = camera();
    hold(0, 1500);
    send(1600, poses(), patch);
    assert.equal(calibration.status(1600).progress, 0);
    assert.equal(calibration.frames[0].length, 1);
  }
  const { calibration, send, hold } = camera(1);
  hold(0, 1500);
  send(1500 + WEBCAM_FRAME_GAP_MS + 1);
  assert.equal(calibration.status(1901).progress, 0);
  assert.equal(calibration.frames[0].length, 1);
});

test('consistent inference latency does not break an otherwise continuous hold', () => {
  const { calibration, send } = camera(1);
  for (let time = 0; time <= 2700; time += 300) {
    send(time, poses(1), {}, 200);
    calibration.status(time + 450);
  }
  assert.equal(calibration.status(2900).complete, true);
});
