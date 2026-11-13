// Captured motion: takes placed as clips beneath the keys (packages/dance/takes.ts, evaluate.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDance } from '../compile.ts';
import { createEvaluator } from '../evaluate.ts';
import { assertDance, newDance, upgradeDance } from '../format.ts';
import type { Dance, TakeSource } from '../format.ts';
import { applyOps } from '../ops.ts';
import { checkDance } from '../check.ts';
import { takeFromFrames } from '../../../packages/dance/takes.ts';
import type { TakeData, TrackedFrame } from '../../../packages/dance/takes.ts';
import { gameBundle } from '../score.ts';
import { createScorer } from '../../../packages/score/scorer.ts';
import { danceWith, dist } from './helpers.ts';

const NOW = '2026-01-01T00:00:00.000Z';
/** A keyed dancer waving an arm and stepping, to capture as if a camera had filmed it. */
function performer(durationMs = 8000): Dance {
  return danceWith([
    { op: 'pose', dancer: 'P1', t: 0, from: 'neutral' },
    { op: 'key', dancer: 'P1', t: 1000, set: { leftWrist: [0.62, 0.28], rightWrist: [0.4, 0.6], leftElbow: [0.58, 0.4] } },
    { op: 'key', dancer: 'P1', t: 2000, set: { leftWrist: [0.56, 0.62], rightWrist: [0.36, 0.3], rightElbow: [0.42, 0.42] } },
    { op: 'key', dancer: 'P1', t: 3000, set: { leftWrist: [0.66, 0.4], rightWrist: [0.34, 0.4], leftAnkle: [0.57, 0.86] } },
    { op: 'key', dancer: 'P1', t: 4000, set: { leftWrist: [0.6, 0.2], rightWrist: [0.4, 0.2], headRoll: 12, turn: 20 } },
    { op: 'key', dancer: 'P1', t: 6000, set: { leftWrist: [0.55, 0.6], rightWrist: [0.45, 0.6], headRoll: 0, turn: 0 } },
  ], { dancers: 1, durationMs });
}
/** `dance`'s dancer 0 as a take: its landmarks every `everyMs`, in a picture of the given size. */
function capture(dance: Dance, { everyMs = 1000 / 30, width = dance.frame.width, height = dance.frame.height, drop = () => false, unsure = () => [] }:
  { everyMs?: number; width?: number; height?: number; drop?: (t: number) => boolean; unsure?: (t: number) => number[] } = {}): TakeData {
  const e = createEvaluator(dance, dance.dancers[0]), frames: TrackedFrame[] = [];
  const squeeze = (dance.frame.width / dance.frame.height) / (width / height);
  for (let t = 0; t <= dance.song.durationMs; t += everyMs) {
    const time = Math.round(t * 10) / 10;
    const low = unsure(time);
    frames.push({ videoMs: time, poses: [drop(time) ? null : e.landmarks(time).map((l, j) => ({ ...l, x: 0.5 + (l.x - 0.5) * squeeze, z: l.z * squeeze, confidence: low.includes(j) ? 0.2 : 0.95 }))] });
  }
  return takeFromFrames(frames, { width, height, slots: 1 });
}
const takeSource = (id: string, data: TakeData, clock: TakeSource['clock'] = 'song'): TakeSource => ({
  id, label: `Take ${id}`, createdAt: NOW, origin: 'webcam', clock, model: 'lite', fps: 30, slots: data.slots, width: data.width, height: data.height,
  startMs: data.times[0], endMs: data.times[data.times.length - 1], path: `sources/take-${id}.adpose`, sha256: 'b'.repeat(64), bytes: 1, mimeType: 'application/octet-stream',
});
/** An empty dance holding the given takes. */
function stage(takes: Record<string, TakeData>, { dancers = 1, durationMs = 8000 } = {}) {
  const dance = newDance({ dancers, durationMs, now: NOW });
  for (const [id, data] of Object.entries(takes)) dance.sources.takes.push(takeSource(id, data));
  assertDance(dance);
  const lookup = (id: string) => takes[id] ?? null;
  return { dance, ctx: { takes: lookup }, lookup };
}
const worst = (a: Dance, b: Dance, lookup: (id: string) => TakeData | null, times: number[], controls = ['leftWrist', 'rightWrist', 'leftElbow', 'rightElbow', 'leftAnkle', 'rightKnee', 'head'] as const) => {
  const ea = createEvaluator(a, a.dancers[0]), eb = createEvaluator(b, b.dancers[0], { takes: lookup });
  let w = 0;
  for (const t of times) for (const c of controls) w = Math.max(w, dist(ea.rig(t).points[c], eb.rig(t).points[c]));
  return w;
};

