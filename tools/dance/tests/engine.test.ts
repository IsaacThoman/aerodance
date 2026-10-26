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

test('a style exaggerates the pose for the character and leaves the keys as filmed', () => {
  const pose = { head: [0.5, 0.3], leftShoulder: [0.54, 0.36], rightShoulder: [0.46, 0.36], leftElbow: [0.6, 0.3], leftWrist: [0.64, 0.22],
    rightElbow: [0.41, 0.42], rightWrist: [0.4, 0.5], leftHip: [0.53, 0.56], rightHip: [0.47, 0.56], leftKnee: [0.54, 0.7], rightKnee: [0.46, 0.7],
    leftAnkle: [0.54, 0.84], rightAnkle: [0.46, 0.84] };
  // The head rests at 0 (its keys' median) and glances 10° aside at 1 s.
  const keys = [{ op: 'song', set: { bpm: 120, beatOffsetMs: 0 } }, { op: 'key', dancer: 'P1', t: 1000, set: { ...pose, turn: 20, headYaw: 10 } },
    { op: 'key', dancer: 'P1', t: 0, set: { headYaw: 0 } }, { op: 'key', dancer: 'P1', t: 2000, set: { headYaw: 0 } }];
  const base = danceWith(keys);
  const styled = danceWith([...keys, { op: 'dancer', dancer: 'P1', style: { reach: 1.5, turn: 2, head: 2 } }]);
  const plain = createEvaluator(base, base.dancers[0]).rig(1000), e = createEvaluator(styled, styled.dancers[0]);
  const s = e.rig(1000), keyed = createEvaluator(styled, styled.dancers[0], { style: false }).rig(1000);
  assert.deepEqual(keyed, plain, 'style: false plays the keys as they are');
  assert.deepEqual(styled.dancers[0].style, { reach: 1.5, bounce: 1, sway: 1, lean: 1, turn: 2, head: 2, lift: 1 }, 'unnamed factors stay at 1');
  // Reach scales the arm about its shoulder: 1.5 times as far, the same direction.
  for (const side of ['left', 'right'] as const) {
    const sh = plain.points[`${side}Shoulder`], w = plain.points[`${side}Wrist`], sw = s.points[`${side}Wrist`];
    assert.ok(close(dist(sh, sw), 1.5 * dist(sh, w), 1e-9));
    assert.ok(close(Math.atan2(sw[1] - sh[1], sw[0] - sh[0]), Math.atan2(w[1] - sh[1], w[0] - sh[0]), 1e-9));
  }
  assert.equal(s.turn, 40);
  assert.equal(s.headYaw, 20);
  // Grown about the head's rest: a head that rests turned keeps resting there.
  const resting = danceWith([...keys.slice(0, 2), { op: 'key', dancer: 'P1', t: 0, set: { headYaw: 10 } }, { op: 'key', dancer: 'P1', t: 2000, set: { headYaw: 10, turn: 50 } },
    { op: 'dancer', dancer: 'P1', style: { head: 2, turn: 2 } }]);
  const r = createEvaluator(resting, resting.dancers[0]);
  assert.equal(r.rig(1000).headYaw, 10);
  // Never grown round past side-on.
  assert.equal(r.rig(2000).turn, 80);
  assert.deepEqual(s.points.leftHip.slice(0, 2), plain.points.leftHip.slice(0, 2), 'reach, turn and head move no hip on screen (turn moves it in depth)');
  // The base layer that ops key from is unstyled.
  assert.deepEqual(createEvaluator(styled, styled.dancers[0], { additive: false }).rig(1000).points.leftWrist, plain.points.leftWrist);
});
test('lean grows an upright lean but leaves a body bent over as keyed', () => {
  const upright = (dx: number) => ({ leftShoulder: [0.54 + dx, 0.36], rightShoulder: [0.46 + dx, 0.36], leftHip: [0.53, 0.56], rightHip: [0.47, 0.56] });
  const leanOf = (p: Record<string, number[]>) => Math.atan2(((p.leftShoulder[0] + p.rightShoulder[0]) - (p.leftHip[0] + p.rightHip[0])) / 2 * 16 / 9,
    (p.leftHip[1] + p.rightHip[1]) / 2 - (p.leftShoulder[1] + p.rightShoulder[1]) / 2);
  const with_ = (set: object) => {
    const d = danceWith([{ op: 'key', dancer: 'P1', t: 0, set }, { op: 'dancer', dancer: 'P1', style: { lean: 2 } }]);
    return [createEvaluator(d, d.dancers[0], { style: false }).rig(0).points, createEvaluator(d, d.dancers[0]).rig(0).points];
  };
  const [k1, s1] = with_(upright(0.03));
  assert.ok(close(leanOf(s1), 2 * leanOf(k1), 1e-6), 'a slight lean doubles');
  // On all fours: shoulders level with the hips, beside them.
  const [k2, s2] = with_({ leftShoulder: [0.62, 0.56], rightShoulder: [0.62, 0.5], leftHip: [0.5, 0.56], rightHip: [0.5, 0.5] });
  assert.ok(close(leanOf(s2), leanOf(k2), 1e-9));
});
test('lift raises a foot off the floor; bounce deepens dips without bending a limb', () => {
  const stand = { leftHip: [0.53, 0.56], rightHip: [0.47, 0.56], leftKnee: [0.54, 0.7], rightKnee: [0.46, 0.7], leftAnkle: [0.54, 0.84], rightAnkle: [0.46, 0.84] };
  const raised = { ...stand, leftKnee: [0.56, 0.66], leftAnkle: [0.55, 0.78] };
  const ops = [{ op: 'song', set: { bpm: 120, beatOffsetMs: 0 } }, { op: 'key', dancer: 'P1', t: 0, set: stand }, { op: 'key', dancer: 'P1', t: 1000, set: raised },
    { op: 'key', dancer: 'P1', t: 2000, set: stand }];
  const d = danceWith([...ops, { op: 'dancer', dancer: 'P1', style: { lift: 2 } }]);
  const k = createEvaluator(d, d.dancers[0], { style: false }).rig(1000).points, s = createEvaluator(d, d.dancers[0]).rig(1000).points;
  assert.ok(s.leftAnkle[1] < k.leftAnkle[1] - 0.02, 'the raised foot goes higher');
  assert.ok(close(s.rightAnkle[1], k.rightAnkle[1], 1e-9), 'the standing foot stays on the floor');
  const thigh = (p: typeof k) => Math.atan2(p.leftKnee[1] - p.leftHip[1], p.leftKnee[0] - p.leftHip[0]);
  assert.ok(close(thigh(s), thigh(k), 1e-9), 'the leg shortens along itself');
  const dip = danceWith([...ops.slice(0, 1), { op: 'key', dancer: 'P1', t: 0, set: stand },
    { op: 'key', dancer: 'P1', t: 500, set: Object.fromEntries(Object.entries(stand).map(([c, v]) => [c, [v[0], v[1] + 0.03]])) },
    { op: 'key', dancer: 'P1', t: 1000, set: stand }, { op: 'dancer', dancer: 'P1', style: { bounce: 2 } }]);
  const kd = createEvaluator(dip, dip.dancers[0], { style: false }).rig(500).points, sd = createEvaluator(dip, dip.dancers[0]).rig(500).points;
  assert.ok(sd.leftHip[1] > kd.leftHip[1] + 0.005, 'the low point goes lower');
  assert.ok(close(sd.leftAnkle[1] - sd.leftHip[1], kd.leftAnkle[1] - kd.leftHip[1], 1e-9), 'the whole body moves');
});
test('style factors are checked', () => {
  assert.throws(() => danceWith([{ op: 'dancer', dancer: 'P1', style: { reach: 9 } }]), /reach/);
  assert.throws(() => danceWith([{ op: 'dancer', dancer: 'P1', style: { wobble: 2 } }]), /no factor wobble/);
  const d = danceWith([{ op: 'dancer', dancer: 'P1', style: { reach: 1.4 } }, { op: 'dancer', dancer: 'P1', style: null }]);
  assert.equal(d.dancers[0].style, undefined);
});
