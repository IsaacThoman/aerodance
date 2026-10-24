import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePoseFile, encodePoseFile, sampleFrames } from '../../../packages/pose/binary.ts';
import { sampleDancers } from '../../../packages/pose/song.ts';
import { compileDance, choreographyOf } from '../compile.ts';
import { checkDance } from '../check.ts';
import { createEvaluator } from '../evaluate.ts';
import { mirrorRig, rigToLandmarks } from '../rig.ts';
import { gameBundle, scoreAgainstTracking } from '../score.ts';
import { danceWith, trackingOf, withTracking } from './helpers.ts';

/** A two-dancer phrase with waving arms, a step and a contact. */
function phrase() {
  const ops: unknown[] = [{ op: 'song', set: { bpm: 120 } }, { op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }, { op: 'pose', dancer: 'P2', t: 0, from: 'neutral' }];
  for (let beat = 1; beat <= 8; beat++) ops.push({ op: 'key', dancer: 'P1', t: beat * 500, set: {
    leftWrist: [0.36, beat % 2 ? 0.2 : 0.45], rightWrist: [0.12, beat % 2 ? 0.45 : 0.22], leftElbow: [0.33, beat % 2 ? 0.27 : 0.36], hips: { dx: beat % 4 < 2 ? 0.01 : -0.01 } } });
  ops.push({ op: 'contact', dancer: 'P1', control: 'leftAnkle', start: 0, end: 4000 },
    { op: 'copy', from: { dancer: 'P1', range: '0:4.5s' }, to: { dancer: 'P2', t: 0 }, mirror: 'frame' },
    { op: 'exclude', dancer: 'P2', start: 1000, end: 1500, reason: 'arms hidden', controls: ['arms'] },
    { op: 'exclude', dancer: 'P2', start: 3000, end: 3500, reason: 'off camera' });
  return danceWith(ops, { dancers: 2, durationMs: 4500 });
}

test('compiled frames reproduce the curves within tolerance and never leave a gap', () => {
  const dance = phrase(), compiled = compileDance(dance);
  const frames = decodePoseFile(encodePoseFile(choreographyOf(compiled, 'song-test')));
  assert.equal(frames.kind, 'choreography');
  assert.equal(frames.times[0], 0);
  assert.equal(frames.times[frames.times.length - 1], 4500);
  for (let i = 1; i < frames.times.length; i++) assert.ok(frames.times[i] - frames.times[i - 1] <= 150 + 1e-6, `gap at ${frames.times[i]}`);
  assert.ok(compiled.stats.frames < compiled.stats.candidates * 0.6, `kept ${compiled.stats.frames} of ${compiled.stats.candidates}`);
  const evaluators = dance.dancers.map(d => createEvaluator(dance, d));
  for (let t = 0; t <= 4500; t += 7.3) {
    const snapshot = sampleFrames(frames, t);
    assert.equal(snapshot.poses.length, 2, `both dancers at ${t}`);
    for (const pose of snapshot.poses) {
      const truth = evaluators[pose.playerId].landmarks(t);
      pose.landmarks.forEach((l, j) => {
        // The tolerance holds on the 60 Hz grid; between grid points a fast curve can stray a little further.
        assert.ok(Math.abs(l.x - truth[j].x) < 0.003 && Math.abs(l.y - truth[j].y) < 0.003, `P${pose.playerId + 1} joint ${j} at ${t}`);
      });
    }
  }
});
test('exclusions become unscored intervals and per-joint flags; calibration centres on the dancer', () => {
  const dance = phrase(), compiled = compileDance(dance), bundle = gameBundle(dance, compiled);
  assert.deepEqual(compiled.timeline.tracks[1].unscorableIntervals, [{ startMs: 3000, endMs: 3500, reason: 'off camera' }]);
  const inside = sampleDancers(bundle, 1200).quality.find(q => q.playerId === 1)!;
  assert.equal(inside.scoreEligible[15], false, 'arm joints are not scored while excluded');
  assert.equal(inside.scoreEligible[11], true);
  assert.equal(inside.scoreEligible[25], true);
  assert.ok(sampleDancers(bundle, 3200).quality.find(q => q.playerId === 1)!.scoreEligible.every(e => !e));
  assert.ok(sampleDancers(bundle, 2000).quality.every(q => q.scoreEligible.every(Boolean) && q.reviewed));
  const c = compiled.timeline.tracks[0].calibration;
  assert.ok(Math.abs(c.baseHip.x - 0.25) < 0.02 && c.profileVersion === 1 && c.inputWidth === 1280);
});
test('the game\'s scorer rates tracking of the dance itself near perfect, and its mirror image poorly', () => {
  const dance = phrase();
  const self = withTracking(dance, trackingOf(dance));
  const perfect = scoreAgainstTracking(self.dance, self.ctx.tracking!);
  assert.equal(perfect.length, 2);
  for (const s of perfect) assert.ok(s.result.accuracy > 0.97, `${s.dancer} ${s.result.accuracy}`);
  // A player who mirrors the dancer (left for right).
  const mirrored = trackingOf(dance, { transform: (i, t, d) => {
    const e = createEvaluator(d, d.dancers[i]), rig = e.rig(t);
    return rigToLandmarks(mirrorRig(rig, (rig.points.leftHip[0] + rig.points.rightHip[0]) / 2), d.dancers[i].body, 16 / 9);
  } });
  const flipped = withTracking(dance, mirrored);
  const wrong = scoreAgainstTracking(flipped.dance, flipped.ctx.tracking!);
  assert.ok(wrong[0].result.accuracy < perfect[0].result.accuracy - 0.2, `${wrong[0].result.accuracy}`);
  const findings = checkDance(flipped.dance, { tracking: flipped.ctx.tracking! });
  assert.ok(findings.some(f => f.kind === 'left-right' && f.dancer === 'P1'), 'check spots left and right swapped against the video');
});
test('check finds stretched limbs, jumps and sliding feet, and stays quiet on a clean phrase', () => {
  const clean = phrase();
  const noisy = checkDance(clean).filter(f => f.severity !== 'info');
  assert.deepEqual(noisy, []);
  const bad = danceWith([{ op: 'pose', t: 0, from: 'neutral' },
    { op: 'key', t: 1000, set: { leftWrist: [0.85, 0.3] } }, { op: 'key', t: 1500, set: { leftWrist: [0.85, 0.3] } },
    { op: 'key', t: 2000, set: { rightAnkle: { dx: -0.1 } }, interp: 'linear' }, { op: 'key', t: 2500, set: { rightAnkle: { dx: -0.1 } } },
    { op: 'key', t: 3000, set: { head: [0.5, 0.21] }, interp: 'hold' }, { op: 'key', t: 3001, set: { head: [0.3, 0.21] } }], { durationMs: 4000 });
  const kinds = new Set(checkDance(bad).map(f => `${f.kind}:${f.control}`));
  assert.ok(kinds.has('stretched-limb:leftWrist') || kinds.has('stretched-limb:leftElbow'), [...kinds].join(' '));
  assert.ok(kinds.has('foot-slide:rightAnkle'), [...kinds].join(' '));
  assert.ok(kinds.has('jump:head'), [...kinds].join(' '));
  const planted = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'key', t: 2000, set: { rightAnkle: { dx: -0.1 } } },
    { op: 'contact', control: 'rightAnkle', start: 0, end: 2000 }], { durationMs: 2000 });
  assert.ok(!checkDance(planted).some(f => f.kind === 'foot-slide'), 'a planted foot does not slide');
});
