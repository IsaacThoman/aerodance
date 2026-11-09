import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, clusterBootstrap, hungarian, loadScene, round, torsoScale } from './common.ts';
import type { GtPerson, Scene, TrackedFrame } from './common.ts';
import { gaussian, perfectDetections, writeFixtureScene } from './fixtures.ts';
import type { FixtureOptions } from './fixtures.ts';
import { accumulateOffsets, finishOffsets, sceneMetrics, trackedMetrics, zeroOffsets } from './metrics.ts';
import { trackDetections } from './track.ts';
import { COLUMNS, buildReport, rowOf } from './report.ts';
import { GameLoop } from './gameloop.ts';
import { nextFrame } from './run-game.ts';

const solo: FixtureOptions = { id: 'solo', people: [{ id: 'p1', at: () => [0, 0] }] };
const duo: FixtureOptions = { id: 'duo', people: [{ id: 'a', at: () => [-0.6, 0] }, { id: 'b', at: () => [0.6, 0.1] }] };
const scenes = new Map<string, Scene>();
const scene = (o: FixtureOptions) => { if (!scenes.has(o.id!)) scenes.set(o.id!, loadScene(o.id!, writeFixtureScene(o))); return scenes.get(o.id!)!; };

/** Detections → the game's tracker → metrics, with offsets learnt from the same detections. */
function run(s: Scene, dets = perfectDetections(s.gt), { offsets = true } = {}) {
  const tracked = trackDetections(s, dets);
  const sums = zeroOffsets();
  if (offsets) accumulateOffsets(s, dets, sums);
  return { tracked, m: sceneMetrics(s, dets, tracked, offsets ? finishOffsets(sums) : null) };
}

test('hungarian finds the cheapest assignment and respects the gate', () => {
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  // (Minimum total: the third row's 0.5 and the second's 1 beat the first two rows' 1 + 1.)
  assert.deepEqual(hungarian([[1, 9], [9, 1], [0.5, 0.6]]), [-1, 1, 0]);
  assert.deepEqual(hungarian([[5, 0.2]], 1), [1]);
  assert.deepEqual(hungarian([[5, 3]], 1), [-1]);
  assert.deepEqual(hungarian([[Infinity, 0.3], [0.4, Infinity]]), [1, 0]);
});

test('the fixture GT is self-consistent: the torso scale matches the projected torso', () => {
  const s = scene(solo);
  assert.equal(s.focalSource, 'hfov');
  const p = s.gt[0].people[0];
  const proj = Math.hypot(((p.kp[11][0] + p.kp[12][0]) - (p.kp[23][0] + p.kp[24][0])) / 2 * s.aspect, ((p.kp[11][1] + p.kp[12][1]) - (p.kp[23][1] + p.kp[24][1])) / 2);
  assert.ok(Math.abs(torsoScale(p, s) / proj - 1) < 0.03, `${torsoScale(p, s)} vs ${proj}`);
});

test('a perfect estimator (GT as detections) scores ~100% everywhere, and the GT score', () => {
  for (const o of [solo, duo]) {
    const { m } = run(scene(o));
    const kp = m.detection.keypoints;
    assert.equal(m.detection.recall.players, 1, o.id);
    assert.equal(kp.body.pck10, 1);
    assert.ok(kp.body.error.mean! < 1e-6);
    assert.ok(kp.limbs.mean_deg_weighted! < 0.01);
    assert.equal(kp.swaps.body, 0);
    assert.equal(m.tracking.after_numbering.identity_accuracy, 1, o.id);
    // (With two players somebody new counts after two results, so the first is lost.)
    assert.equal(m.tracking.after_numbering.lost, 0);
    assert.ok(m.tracking.whole_scene.lost! <= 1 / 300 + 1e-9);
    assert.equal(m.tracking.identity_switches, 0);
    assert.equal(m.tracking.numbering?.correct, true);
    assert.ok(m.tracking.all_tracked_delay_ms! <= 100, `delay ${m.tracking.all_tracked_delay_ms}`);
    assert.ok(m.calibration?.complete_ms !== null && m.calibration!.complete_before_dance, JSON.stringify(m.calibration));
    const sc = m.score!;
    assert.ok(sc.gt_score > 970_000, `gt ${sc.gt_score}`);
    assert.ok(Math.abs(sc.score_lost) <= 2000, `lost ${sc.score_lost}`);
    assert.equal(sc.judgements.downgraded, 0);
    assert.equal(m.detection.false_positives_per_100_frames.noise, 0);
  }
});

