import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tangent } from '../curves.ts';
import type { CurveKey } from '../curves.ts';
import { defaultBody, newDance, POINTS } from '../format.ts';
import { autoLimb, fitBody, landmarksToRig, limbIK, limbRel, mirrorRig, neutralPose, rigToLandmarks, screenLength } from '../rig.ts';
import { createEvaluator, contactWeight } from '../evaluate.ts';
import { close, danceWith, dist } from './helpers.ts';

const at = (keys: CurveKey[], t: number) => evaluate(keys, t)[0];

test('curves pass through their keys and hold outside them', () => {
  const keys: CurveKey[] = [{ t: 0, v: [0] }, { t: 100, v: [1] }, { t: 300, v: [0.5] }, { t: 400, v: [2] }];
  for (const k of keys) assert.equal(at(keys, k.t), k.v[0]);
  assert.equal(at(keys, -50), 0);
  assert.equal(at(keys, 900), 2);
});
test('smooth curves never overshoot a turning point or a monotone run', () => {
  const keys: CurveKey[] = [{ t: 0, v: [0] }, { t: 100, v: [1] }, { t: 130, v: [0] }, { t: 400, v: [0.2] }, { t: 410, v: [3] }];
  for (let t = 0; t <= 410; t += 1) {
    const v = at(keys, t), i = keys.findIndex(k => k.t > t) - 1;
    if (i < 0) continue;
    const lo = Math.min(keys[i].v[0], keys[i + 1].v[0]), hi = Math.max(keys[i].v[0], keys[i + 1].v[0]);
    assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `t=${t}: ${v} outside [${lo}, ${hi}]`);
  }
});
test('linear, hold, stop and sharp keys shape their segments', () => {
  const linear: CurveKey[] = [{ t: 0, v: [0], interp: 'linear' }, { t: 100, v: [1] }];
  assert.ok(close(at(linear, 25), 0.25));
  const hold: CurveKey[] = [{ t: 0, v: [0], interp: 'hold' }, { t: 100, v: [1] }];
  assert.equal(at(hold, 99.9), 0);
  assert.equal(at(hold, 100), 1);
  const rising: CurveKey[] = [{ t: 0, v: [0] }, { t: 100, v: [1] }, { t: 200, v: [2] }];
  assert.ok(tangent(rising, 1, 'out', 0) > 0);
  assert.equal(tangent([rising[0], { ...rising[1], ease: 'stop' }, rising[2]], 1, 'out', 0), 0);
  const sharp: CurveKey[] = [{ t: 0, v: [0] }, { t: 100, v: [1], ease: 'sharp' }, { t: 200, v: [0] }];
  assert.ok(tangent(sharp, 1, 'in', 0) > 0 && tangent(sharp, 1, 'out', 0) < 0, 'a hit arrives and leaves with its own velocities');
});

test('the neutral stance has the body\'s proportions, the dancer\'s left on image right', () => {
  const body = defaultBody(), aspect = 16 / 9, pose = neutralPose(body, [0.4, 0.5], aspect);
  const P = pose.points;
  assert.ok(P.leftShoulder[0] > P.rightShoulder[0] && P.leftHip[0] > P.rightHip[0]);
  assert.ok(close(screenLength(P.leftShoulder, P.rightShoulder, aspect), body.shoulderWidth, 1e-9));
  // Elbows and knees bend partly toward the camera, so their segments keep length in depth.
  const length3 = (a: readonly number[], b: readonly number[]) => Math.hypot((b[0] - a[0]) * aspect, b[1] - a[1], (b[2] - a[2]) * aspect);
  assert.ok(close(length3(P.leftShoulder, P.leftElbow), body.upperArm, 1e-9));
  assert.ok(close(length3(P.leftKnee, P.leftAnkle), body.shin, 1e-9));
  assert.ok(P.leftElbow[2] < 0, 'a relaxed elbow bends forward');
  const landmarks = rigToLandmarks(pose, body, aspect);
  assert.equal(landmarks.length, 33);
  assert.ok(landmarks.every(l => l.confidence === 1 && [l.x, l.y, l.z].every(Number.isFinite)));
  assert.ok(landmarks[7].x > landmarks[8].x, 'left ear on image right');
});
test('limb-relative joints reproduce a keyed elbow exactly and keep the limb whole', () => {
  const aspect = 1.5;
  for (const [s, e, w] of [[[0.5, 0.3, 0], [0.6, 0.42, 0.01], [0.55, 0.55, -0.02]], [[0.2, 0.2, 0], [0.1, 0.25, 0], [0.18, 0.33, 0]]] as const) {
    const rel = limbRel(s, e, w, aspect), back = limbIK(s, w, rel, aspect);
    for (let i = 0; i < 3; i++) assert.ok(close(back[i], e[i], 1e-9), `component ${i}: ${back[i]} vs ${e[i]}`);
    // Moving the wrist keeps both segments' on-screen lengths while it can.
    const moved = limbIK(s, [w[0] + 0.02, w[1] - 0.03, w[2]], rel, aspect);
    assert.ok(close(screenLength(s, moved, aspect), rel.l1, 1e-9));
  }
  const body = defaultBody(), pose = neutralPose(body, [0.5, 0.5], aspect);
  const elbow = autoLimb('leftElbow', pose.points.leftShoulder, [0.62, 0.32, 0], body, aspect);
  assert.ok(elbow[1] > 0.32 && elbow[0] > pose.points.leftShoulder[0], 'an unkeyed elbow bends out and down');
});
test('head angles and turn survive a round trip through landmarks', () => {
  const body = defaultBody(), aspect = 16 / 9, pose = neutralPose(body, [0.5, 0.5], aspect);
  Object.assign(pose, { headYaw: 25, headPitch: -12, headRoll: 8, turn: 20 });
  pose.points.leftShoulder[2] = Math.sin(20 * Math.PI / 180) * body.shoulderWidth / 2 / aspect;
  pose.points.rightShoulder[2] = -pose.points.leftShoulder[2];
  const back = landmarksToRig(rigToLandmarks(pose, body, aspect), body, aspect);
  assert.ok(Math.abs(back.headYaw - 25) < 0.5 && Math.abs(back.headPitch + 12) < 1 && Math.abs(back.headRoll - 8) < 1, JSON.stringify(back));
  assert.ok(Math.abs(back.turn - 20) < 0.5);
  for (const p of POINTS) assert.ok(dist(back.points[p], pose.points[p], aspect) < 1e-9, p);
  const twice = mirrorRig(mirrorRig(pose, 0.37), 0.37);
  for (const p of POINTS) assert.ok(dist(twice.points[p], pose.points[p], aspect) < 1e-12);
  const fitted = fitBody([rigToLandmarks(neutralPose(body, [0.5, 0.5], aspect), body, aspect)], aspect);
  for (const k of ['upperArm', 'forearm', 'thigh', 'shin', 'torso', 'shoulderWidth'] as const) assert.ok(Math.abs(fitted[k] - body[k]) < 1e-3, k);
});

