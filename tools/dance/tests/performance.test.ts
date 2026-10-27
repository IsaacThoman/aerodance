import test from 'node:test';
import assert from 'node:assert/strict';
import { newDance } from '../format.ts';
import { applyOps } from '../ops.ts';
import { compileDance } from '../compile.ts';
import { performanceOf } from '../performance.ts';
import { neutralCharacterPose } from '../../../packages/pose/performance.ts';

const op = () => ({ op: 'performance', dancer: 'P1', id: 'point', start: 100, end: 500, keys: [
  { t: 100, pose: neutralCharacterPose() },
  { t: 500, pose: { ...neutralCharacterPose(), leftHand: [1, 3.7, .5] } },
] });
test('direct character edits are atomic, report their keys, export on the dancer clock and preserve scoring poses', () => {
  const before = newDance({ dancers: 2, durationMs: 1000 });
  before.dancers[0].timeOffsetMs = 50;
  const incoming = op();
  const edited = applyOps(before, [incoming]);
  incoming.keys[1].pose.leftHand[0] = 99;
  assert.equal(edited.dance.dancers[0].performance![0].keys[1].pose.leftHand[0], 1);
  assert.deepEqual(edited.summary.keys, { added: 2, changed: 0, removed: 0 });
  assert.deepEqual(edited.summary.range, [150, 550]);
  assert.equal(before.dancers[0].performance, undefined);
  const performance = performanceOf(edited.dance)!;
  assert.deepEqual(performance.tracks[0].clips[0].keys.map(k => k.t), [150, 550]);
  assert.equal(performance.tracks[0].clips[0].startMs, 150);
  assert.deepEqual(performance.tracks[1].clips, []);
  assert.deepEqual(compileDance(before).timeline, compileDance(edited.dance).timeline);
  const invalid = op(); invalid.keys[1].pose.headScale = -1;
  assert.throws(() => applyOps(edited.dance, [invalid]), /headScale/);
  assert.equal(edited.dance.dancers[0].performance![0].keys[1].pose.headScale, 1);
  const removed = applyOps(edited.dance, [{ op: 'performance', dancer: 'P1', id: 'point', action: 'remove' }]);
  assert.equal(performanceOf(removed.dance), undefined);
});