test('P1 is the player on the right of the raw frame (the left of the mirrored preview)', () => {
  const { m, tracked } = run(scene(duo));
  assert.deepEqual(m.expected_numbering.mapping, ['b', 'a']);
  const s = scene(duo);
  const r = tracked.find(t => t.lined)!;
  const p1 = r.poses.find(p => p.playerId === 0)!;
  const b = s.byFrame.get(r.frame)!.people.find(p => p.id === 'b')!;
  assert.ok(Math.abs(p1.kp[11][0] - b.kp[11][0]) < 1e-9);
});

test('a known offset is measured raw and removed by the offset correction; noise gives the Rayleigh mean', () => {
  const s = scene(solo);
  // 0.08 torso lengths toward the camera's right (the person's left: they face the camera).
  const shift = (p: GtPerson): [number, number] => [0.08 * torsoScale(p, s) / s.aspect, 0];
  const { m } = run(s, perfectDetections(s.gt, { perturb: p => shift(p) }));
  const body = m.detection.keypoints.body;
  assert.ok(Math.abs(body.error.mean! - 0.08) < 0.002, `raw ${body.error.mean}`);
  assert.ok(body.error_corrected.mean! < 0.005, `corrected ${body.error_corrected.mean}`);
  assert.equal(body.pck10, 1);
  // Isotropic Gaussian noise of sigma per axis (torso lengths): mean error sigma * sqrt(pi / 2).
  const sigma = 0.05, g = gaussian(7);
  const noisy = run(s, perfectDetections(s.gt, { perturb: p => { const k = torsoScale(p, s); return [g() * sigma * k / s.aspect, g() * sigma * k]; } }));
  const e = noisy.m.detection.keypoints.body.error.mean!;
  assert.ok(Math.abs(e - sigma * Math.sqrt(Math.PI / 2)) < 0.004, `noise ${e}`);
  // PCK@0.1 for a Rayleigh(sigma): 1 - exp(-0.1^2 / (2 sigma^2)).
  assert.ok(Math.abs(noisy.m.detection.keypoints.body.pck10! - (1 - Math.exp(-0.01 / (2 * sigma * sigma)))) < 0.02);
  // Noise is jitter: the pose's acceleration error is about sqrt(6) sigma per axis pair.
  assert.ok(noisy.m.detection.jitter.accel_error.mean! > 2 * sigma, JSON.stringify(noisy.m.detection.jitter));
  assert.ok(run(s).m.detection.jitter.accel_error.mean! < 1e-6);
});

test('left/right label swaps are detected', () => {
  const s = scene(solo);
  const { m } = run(s, perfectDetections(s.gt, { mirrorLabels: (_, f) => f.frame % 4 === 0 }));
  const swaps = m.detection.keypoints.swaps;
  assert.ok(Math.abs(swaps.body! - 0.25) < 0.02, JSON.stringify(swaps));
  assert.ok(Math.abs(swaps.arms! - 0.25) < 0.05);
});

test('swapped identities are detected', () => {
  const s = scene(duo);
  const { tracked } = run(s);
  // Exchange the two players' poses for a stretch after they're numbered.
  const from = 200, to = 230;
  const swapped: TrackedFrame[] = tracked.map(r => r.frame >= from && r.frame < to ? { ...r, poses: r.poses.map(p => ({ ...p, playerId: 1 - p.playerId })).sort((a, b) => a.playerId - b.playerId) } : r);
  const m = sceneMetrics(s, perfectDetections(s.gt), swapped, null);
  assert.equal(m.tracking.identity_switches, 4);
  const frames = m.tracking.after_numbering.player_frames;
  assert.ok(Math.abs(m.tracking.after_numbering.wrong_player! - 2 * (to - from) / frames) < 1e-4, JSON.stringify(m.tracking.after_numbering));
  assert.ok(m.score!.score_lost > 20_000, `lost ${m.score!.score_lost}`);
  assert.ok(m.score!.judgements.downgraded > 0);
});

test('a missing player is counted lost, and costs score', () => {
  const s = scene(duo);
  // Player "a" isn't detected for two seconds in the dance.
  const gap = (t: number) => t >= 6000 && t < 8000;
  const { m } = run(s, perfectDetections(s.gt, { drop: (p, f) => p.id === 'a' && gap(f.t_ms) }));
  const missing = s.gt.filter(f => gap(f.t_ms)).length;
  // The tracker holds nobody for them: every one of those frames is lost (and the first one
  // back, and the very first frame, since somebody new counts after two results).
  assert.equal(m.tracking.whole_scene.lost, round((missing + 3) / m.tracking.whole_scene.player_frames));
  assert.ok(Math.abs(m.detection.recall.players! - (1 - missing / m.detection.recall.player_frames)) < 1e-9);
  // They're found again afterwards, as themselves.
  assert.equal(m.tracking.identity_switches, 0);
  const a = m.score!.players.find(p => p.gt_person === 'a')!, b = m.score!.players.find(p => p.gt_person === 'b')!;
  assert.ok(a.lost > 200_000, `a lost ${a.lost}`);
  assert.ok(Math.abs(b.lost) < 2000);
  assert.ok(a.tracked_judgements.lost >= 1);
});