test('a dancer without keys stands neutral at home; keys and offsets move it', () => {
  const dance = newDance({ dancers: 2 });
  const e = createEvaluator(dance, dance.dancers[1]);
  const neutral = neutralPose(dance.dancers[1].body, dance.dancers[1].home, 16 / 9);
  for (const p of POINTS) assert.ok(dist(e.rig(1234).points[p], neutral.points[p]) < 1e-9, p);
  const moved = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'dancer', timeOffsetMs: 500 },
    { op: 'key', t: 1000, set: { leftWrist: [0.7, 0.2] } }]);
  const m = createEvaluator(moved, moved.dancers[0]);
  assert.ok(dist(m.rig(1500).points.leftWrist, [0.7, 0.2]) < 1e-9, 'keys are on the dancer\'s clock, offset by timeOffsetMs');
});
test('a keyed elbow is exact at its key and follows its arm between keys', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' },
    { op: 'key', t: 1000, set: { leftWrist: [0.62, 0.3], leftElbow: [0.6, 0.42] } }, { op: 'key', t: 2000, set: { leftWrist: [0.66, 0.15] } }]);
  const e = createEvaluator(dance, dance.dancers[0]);
  assert.ok(dist(e.rig(1000).points.leftElbow, [0.6, 0.42]) < 1e-9);
  const rel = limbRel(e.rig(1000).points.leftShoulder, e.rig(1000).points.leftElbow, e.rig(1000).points.leftWrist, 16 / 9);
  const later = e.rig(1600).points;
  assert.ok(close(screenLength(later.leftShoulder, later.leftElbow, 16 / 9), rel.l1, 1e-9), 'the upper arm keeps its keyed length on screen');
});
test('the head rides on the shoulders and group offsets move the body once', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'key', t: 1000, set: { torso: { dx: 0.1 } } },
    { op: 'nudge', t: 500, fadeMs: 0, set: { body: [0, -0.05] } }]);
  const e = createEvaluator(dance, dance.dancers[0]), base = createEvaluator(dance, dance.dancers[0], { additive: false });
  const a = base.rig(1000).points, b = base.rig(0).points;
  assert.ok(close(a.head[0] - b.head[0], 0.1, 1e-9), 'the unkeyed-at-1000 head follows the shoulders');
  const withOffset = e.rig(500).points, without = base.rig(500).points;
  for (const p of POINTS) assert.ok(close(withOffset[p][1] - without[p][1], -0.05, 1e-9), `${p} moves by the offset exactly once`);
});
test('contacts plant a foot, blending in and out', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'key', t: 2000, set: { leftAnkle: { dx: 0.2 } } },
    { op: 'contact', control: 'leftAnkle', start: 500, end: 1200, blendMs: 100 }]);
  const e = createEvaluator(dance, dance.dancers[0]), free = createEvaluator(dance, dance.dancers[0], { contacts: false });
  const anchor = free.rig(500).points.leftAnkle;
  for (const t of [500, 800, 1200]) assert.ok(dist(e.rig(t).points.leftAnkle, anchor) < 1e-9);
  assert.ok(dist(e.rig(1400).points.leftAnkle, free.rig(1400).points.leftAnkle) < 1e-9, 'released after the blend');
  assert.equal(contactWeight(dance.dancers[0].contacts[0], 450), 0.5);
  // Continuous through the blend.
  let last = e.rig(390).points.leftAnkle;
  for (let t = 391; t <= 1400; t++) { const p = e.rig(t).points.leftAnkle; assert.ok(dist(p, last) < 0.004, `jump at ${t}`); last = p; }
});
