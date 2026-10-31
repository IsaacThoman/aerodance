import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDance } from '../format.ts';
import type { PointKey } from '../format.ts';
import { applyOps } from '../ops.ts';
import { createEvaluator } from '../evaluate.ts';
import { limbRel, screenLength } from '../rig.ts';
import { parseRange, parseTime } from '../time.ts';
import { close, danceWith, dist, trackingOf, withTracking } from './helpers.ts';

const keysOf = (dance: ReturnType<typeof danceWith>, control: string, dancer = 0, layer = 0) => dance.dancers[dancer].layers[layer].channels[control] ?? [];

test('times read as ms, seconds, minutes and beats', () => {
  const dance = danceWith([{ op: 'song', set: { bpm: 120, beatOffsetMs: 250 } }]);
  assert.equal(parseTime(4200), 4200);
  assert.equal(parseTime('4.2s'), 4200);
  assert.equal(parseTime('4200ms'), 4200);
  assert.equal(parseTime('1:02.5'), 62500);
  assert.equal(parseTime('b1', dance), 250);
  assert.equal(parseTime('b3.5', dance), 1500);
  assert.deepEqual(parseRange('1s:2s'), [1000, 2000]);
  assert.deepEqual(parseRange('1:00:1:02'), [60000, 62000]);
  assert.deepEqual(parseRange([100, '0.3s']), [100, 300]);
  assert.throws(() => parseTime('b4'), /needs a dance/);
  assert.throws(() => parseRange('5:1'), /must end after/);
});
test('key sets absolute, partial and relative values and groups move together', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' },
    { op: 'key', t: 500, set: { leftWrist: [0.7, 0.3], rightWrist: { y: 0.25 }, head: { dx: 0.01 }, headYaw: 20 } },
    { op: 'key', t: 800, set: { hips: { dx: -0.05 } }, interp: 'linear', ease: 'stop' }]);
  const at500 = createEvaluator(dance, dance.dancers[0]).rig(500);
  assert.deepEqual(keysOf(dance, 'leftWrist')[1].v, [0.7, 0.3]);
  assert.equal(at500.points.rightWrist[1], 0.25);
  assert.equal(keysOf(dance, 'headYaw')[1].v, 20);
  const hips = keysOf(dance, 'leftHip') as PointKey[];
  assert.equal(hips.length, 2);
  assert.equal(hips[1].interp, 'linear');
  assert.equal(hips[1].ease, 'stop');
  assert.ok(close(hips[1].v[0], hips[0].v[0] - 0.05, 1e-4));
  assert.equal(keysOf(dance, 'leftKnee').length, 1, 'a group move keys the points it moves directly; knees follow');
  assert.throws(() => applyOps(dance, [{ op: 'key', t: 0, set: { body: [0.1, 0.2] } }]), /group only moves relatively/);
  assert.throws(() => applyOps(dance, [{ op: 'key', t: 0, set: { leftWirst: [0.1, 0.2] } }]), /op 1 \(key\): Unknown control or point group "leftWirst"/);
});
test('moving a wrist keeps an elbow keyed at the same time on its limb', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'key', t: 1000, set: { leftWrist: [0.6, 0.35], leftElbow: [0.6, 0.45] } }]);
  const before = createEvaluator(dance, dance.dancers[0]).rig(1000).points;
  const relBefore = limbRel(before.leftShoulder, before.leftElbow, before.leftWrist, 16 / 9);
  const moved = applyOps(dance, [{ op: 'key', t: 1000, set: { leftWrist: { dx: 0.03, dy: -0.05 } } }]).dance;
  const after = createEvaluator(moved, moved.dancers[0]).rig(1000).points;
  assert.ok(close(screenLength(after.leftShoulder, after.leftElbow, 16 / 9), relBefore.l1, 2e-4));
  assert.ok(close(screenLength(after.leftElbow, after.leftWrist, 16 / 9), relBefore.l2, 2e-4));
  const loose = applyOps(dance, [{ op: 'key', t: 1000, follow: false, set: { leftWrist: { dx: 0.03 } } }]).dance;
  assert.deepEqual(keysOf(loose, 'leftElbow')[1].v, [0.6, 0.45], 'follow: false leaves the elbow key alone');
});
test('pose copies the current, neutral, another time\'s or another dancer\'s pose, optionally mirrored', () => {
  const dance = danceWith([{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }, { op: 'pose', dancer: 'P2', t: 0, from: 'neutral' },
    { op: 'key', dancer: 'P1', t: 500, set: { leftWrist: [0.4, 0.2], headYaw: 30 } },
    { op: 'pose', dancer: 'P1', t: 900, from: { t: 500 } },
    { op: 'pose', dancer: 'P2', t: 500, from: { dancer: 'P1', t: 500 }, mirror: 'frame' }], { dancers: 2 });
  assert.deepEqual(keysOf(dance, 'leftWrist')[2].v, [0.4, 0.2], 'hold this pose until 900');
  const p2 = createEvaluator(dance, dance.dancers[1]).rig(500);
  assert.ok(dist(p2.points.rightWrist, [0.6, 0.2]) < 1e-4, 'mirrored: P1\'s left wrist becomes P2\'s right, reflected');
  assert.equal(p2.headYaw, -30);
});
test('delete, interp and retime act on the keys they select', () => {
  let dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'key', t: 1000, set: { leftWrist: [0.6, 0.3] } },
    { op: 'key', t: 2000, set: { leftWrist: [0.6, 0.5], rightWrist: [0.4, 0.5] } }]);
  dance = applyOps(dance, [{ op: 'interp', range: '900:2100', controls: ['hands'], interp: 'hold', ease: 'sharp' }]).dance;
  assert.ok(keysOf(dance, 'leftWrist').filter(k => k.t >= 1000).every(k => k.interp === 'hold' && k.ease === 'sharp'));
  dance = applyOps(dance, [{ op: 'retime', range: '900:2100', shift: -80 }]).dance;
  assert.deepEqual(keysOf(dance, 'leftWrist').map(k => k.t), [0, 920, 1920]);
  dance = applyOps(dance, [{ op: 'retime', range: '900:2000', scale: 0.5, pivot: 920 }]).dance;
  assert.deepEqual(keysOf(dance, 'leftWrist').map(k => k.t), [0, 920, 1420]);
  assert.throws(() => applyOps(dance, [{ op: 'retime', range: '1400:1500', shift: -500 }]), /lands on the key at 920/);
  const replaced = applyOps(dance, [{ op: 'retime', range: '1400:1500', shift: -500, replace: true }]).dance;
  assert.deepEqual(keysOf(replaced, 'leftWrist').map(k => k.t), [0, 920]);
  dance = applyOps(dance, [{ op: 'delete', t: 1420, controls: ['leftWrist'] }]).dance;
  assert.deepEqual(keysOf(dance, 'leftWrist').map(k => k.t), [0, 920]);
  assert.deepEqual(keysOf(dance, 'rightWrist').map(k => k.t), [0, 1420]);
});
test('copy repeats, retimes and mirrors a phrase onto another dancer', () => {
  const dance = danceWith([{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' },
    { op: 'key', dancer: 'P1', t: 1000, set: { leftWrist: [0.3, 0.2] } }, { op: 'key', dancer: 'P1', t: 2000, set: { leftWrist: [0.28, 0.5] } },
    { op: 'contact', dancer: 'P1', control: 'leftAnkle', start: 1000, end: 1800 },
    { op: 'copy', from: { dancer: 'P1', range: '1000:2000' }, to: { dancer: 'P2', t: 4000 }, mirror: 'frame', repeat: 2, timeScale: 0.5 }], { dancers: 2 });
  const p2 = keysOf(dance, 'rightWrist', 1);
  assert.deepEqual(p2.map(k => k.t), [4000, 4500, 5000]);
  assert.deepEqual(p2[0].v, [0.7, 0.2]);
  assert.deepEqual(dance.dancers[1].contacts.map(c => [c.control, c.startMs, c.endMs]), [['rightAnkle', 4000, 4400], ['rightAnkle', 4500, 4900]]);
  const offset = applyOps(dance, [{ op: 'copy', from: { dancer: 'P1', range: '1000:2000' }, to: { dancer: 'P2', t: 7000 } }]).dance;
  assert.ok(close((keysOf(offset, 'leftWrist', 1).find(k => k.t === 7000)!.v as number[])[0], 0.3 + 0.5, 1e-9), 'moved to the other dancer\'s home');
});
test('smooth and simplify keep accents and contact boundaries', () => {
  const ops: unknown[] = [{ op: 'pose', t: 0, from: 'neutral' }];
  for (let t = 100; t <= 2000; t += 100) ops.push({ op: 'key', t, set: { leftWrist: [0.55 + 0.05 * Math.sin(t / 300) + (t % 200 ? 0.004 : -0.004), 0.4] } });
  ops.push({ op: 'interp', t: 1000, controls: ['leftWrist'], ease: 'sharp' }, { op: 'contact', control: 'leftWrist', start: 1500, end: 1700 });
  const dance = danceWith(ops);
  const smoothed = applyOps(dance, [{ op: 'smooth', controls: ['leftWrist'], windowMs: 300 }]).dance;
  const before = keysOf(dance, 'leftWrist') as PointKey[], after = keysOf(smoothed, 'leftWrist') as PointKey[];
  for (const t of [1000, 1500, 1700]) assert.deepEqual(after.find(k => k.t === t)!.v, before.find(k => k.t === t)!.v, `pinned key at ${t}`);
  assert.notDeepEqual(after.find(k => k.t === 400)!.v, before.find(k => k.t === 400)!.v);
  const { dance: simple, summary } = applyOps(smoothed, [{ op: 'simplify', controls: ['leftWrist'], tolerance: 0.01 }]);
  const kept = (keysOf(simple, 'leftWrist') as PointKey[]).map(k => k.t);
  assert.ok(kept.length < after.length, `${kept.length} < ${after.length}`);
  for (const t of [0, 1000, 1500, 1700, 2000]) assert.ok(kept.includes(t), `kept ${t}`);
  assert.match(summary.notes[0], /simplify removed \d+ keys/);
});
test('contacts, exclusions, phrases, markers, layers and dancers validate as they change', () => {
  let dance = danceWith([{ op: 'contact', control: 'leftAnkle', start: 1000, end: 2000, blendMs: 100 }]);
  assert.throws(() => applyOps(dance, [{ op: 'contact', control: 'leftAnkle', start: 1950, end: 3000, blendMs: 100 }]), /overlap/);
  applyOps(dance, [{ op: 'contact', control: 'leftAnkle', start: 2050, end: 3000, blendMs: 100 }]); // blends may overlap
  assert.throws(() => applyOps(dance, [{ op: 'contact', control: 'head', start: 0, end: 1 }]), /control must be one of/);
  dance = applyOps(dance, [{ op: 'uncontact', id: 'c1' }, { op: 'exclude', start: 0, end: 500, reason: 'legs out of frame', controls: ['legs'] },
    { op: 'phrase', label: 'Intro', start: 0, end: 4000 }, { op: 'marker', t: 'b1', kind: 'beat' }].slice(0, 3)).dance;
  assert.equal(dance.dancers[0].contacts.length, 0);
  assert.deepEqual(dance.dancers[0].exclusions[0].controls, ['legs']);
  assert.throws(() => applyOps(dance, [{ op: 'exclude', start: 0, end: 1, reason: '' }]), /needs a reason/);
  assert.throws(() => applyOps(dance, [{ op: 'marker', t: 'b1' }]), /need the song bpm/);
  dance = applyOps(dance, [{ op: 'dancer', action: 'add', label: 'Friend' }, { op: 'layer', dancer: 'P2', action: 'add', id: 'fix', weight: 0.5 },
    { op: 'song', set: { stage: 'club', title: 'T' } }]).dance;
  assert.equal(dance.dancers.length, 2);
  assert.equal(dance.dancers[1].label, 'Friend');
  assert.equal(dance.dancers[1].layers[1].weight, 0.5);
  assert.equal(dance.song.stage, 'club');
  assert.throws(() => applyOps(dance, [{ op: 'song', set: { stage: 'moon' } }]), /stage must be/);
  // The removed reef stage is openreef now.
  assert.equal(applyOps(dance, [{ op: 'song', set: { stage: 'reef' } }]).dance.song.stage, 'openreef');
  assert.throws(() => applyOps(dance, [{ op: 'layer', dancer: 'P2', action: 'remove', id: 'base' }]), /base layer cannot be removed/);
  assert.throws(() => applyOps(dance, [{ op: 'key', t: 0 }]), /Name the dancer/);
});
test('a failing op leaves the dance untouched and names itself', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }]);
  const copy = structuredClone(dance);
  assert.throws(() => applyOps(dance, [{ op: 'key', t: 1, set: { leftWrist: [0.1, 0.1] } }, { op: 'retime', range: 'nonsense' }]), /op 2 \(retime\)/);
  assert.throws(() => applyOps(dance, [{ op: 'frobnicate' }]), /unknown op "frobnicate"/);
  assert.throws(() => applyOps(dance, [{ op: 'key', t: 1, set: { leftWrist: [0.1, 0.1] }, sett: 1 }]), /unknown field "sett"/);
  assert.deepEqual(dance, copy);
});
test('the change summary counts keys and spans the song time they cover', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'dancer', timeOffsetMs: 1000 }]);
  const { summary } = applyOps(dance, [{ op: 'key', t: 500, set: { leftWrist: [0.6, 0.3] } }, { op: 'key', t: 0, set: { rightWrist: { dx: 0.01 } } },
    { op: 'delete', t: 0, controls: ['headYaw'] }]);
  // The right elbow keyed at 0 follows the right wrist: two keys change.
  assert.deepEqual(summary.keys, { added: 1, changed: 2, removed: 1 });
  assert.deepEqual(summary.dancers, ['P1']);
  assert.deepEqual(summary.range, [1000, 1500]);
});
test('nudge offsets an additive layer and fades back out', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'nudge', t: 1000, fadeMs: 200, set: { leftWrist: [0, -0.04] } }]);
  const layer = dance.dancers[0].layers.find(l => l.id === 'fix')!;
  assert.deepEqual(layer.channels.leftWrist.map(k => k.t), [800, 1000, 1200]);
  const e = createEvaluator(dance, dance.dancers[0]), base = createEvaluator(dance, dance.dancers[0], { additive: false });
  assert.ok(close(e.rig(1000).points.leftWrist[1] - base.rig(1000).points.leftWrist[1], -0.04, 1e-9));
  assert.ok(close(e.rig(1300).points.leftWrist[1], base.rig(1300).points.leftWrist[1], 1e-12));
});
test('draft and fit-body build an editable dance from tracking', () => {
  // The "video": a dancer whose arms wave, as tracking would see them.
  const source = danceWith([{ op: 'dancer', home: [0.45, 0.52], body: { upperArm: 0.14, forearm: 0.12 } }, { op: 'pose', t: 0, from: 'neutral' },
    ...[500, 1000, 1500, 2000, 2500, 3000].map((t, i) => ({ op: 'key', t, set: { leftWrist: [0.6, i % 2 ? 0.25 : 0.45], rightWrist: [0.3, i % 2 ? 0.45 : 0.25], leftElbow: [0.56, 0.33] } }))],
  { durationMs: 3500 });
  const { dance, ctx } = withTracking(newDance({ dancers: 1, durationMs: 3500 }), trackingOf(source));
  const { dance: drafted, summary } = applyOps(dance, [{ op: 'draft', dancer: 'P1', tolerance: 0.004 }], ctx);
  assert.match(summary.notes.join(' '), /fitted P1's body/);
  assert.ok(close(drafted.dancers[0].home[0], 0.45, 0.01));
  assert.ok(Math.abs(drafted.dancers[0].body.upperArm - 0.14) < 0.015);
  const wrist = keysOf(drafted, 'leftWrist');
  assert.ok(wrist.length >= 6 && wrist.length < 40, `${wrist.length} keys`);
  const a = createEvaluator(drafted, drafted.dancers[0]), b = createEvaluator(source, source.dancers[0]);
  for (let t = 0; t <= 3500; t += 50) for (const p of ['leftWrist', 'rightWrist', 'leftElbow', 'head'] as const)
    assert.ok(dist(a.rig(t).points[p], b.rig(t).points[p]) < 0.03, `${p} at ${t}: ${dist(a.rig(t).points[p], b.rig(t).points[p])}`);
  const single = applyOps(dance, [{ op: 'pose', t: 1500, from: 'tracking', controls: ['arms'] }], ctx).dance;
  assert.ok(dist(createEvaluator(single, single.dancers[0]).rig(1500).points.leftWrist, b.rig(1500).points.leftWrist) < 3e-3, 'tracking is interpolated between its frames');
});