test('a version 1 dance opens as version 2 with no clips, and plays the same', () => {
  const v2 = performer(), v1 = structuredClone(v2) as unknown as Record<string, unknown>;
  v1.schemaVersion = 1;
  delete (v1.sources as Record<string, unknown>).takes;
  for (const d of v1.dancers as Record<string, unknown>[]) { delete d.clips; delete d.approvals; }
  const upgraded = upgradeDance(v1);
  assertDance(upgraded);
  assert.deepEqual(upgraded, v2);
});

test('a take placed as filmed plays back what was captured, elbows, knees and head included', () => {
  const source = performer(), take = capture(source);
  const { dance, ctx, lookup } = stage({ k1: take });
  const { dance: placed, summary } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', fadeIn: 0, fadeOut: 0 }], ctx);
  assert.equal(placed.dancers[0].clips.length, 1);
  assert.deepEqual(summary.dancers, ['P1']);
  // Within a pixel or two of the keyed original, between the take's frames as well as on them.
  assert.ok(worst(source, placed, lookup, [500, 1000, 1517, 2000, 2733, 4000, 5250]) < 0.004);
  const a = createEvaluator(source, source.dancers[0]).rig(4000), b = createEvaluator(placed, placed.dancers[0], { takes: lookup }).rig(4000);
  assert.ok(Math.abs(a.turn - b.turn) < 3 && Math.abs(a.headRoll - b.headRoll) < 3, `turn ${b.turn}, roll ${b.headRoll}`);
});

test('a take shot in another shape and size stands at the dancer\'s home at the dancer\'s size', () => {
  const source = performer(), take = capture(source, { width: 640, height: 480 });
  const { dance, ctx, lookup } = stage({ k1: take });
  dance.dancers[0].home = [0.3, 0.55];
  const { dance: placed } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', fadeIn: 0, fadeOut: 0 }], ctx);
  const e = createEvaluator(placed, placed.dancers[0], { takes: lookup }), src = createEvaluator(source, source.dancers[0]);
  // The take's median hips land on home, and limbs keep their lengths in frame heights.
  const hips = [0, 1000, 2000, 5000].map(t => { const p = e.rig(t).points; return [(p.leftHip[0] + p.rightHip[0]) / 2, (p.leftHip[1] + p.rightHip[1]) / 2]; });
  for (const h of hips) assert.ok(dist(h, [0.3, 0.55]) < 0.03, `hips at ${h}`);
  const arm = (p: ReturnType<typeof e.rig>['points']) => dist(p.leftShoulder, p.leftWrist);
  assert.ok(Math.abs(arm(e.rig(1000).points) / arm(src.rig(1000).points) - placed.dancers[0].body.torso / source.dancers[0].body.torso) < 0.05);
  assert.ok(Math.abs(placed.dancers[0].body.torso - dance.dancers[0].body.torso) < 1e-6, 'the dancer keeps its size');
});