test('a bystander walking past is counted as a bystander, not a player', () => {
  const o: FixtureOptions = { id: 'byst', people: [{ id: 'p1', at: () => [0, 0] }, { id: 'x', role: 'bystander', at: t => [-2 + 0.5 * t, 1.5], absent: t => t < 5 }] };
  const s = scene(o);
  const { m } = run(s);
  assert.equal(m.players, 1);
  assert.ok(m.detection.recall.bystanders! > 0.9);
  assert.equal(m.tracking.after_numbering.identity_accuracy, 1);
  assert.equal(m.detection.false_positives_per_100_frames.noise, 0);
});

test('a two-person duplicate detection counts as a duplicate false positive', () => {
  const s = scene(solo);
  const dets = perfectDetections(s.gt).map(f => f.frame % 2 ? f : { ...f, people: [...f.people, { score: 1, kp: f.people[0].kp.map(j => j && [j[0] + 0.02, j[1] + 0.15, 0, 0.9] as [number, number, number, number]) }] });
  const { m } = run(s, dets);
  assert.ok(Math.abs(m.detection.false_positives_per_100_frames.duplicate! - 50) < 1, JSON.stringify(m.detection.false_positives_per_100_frames));
  assert.equal(m.tracking.after_numbering.identity_accuracy, 1);
});

test('realtime records the game drops as too old are not tracked', () => {
  const s = scene(solo);
  const dets = perfectDetections(s.gt).map(f => ({ ...f, received_ms: f.t_ms + (f.frame % 10 === 0 ? 600 : 40) }));
  const tracked = trackDetections(s, dets);
  assert.equal(tracked.filter(r => r.dropped).length, s.gt.filter(f => f.frame % 10 === 0).length);
  assert.ok(tracked.filter(r => r.dropped).every(r => r.poses.length === 0));
});

test('the report aggregates scenes and estimators, with deltas and worst scenes', () => {
  const s = scene(duo);
  const good = run(s).m, bad = run(s, perfectDetections(s.gt, { drop: (p, f) => p.id === 'a' && f.t_ms > 5000 })).m;
  const row = (estimator: string, m: typeof good, sceneId: string) => rowOf(estimator, sceneId, m);
  const rows = [row('perfect', good, 'duo'), row('dropping', bad, 'duo'), row('perfect', good, 'duo2')];
  const { markdown, json } = buildReport(rows, 'perfect', 3);
  const dropping = json.summary.find(x => x.estimator === 'dropping')!;
  assert.ok(dropping.deltas!.score_lost.delta! > 100_000);
  assert.ok(dropping.deltas!.lost.delta! > 0.1);
  assert.equal(json.summary.find(x => x.estimator === 'perfect')!.scenes, 2);
  assert.match(markdown, /## By category/);
  assert.equal(json.worst.dropping.score_lost[0].scene, 'duo');
});

test('realtime: a busy worker gets the newest frame that came meanwhile, as WebcamPoseSource sends it', () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000 / 30 }));
  // Idle: the next frame, when it comes.
  assert.deepEqual(nextFrame(frames, 0, -Infinity), { k: 0, sentAt: 0, skipped: 0 });
  assert.deepEqual(nextFrame(frames, 1, 20), { k: 1, sentAt: frames[1].t, skipped: 0 });
  // Busy until 80 ms: frames 1 (33 ms) and 2 (67 ms) came; 2 waited and replaced 1.
  assert.deepEqual(nextFrame(frames, 1, 80), { k: 2, sentAt: 80, skipped: 1 });
  // A result exactly when a frame arrives takes it.
  assert.deepEqual(nextFrame(frames, 3, 100), { k: 3, sentAt: 100, skipped: 0 });
  // Busy past the end: the last frame.
  assert.deepEqual(nextFrame(frames, 5, 1e6), { k: 9, sentAt: 1e6, skipped: 4 });
});

