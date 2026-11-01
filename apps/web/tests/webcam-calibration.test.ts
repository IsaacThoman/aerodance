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

test('each player holds on their own; a move restarts only the mover, and everyone finishes together', () => {
  const { calibration, send, hold } = camera(4);
  hold(0, 2000, p => p.filter(pose => pose.playerId !== 2));
  assert.deepEqual(calibration.status(2000).players, ['holding', 'holding', 'missing', 'holding']);
  assert.equal(calibration.status(2000).progress, 0, 'progress is the slowest player\'s');
  hold(2100, 3000);
  // Player 4 steps aside and stays there: only their hold starts again.
  const aside = (p: Pose[]) => { p[3].landmarks.forEach(j => { j.x += 0.05; }); return p; };
  hold(3100, 3200, aside);
  assert.deepEqual(calibration.status(3200).players, ['holding', 'holding', 'holding', 'moving']);
  hold(3300, 5700, aside);
  assert.deepEqual(calibration.status(5700).players, ['holding', 'holding', 'holding', 'holding'], 'nobody is calibrated before everyone is');
  assert.equal(calibration.status(5700).complete, false);
  assert.equal(send(5800, aside(poses(4))), true);
  assert.deepEqual(calibration.status(5800).players, ['ready', 'ready', 'ready', 'ready']);
  assert.equal(calibration.tracks?.length, 4);
  for (const [id, track] of (calibration.tracks ?? []).entries()) assert.ok(Math.abs(track.baseHip.x - laneX(4, id) - (id === 3 ? 0.05 : 0)) < 0.003);
});

test('a player who leaves restarts their own hold, and calibration waits for them', () => {
  const { calibration, send, hold } = camera();
  hold(0, 2000);
  hold(2100, 3000, p => [p[0]]);
  assert.deepEqual(calibration.status(3000).players, ['holding', 'missing']);
  assert.equal(calibration.status(3000).complete, false, 'the one still there can\'t start the song alone');
  hold(3100, 5500);
  assert.equal(calibration.status(5500).complete, false);
  assert.equal(send(5600), true);
});

test('a number passing to somebody standing elsewhere restarts that hold', () => {
  const { calibration, send, hold } = camera();
  hold(0, 1500);
  const swapped = (p: Pose[]) => [{ playerId: 0, landmarks: p[1].landmarks }, { playerId: 1, landmarks: p[0].landmarks }];
  hold(1600, 1700, swapped);
  assert.deepEqual(calibration.status(1700).players, ['moving', 'moving']);
  hold(1800, 4200, swapped);
  assert.equal(calibration.status(4200).complete, false);
  assert.equal(send(4300, swapped(poses())), true);
  assert.ok(Math.abs(calibration.tracks![0].baseHip.x - laneX(2, 1)) < 0.003, 'each calibration is of whoever has the number now');
});

test('the stances are only shared while everyone is holding (the setup line-up retry waits on them)', () => {
  const { calibration, hold } = camera(3);
  hold(0, 3000, p => p.filter(pose => pose.playerId !== 2));
  const anchors = () => calibration.anchors;
  assert.equal(anchors(), null, 'somebody missing: nothing is progressing for everyone');
  hold(3100, 3200);
  assert.equal(anchors()?.length, 3);
});

test('a slow camera can\'t hide a move just before the hold is done', () => {
  const { calibration, send } = camera(1);
  for (let time = 0; time <= 2000; time += 400) send(time);
  const moved = poses(1); moved[0].landmarks.forEach(j => { j.x += 0.05; });
  assert.equal(send(2400, moved), false);
  assert.equal(calibration.status(2400).players[0], 'moving');
  assert.equal(send(2800, moved), false);
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

test('body movement restarts only the mover\'s hold; hands and one jittery result don\'t', () => {
  {
    const { calibration, send, hold } = camera();
    hold(0, 1500);
    const moved = (p: Pose[]) => { p[1].landmarks[23].x += 0.1; return p; };
    hold(1600, 1700, moved);
    assert.deepEqual(calibration.status(1700).players, ['holding', 'moving']);
    hold(1800, 4200, moved);
    assert.equal(calibration.status(4200).complete, false, 'the mover holds 2.5 s from where they stopped');
    assert.equal(send(4300, moved(poses())), true);
  }
  {
    // Calibration doesn't measure hands, so waving one doesn't restart anything.
    const { send, hold } = camera();
    hold(0, 1500);
    hold(1600, 2400, (p, time) => { p[1].landmarks[15].x += 0.1 * Math.sin(time); return p; });
    assert.equal(send(2500), true);
  }
  {
    // A single result with the hips jumped is the model's jitter, not a move.
    const { calibration, send, hold } = camera();
    hold(0, 1500);
    hold(1600, 1600, p => { p[1].landmarks[23].x += 0.1; p[1].landmarks[24].x += 0.1; return p; });
    assert.deepEqual(calibration.status(1600).players, ['holding', 'holding']);
    hold(1700, 2400);
    assert.equal(send(2500), true);
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
  for (const partial of partials) {
    const { calibration, send, hold } = camera();
    hold(0, 1500);
    // For longer than the model misses (or is unsure of) somebody for.
    const until = 1500 + WEBCAM_MISS_MS + 100;
    for (let time = 1600; time <= until; time += 100) send(time, partial(poses()));
    assert.equal(calibration.status(until).progress, 0);
    assert.equal(calibration.tracks, null);
    hold(until + 100, until + 2500);
    assert.equal(calibration.status(until + 2500).complete, false);
    assert.equal(send(until + 2600), true);
  }
});

test('one unsure result is like a moment missed, not a restart', () => {
  const { calibration, send, hold } = camera();
  hold(0, 1500);
  hold(1600, 1600, p => { p[1].landmarks[27].confidence = 0.45; return p; });
  assert.deepEqual(calibration.status(1600).players, ['holding', 'holding']);
  hold(1700, 2400);
  assert.equal(send(2500), true);
});

test('with two results in the window, jitter either way is treated the same', () => {
  for (const dx of [0.1, -0.1]) {
    const { calibration, send } = camera(1);
    for (let time = 0; time <= 1200; time += 150) send(time);
    const jitter = poses(1); jitter[0].landmarks[23].x += dx; jitter[0].landmarks[24].x += dx;
    send(1350, jitter);
    assert.equal(calibration.status(1350).players[0], 'holding', `hips ${dx > 0 ? 'right' : 'left'}`);
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