test('clips fade over the keys beneath them, and a fix moves a hand without breaking the arm', () => {
  const source = performer(), take = capture(source);
  const { dance, ctx, lookup } = stage({ k1: take });
  const { dance: placed } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', start: 1000, end: 5000, fadeIn: 400, fadeOut: 400 }], ctx);
  const e = createEvaluator(placed, placed.dancers[0], { takes: lookup }), src = createEvaluator(source, source.dancers[0]);
  const neutral = createEvaluator(placed, placed.dancers[0], { clips: false }).rig(0).points.leftWrist;
  assert.ok(dist(e.rig(900).points.leftWrist, neutral) < 1e-6, 'before the clip: the neutral stance');
  assert.ok(dist(e.rig(3000).points.leftWrist, src.rig(3000).points.leftWrist) < 0.004, 'inside: the take');
  const half = e.rig(1200).points.leftWrist, full = src.rig(1200).points.leftWrist;
  assert.ok(dist(half, neutral) > 0.01 && dist(half, full) > 0.01, 'in the fade: between the two');
  // Fix the left wrist at 3 s: it lands on the target, eases out by 3.2 s, and the elbow keeps the arm's lengths.
  const { dance: fixed } = applyOps(placed, [{ op: 'fix', dancer: 'P1', t: 3000, set: { leftWrist: [0.7, 0.3] } }], ctx);
  const f = createEvaluator(fixed, fixed.dancers[0], { takes: lookup });
  assert.ok(dist(f.rig(3000).points.leftWrist, [0.7, 0.3]) < 1e-4);
  assert.ok(dist(f.rig(3200).points.leftWrist, e.rig(3200).points.leftWrist) < 1e-4 && dist(f.rig(2800).points.leftWrist, e.rig(2800).points.leftWrist) < 1e-4);
  assert.ok(dist(f.rig(3100).points.leftWrist, e.rig(3100).points.leftWrist) > 0.005, 'eases between');
  const before = e.rig(3000).points, after = f.rig(3000).points;
  const upper = (p: typeof before) => dist(p.leftShoulder, p.leftElbow);
  assert.ok(dist(after.leftElbow, before.leftElbow) > 0.005, 'the elbow follows the wrist');
  assert.ok(Math.abs(upper(after) - upper(before)) < 0.03, 'and the upper arm keeps its length');
  // A second fix nearby keeps the first.
  const { dance: twice } = applyOps(fixed, [{ op: 'fix', dancer: 'P1', t: 3100, set: { leftWrist: { dy: -0.05 } } }], ctx);
  const g = createEvaluator(twice, twice.dancers[0], { takes: lookup });
  assert.ok(dist(g.rig(3000).points.leftWrist, [0.7, 0.3]) < 1e-4);
});

test('a new clip takes over its span: covered clips go, overlapped ones are trimmed and split', () => {
  const take = capture(performer());
  const { dance, ctx } = stage({ k1: take, k2: take });
  const { dance: one } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', start: 0, end: 8000, id: 'whole' }], ctx);
  const { dance: two } = applyOps(one, [{ op: 'clip', dancer: 'P1', take: 'k2', place: 'frame', start: 2000, end: 4000, id: 'redo', fadeIn: 100, fadeOut: 100 }], ctx);
  const clips = two.dancers[0].clips.map(c => [c.id, c.startMs, c.endMs, c.kind === 'take' ? c.offsetMs : null]);
  assert.deepEqual(clips, [['whole', 0, 2100, 0], ['clip1', 3900, 8000, 3900], ['redo', 2000, 4000, 2000]]);
  const { dance: three } = applyOps(two, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', start: 1000, end: 7000, id: 'again' }], ctx);
  assert.deepEqual(three.dancers[0].clips.map(c => c.id), ['whole', 'clip1', 'again']);
  assert.equal(three.dancers[0].clips[0].endMs, 1150);
  // Split, move, trim and remove.
  const { dance: split } = applyOps(three, [{ op: 'clip', dancer: 'P1', action: 'split', id: 'again', t: 3000 }, { op: 'clip', dancer: 'P1', action: 'update', id: 'again', move: -200 },
    { op: 'clip', dancer: 'P1', action: 'update', id: 'clip2', start: 3500 }, { op: 'clip', dancer: 'P1', action: 'remove', id: 'whole' }], ctx);
  const again = split.dancers[0].clips.find(c => c.id === 'again')!, rest = split.dancers[0].clips.find(c => c.id === 'clip2')!;
  assert.deepEqual([again.startMs, again.endMs, again.kind === 'take' && again.offsetMs], [800, 2800, 1000]);
  assert.deepEqual([rest.startMs, rest.endMs, rest.kind === 'take' && rest.offsetMs], [3500, 7000, 3500]);
  assert.throws(() => applyOps(split, [{ op: 'take', id: 'k1', action: 'remove' }], ctx), /is played by/);
  const { dance: cleared } = applyOps(split, [{ op: 'take', id: 'k1', action: 'remove', force: true }], ctx);
  assert.deepEqual(cleared.sources.takes.map(k => k.id), ['k2']);
});

test('a linked clip repeats a stretch, mirrored for a partner, and follows edits to its source', () => {
  const take = capture(performer());
  const { dance, ctx, lookup } = stage({ k1: take }, { dancers: 2 });
  const { dance: linked } = applyOps(dance, [
    { op: 'clip', dancer: 'P1', take: 'k1', start: 0, end: 4000, fadeIn: 0, fadeOut: 0 },
    { op: 'clip', dancer: 'P1', ref: { range: '0:4000' }, start: 4000, fadeIn: 0, fadeOut: 0 },
    { op: 'clip', dancer: 'P2', ref: { dancer: 'P1', range: '0:8000' }, start: 0, mirror: true, fadeIn: 0, fadeOut: 0 },
  ], ctx);
  const p1 = createEvaluator(linked, linked.dancers[0], { takes: lookup }), p2 = createEvaluator(linked, linked.dancers[1], { takes: lookup });
  assert.ok(dist(p1.rig(5000).points.leftWrist, p1.rig(1000).points.leftWrist) < 1e-6, 'the repeat plays the first half again');
  const [h1, h2] = [linked.dancers[0].home, linked.dancers[1].home];
  const a = p1.rig(5000).points.leftWrist, b = p2.rig(5000).points.rightWrist;
  assert.ok(Math.abs((a[0] - h1[0]) + (b[0] - h2[0])) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6, 'the partner mirrors it, through the repeat');
  // A fix on the source shows in the repeat and the partner.
  const { dance: fixed } = applyOps(linked, [{ op: 'fix', dancer: 'P1', t: 1000, set: { leftWrist: { dy: -0.1 } } }], ctx);
  const q1 = createEvaluator(fixed, fixed.dancers[0], { takes: lookup }), q2 = createEvaluator(fixed, fixed.dancers[1], { takes: lookup });
  assert.ok(Math.abs(q1.rig(5000).points.leftWrist[1] - (a[1] - 0.1)) < 1e-4);
  assert.ok(Math.abs(q2.rig(5000).points.rightWrist[1] - (a[1] - 0.1)) < 1e-4);
  // A repeat may start exactly where the stretch it copies ends, tenths of a millisecond and all.
  assert.doesNotThrow(() => applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', start: 0, end: 4000 },
    { op: 'clip', dancer: 'P1', ref: { range: [420.4, 4000] }, start: 4000 }], ctx));
  // A clip can't be linked to a stretch that plays it.
  assert.throws(() => applyOps(linked, [{ op: 'clip', dancer: 'P1', ref: { range: '3000:5000' }, start: 4500, replace: false }], ctx), /loop of linked clips/);
  assert.throws(() => applyOps(linked, [{ op: 'clip', dancer: 'P1', ref: { dancer: 'P2', range: '0:2000' }, start: 500, replace: false }], ctx), /loop of linked clips/);
  // Removing a dancer removes the clips linked to it.
  const { dance: solo } = applyOps(linked, [{ op: 'dancer', action: 'remove', dancer: 'P1' }], ctx);
  assert.equal(solo.dancers[0].clips.length, 0);
});

