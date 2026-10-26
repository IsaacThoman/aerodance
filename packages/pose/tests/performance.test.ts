import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPerformanceClips, createPerformanceSampler, neutralCharacterPose, validatePerformance } from '../performance.ts';
import type { PerformanceClip } from '../performance.ts';

const clip = (): PerformanceClip => ({ id: 'gesture', startMs: 100, endMs: 500, keys: [
  { t: 100, pose: neutralCharacterPose(), ease: 'stop' },
  { t: 500, pose: { ...neutralCharacterPose(), leftHand: [1.2, 3.7, .8], bodyScale: [.8, .5, .8] }, ease: 'stop' },
] });
test('authored performance interpolates direct controls, holds accents and ends at its boundaries', () => {
  const c = clip(), sample = createPerformanceSampler([c]);
  assert.equal(sample(99), null); assert.equal(sample(501), null);
  assert.deepEqual(sample(100), c.keys[0].pose); assert.deepEqual(sample(500), c.keys[1].pose);
  assert.equal(sample(300)!.leftHand[1], 2.6);
  assert.equal(sample(300)!.bodyScale[1], .75);
  const changed = sample(300)!; changed.leftHand[0] = 99;
  assert.notEqual(sample(300)!.leftHand[0], 99);
  c.keys[0].interp = 'hold';
  const held = createPerformanceSampler([c]);
  assert.deepEqual(held(499), c.keys[0].pose);
  assert.deepEqual(held(500), c.keys[1].pose);
});
test('untrusted performance rejects broken times, overlapping clips, invalid poses and mismatched dancers', () => {
  const value = { schema: 'aerodance.performance', schemaVersion: 1, tracks: [{ clips: [clip()] }] };
  validatePerformance(value, 1);
  assert.throws(() => validatePerformance(value, 2), /dancer count/);
  const mutations: ((c: PerformanceClip) => void)[] = [
    c => { c.keys[1].t = c.keys[0].t; },
    c => { c.keys[1].t = 501; },
    c => { c.keys[0].t = 101; },
    c => { c.keys[1].pose.headScale = 0; },
    c => { c.keys[1].pose.body[0] = NaN; },
    c => { c.keys[1].pose.bodyScale[0] = -1; },
  ];
  for (const mutate of mutations) { const c = clip(); mutate(c); assert.throws(() => assertPerformanceClips([c])); }
  assert.throws(() => assertPerformanceClips([clip(), { ...clip(), id: 'second' }]), /overlap/);
});