test('a setup line-up retry clears a partial calibration hold with the old player numbers', () => {
  const s = scene(duo);
  const loop = new GameLoop(2, { width: s.width, height: s.height });
  loop.tick(0);
  const tracker = loop.tracker;
  const landmarks = s.gt[0].people[0].kp.map(([x, y]) => ({ x, y, z: 0, confidence: 1 }));
  loop.calibration.accept({ sessionId: 'retry', seq: 1, input: loop.input, poses: [{ playerId: 0, landmarks }] }, 1000, 1000);
  assert.equal(loop.calibration.holds[0].startedAt, 1000);
  assert.equal(loop.calibration.anchors, null, 'a partial hold does not delay the retry');
  loop.tick(4000);
  assert.notEqual(loop.tracker, tracker);
  assert.ok(loop.calibration.holds.every(h => h.startedAt === null && h.frames.length === 0));
  assert.deepEqual(loop.calibration.players, ['missing', 'missing']);
});

test('report: a failure is counted and listed, and deltas are paired over the scenes both have', () => {
  const s = scene(solo);
  const m = run(s).m;
  const row = (estimator: string, sceneId: string, calib: number | null) => {
    const r = rowOf(estimator, sceneId, m);
    return { ...r, values: { ...r.values, calib }, failed: { ...r.failed, calib: calib === null } };
  };
  // The audit's counterexample: the candidate fails scene a, and is the same on b.
  const { markdown, json } = buildReport([row('base', 'a', 1000), row('base', 'b', 3000), row('candidate', 'a', null), row('candidate', 'b', 3000)], 'base', 3);
  const cand = json.summary.find(x => x.estimator === 'candidate')!;
  assert.equal(cand.deltas!.calib.delta, 0);
  assert.equal(cand.deltas!.calib.pairs, 1);
  assert.equal(cand.deltas!.calib.fails, 1);
  assert.equal(cand.fails.calib, 1);
  assert.deepEqual(json.worst.candidate.calib[0], { scene: 'a', value: null, failed: true });
  assert.match(markdown, /\(\+1 fail\)/);
});

test('cluster bootstrap: singletons give the plain bootstrap; scenes sharing a render widen the interval', () => {
  const g = gaussian(3);
  const diffs = Array.from({ length: 30 }, () => g());
  assert.deepEqual(clusterBootstrap(diffs, diffs.map((_, i) => i)), bootstrap(diffs));
  // The same 10 values, each three times: as 30 independent scenes the interval is too narrow.
  const ten = diffs.slice(0, 10), tripled = [...ten, ...ten, ...ten];
  const [lo1, hi1] = bootstrap(tripled), [lo3, hi3] = clusterBootstrap(tripled, tripled.map((_, i) => i % 10));
  assert.ok(hi3 - lo3 > 1.4 * (hi1 - lo1), `${hi3 - lo3} vs ${hi1 - lo1}`);
});

test('the time grid counts a sparse stream as lost between its records, and a dropped-only one as lost', () => {
  const s = scene(solo);
  // Every tenth frame (a pose every 333 ms): per record nothing is lost, on the grid the gaps are.
  const sparse = run(s, perfectDetections(s.gt).filter(f => f.frame % 10 === 1)).m;
  assert.ok(sparse.tracking.whole_scene.lost! < 0.01, JSON.stringify(sparse.tracking.whole_scene));
  const grid = sparse.tracking.time_grid;
  assert.ok(grid.whole_scene.lost! > 0.05 && grid.whole_scene.lost! < 0.15, JSON.stringify(grid));
  assert.ok(grid.max_lost_gap_ms! > 0);
  // Every frame: the grid and the records agree.
  const full = run(s).m.tracking;
  assert.ok(Math.abs(full.time_grid.whole_scene.lost! - full.whole_scene.lost!) < 0.005);
  assert.equal(full.time_grid.after_numbering.identity_accuracy, 1);
  // Nothing delivered: everything lost, not a missing value.
  const dropped = trackedMetrics(s, [{ frame: 181, t_ms: 6000, received_ms: 6600, poses: [], lined: false, dropped: true }], ['p1']);
  assert.equal(dropped.whole_scene.lost, null);
  assert.equal(dropped.time_grid.whole_scene.lost, 1);
});

test('jitter uses consecutive delivered samples and their timestamps, so a 15 fps stream has some', () => {
  const s = scene(solo);
  const g = gaussian(11), sigma = 0.02;
  const noisy = perfectDetections(s.gt, { perturb: p => { const k = torsoScale(p, s); return [g() * sigma * k / s.aspect, g() * sigma * k]; } });
  const every = run(s, noisy).m.detection.jitter, half = run(s, noisy.filter(f => f.frame % 2 === 1)).m.detection.jitter;
  assert.ok(half.accel_error.n > 0);
  assert.equal(half.unit, 'torso lengths per s^2');
  // The same noise at half the rate is a quarter of the acceleration (gaps twice as long).
  const ratio = half.accel_error.mean! / every.accel_error.mean!;
  assert.ok(ratio > 0.18 && ratio < 0.35, `ratio ${ratio}`);
});