test('a clip eases to what is beneath across a gap in its take, and the gap is reported', () => {
  const source = performer(), take = capture(source, { drop: t => t > 2500 && t < 3500 });
  const { dance, ctx, lookup } = stage({ k1: take });
  const { dance: placed } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', fadeIn: 0, fadeOut: 0 }], ctx);
  const e = createEvaluator(placed, placed.dancers[0], { takes: lookup }), neutral = createEvaluator(placed, placed.dancers[0], { clips: false }).rig(0).points.leftWrist;
  assert.ok(dist(e.rig(3000).points.leftWrist, neutral) < 1e-6, 'in the gap: what is beneath');
  let last = e.rig(2300).points.leftWrist;
  for (let t = 2310; t <= 3700; t += 10) { const p = e.rig(t).points.leftWrist; assert.ok(dist(p, last) < 0.04, `no pop at ${t}`); last = p; }
  const findings = checkDance(placed, { takes: lookup });
  const lost = findings.find(f => f.kind === 'tracking-lost');
  assert.ok(lost && lost.startMs > 2300 && lost.endMs < 3700, JSON.stringify(findings.map(f => [f.kind, f.startMs, f.endMs])));
  // Blending in and out of the gap isn't a keyed-animation mistake: nothing else is reported there.
  assert.deepEqual(findings.filter(f => f.severity !== 'info').map(f => f.kind), ['tracking-lost']);
  assert.equal(checkDance(placed).some(f => f.kind === 'missing-take'), true);
  // Standing still in the gap isn't choreography: it compiles unscored, and scored either side.
  const compiled = compileDance(placed, { takes: lookup });
  const scoredAt = (ms: number) => compiled.timeline.samples.reduce((best, s) => Math.abs(s.songTimeMs - ms) < Math.abs(best.songTimeMs - ms) ? s : best).quality[0].scoreEligible.some(Boolean);
  assert.deepEqual([1000, 3000, 5000].map(scoredAt), [true, false, true]);
  // The finding's "leave unscored" settles it.
  const { dance: decided } = applyOps(placed, lost.actions![0].ops, ctx);
  assert.equal(checkDance(decided, { takes: lookup }).some(f => f.kind === 'tracking-lost'), false);
});

test('compiling plays clips, leaves a take\'s unsure joints unscored until approved, and needs the takes', () => {
  const source = performer(), LEFT_ARM = [13, 15, 17, 19, 21];
  const take = capture(source, { unsure: t => t >= 2000 && t <= 3000 ? LEFT_ARM : [] });
  const { dance, ctx, lookup } = stage({ k1: take });
  const { dance: placed } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', fadeIn: 0, fadeOut: 0 }], ctx);
  assert.throws(() => compileDance(placed), /Take k1 isn't loaded/);
  const compiled = compileDance(placed, { takes: lookup });
  const at = (ms: number, c = compiled) => c.timeline.samples.reduce((best, s) => Math.abs(s.songTimeMs - ms) < Math.abs(best.songTimeMs - ms) ? s : best);
  assert.equal(at(2500).quality[0].scoreEligible[15], false);
  assert.equal(at(2500).quality[0].scoreEligible[16], true);
  assert.equal(at(1000).quality[0].scoreEligible[15], true);
  assert.equal(at(1000).quality[0].landmarkOrigins[15], 'measured');
  // The compiled frames reproduce the take's 30 fps motion with about a frame per take frame, not 60 Hz.
  assert.ok(compiled.stats.frames < 8000 / (1000 / 30) * 1.3, `${compiled.stats.frames} frames`);
  const finding = checkDance(placed, { takes: lookup }).find(f => f.kind === 'unsure-tracking');
  assert.ok(finding && finding.control === 'leftArm' && Math.abs(finding.startMs - 2000) < 150 && Math.abs(finding.endMs - 3000) < 150, JSON.stringify(finding));
  // The finding's own "looks right" action clears it.
  assert.equal(finding.actions?.[0].ops[0].op, 'approve');
  const { dance: approved } = applyOps(placed, finding.actions![0].ops, ctx);
  assert.equal(at(2500, compileDance(approved, { takes: lookup })).quality[0].scoreEligible[15], true);
  assert.equal(checkDance(approved, { takes: lookup }).some(f => f.kind === 'unsure-tracking'), false);
  // Dancing the take back scores as a near-perfect match in the game's scorer.
  const bundle = gameBundle(approved, undefined, lookup), scorer = createScorer(bundle, 1, [0]);
  const player = createEvaluator(source, source.dancers[0]);
  for (let t = 0; t <= 8000; t += 1000 / 15) scorer.addSample(0, t, player.landmarks(t), 16 / 9);
  scorer.finish();
  assert.ok(scorer.result(0).accuracy > 0.95, `accuracy ${scorer.result(0).accuracy}`);
});

test('a performer who walks into view after the take starts eases in, and slipping a clip moves its motion, not the clip', () => {
  const source = performer(), take = capture(source, { drop: t => t < 2000 || t > 6000 });
  const { dance, ctx, lookup } = stage({ k1: take });
  const { dance: placed } = applyOps(dance, [{ op: 'clip', dancer: 'P1', take: 'k1', place: 'frame', fadeIn: 0, fadeOut: 0 }], ctx);
  const e = createEvaluator(placed, placed.dancers[0], { takes: lookup });
  let last = e.rig(1800).points.leftWrist;
  for (let t = 1810; t <= 6300; t += 10) { const p = e.rig(t).points.leftWrist; assert.ok(dist(p, last) < 0.04, `no pop at ${t}`); last = p; }
  const { dance: slipped } = applyOps(placed, [{ op: 'clip', dancer: 'P1', action: 'update', id: 'clip1', slip: 40 }], ctx);
  const before = placed.dancers[0].clips[0], after = slipped.dancers[0].clips[0];
  assert.deepEqual([after.startMs, after.endMs], [before.startMs, before.endMs]);
  const s = createEvaluator(slipped, slipped.dancers[0], { takes: lookup });
  assert.ok(dist(s.rig(3540).points.leftWrist, e.rig(3500).points.leftWrist) < 1e-6, 'everything happens 40 ms later');
});
