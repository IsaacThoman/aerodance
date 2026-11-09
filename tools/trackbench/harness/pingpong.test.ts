import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { focalLength } from '../../../apps/web/src/minigames/table-tennis/arms.ts';
import type { Vec3 } from '../../../apps/web/src/minigames/table-tennis/arms.ts';
import { workerSettings } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import { REPO, bootstrap, clusterBootstrap } from './common.ts';
import { compare } from './pp-report.ts';
import type { Row } from './pp-report.ts';
import type { DetFrame, GtFrame, GtJoint, GtPerson, Joint, Point3, Scene, TrackedFrame } from './common.ts';
import { GameLoop, toDetected } from './gameloop.ts';
import {
  bestLag, bladeOf, gtArm, invertRigid, jitter, motionStates, pingpongScene, quantile, raiseAgreement, raisedStates,
  speeds, stageToCamera, vectorStats, wantedSides,
} from './pingpong.ts';
import { gameInit, parseDetail, parseInputSize, resolveDetail } from './run-game.ts';

// ---------------------------------------------------------------- the worker's messages

test('run-game sets the worker up as WebcamPoseSource.connect does, unless an experiment flag says otherwise', () => {
  for (const n of [1, 2, 3, 4]) assert.deepEqual(gameInit(n), workerSettings(n));
  // What connect asked for when run-game had its own copy (a change here is a change to the game's tracking).
  assert.deepEqual(workerSettings(1), { playerCount: 1, looks: false, zoom: true });
  assert.deepEqual(workerSettings(2), { playerCount: 2, looks: true, search: true });
  assert.equal(workerSettings(3).playerCount, 4);
  assert.equal(workerSettings(3).tiles?.length, 3);
  assert.deepEqual(gameInit(2, { 'no-search': true }), { playerCount: 2, looks: true });
  assert.deepEqual(gameInit(1, { 'no-strips': true }), { playerCount: 1, looks: false });
  // WebcamPoseSource itself builds its messages with the shared functions (not copies of them).
  const source = readFileSync(`${REPO}packages/pose/browser/WebcamPoseSource.ts`, 'utf8');
  assert.match(source, /type: 'initialize', sessionId: this\.sessionId, \.\.\.workerSettings\(this\.playerCount\)/);
  assert.match(source, /postMessage\(detailRequest\(this\.detail, this\.playerCount, this\.handsWanted,/);
  assert.match(source, /type: 'frame', bitmap, seq: pending\.seq, timestampMs: mediaTimeMs, players: this\.players, lined: this\.tracker\.lined/);
});

test('--detail minigame:table-tennis asks what the minigame asks for', async () => {
  assert.equal(await resolveDetail('minigame:table-tennis', 1), 'hands');
  assert.equal(await resolveDetail('minigame:table-tennis', 2), 'hands:right/right');
  assert.equal(await resolveDetail('world', 2), 'world');
  await assert.rejects(resolveDetail('minigame:nope', 1));
});

test('--detail and --input-size parse as the game names them', () => {
  assert.equal(parseDetail(undefined), null);
  assert.equal(parseDetail('none'), null);
  assert.equal(parseDetail('hands:right/left'), 'hands:right/left');
  assert.throws(() => parseDetail('hands:paddle'));
  assert.deepEqual(parseInputSize('640x480'), { width: 640, height: 480 });
  assert.throws(() => parseInputSize('640'));
  assert.deepEqual(wantedSides('hands', 0), ['left', 'right']);
  assert.deepEqual(wantedSides('hands:right/left', 1), ['left']);
  assert.deepEqual(wantedSides('hands:right', 1), ['right']);
  assert.deepEqual(wantedSides('world', 0), []);
});

// ---------------------------------------------------------------- the game loop's extras and hand drop

const person = (x: number): DetFrame['people'][number] => {
  const kp: Joint[] = Array.from({ length: 33 }, () => [x, 0.5, 0, 0.9]);
  kp[11] = [x + 0.05, 0.35, 0, 0.9]; kp[12] = [x - 0.05, 0.35, 0, 0.9]; kp[23] = [x + 0.03, 0.6, 0, 0.9]; kp[24] = [x - 0.03, 0.6, 0, 0.9];
  return { kp };
};
const world = Array.from({ length: 33 }, (_, i): Point3 => [i * 0.01, -i * 0.01, 0]);
const hand = { side: 'right' as const, score: 0.9, kp: Array.from({ length: 21 }, (): Point3 => [0.4, 0.5, 0]), world: Array.from({ length: 21 }, (): Point3 => [0, 0, 0]) };

test('with a detail, the tracker keeps each pose\'s world landmarks and hands; without one, neither', () => {
  const line: DetFrame = { frame: 1, t_ms: 0, people: [person(0.5)], world: [world], hands: [[hand]] };
  const withDetail = new GameLoop(1, { width: 640, height: 480 }, { session: false, detail: 'hands' }).replay(line);
  assert.deepEqual(withDetail.poses[0].world, world);
  assert.equal(withDetail.poses[0].hands?.[0].side, 'right');
  assert.deepEqual(withDetail.poses[0].hands?.[0].kp[0], [0.4, 0.5, 0]);
  const worldOnly = new GameLoop(1, { width: 640, height: 480 }, { session: false, detail: 'world' }).replay(line);
  assert.ok(worldOnly.poses[0].world && !worldOnly.poses[0].hands);
  const none = new GameLoop(1, { width: 640, height: 480 }, { session: false }).replay(line);
  assert.ok(!none.poses[0].world && !none.poses[0].hands);
});

test('two people\'s hands are dropped after four seconds under 15 poses a second, as WebcamPoseSource.watchHands does', () => {
  const loop = new GameLoop(2, { width: 640, height: 480 }, { session: false, detail: 'hands:right' });
  const one = new GameLoop(1, { width: 640, height: 480 }, { session: false, detail: 'hands' });
  assert.ok(loop.handsWanted);
  // 10 results a second.
  for (let t = 0; t <= 6000; t += 100) {
    loop.result(1, [toDetected(person(0.3).kp), toDetected(person(0.7).kp)], [null, null], t, t + 50);
    one.result(1, [toDetected(person(0.5).kp)], [null], t, t + 50);
  }
  assert.ok(loop.handsDropped && !loop.handsWanted);
  // Slow from the second result (150 ms), dropped four seconds later.
  assert.equal(loop.handsDroppedAt, 4150);
  // One player's never drop.
  assert.ok(one.handsWanted && !one.handsDropped);
  assert.equal(new GameLoop(3, { width: 640, height: 480 }, { detail: 'hands' }).handsWanted, false);
});

// ---------------------------------------------------------------- statistics and series

test('vectorStats separates bias from scatter', () => {
  const errors: Vec3[] = Array.from({ length: 100 }, (_, i) => ({ x: 0.1, y: i % 2 ? 0.02 : -0.02, z: 0 }));
  const s = vectorStats(errors);
  assert.equal(s.x.bias, 10);
  assert.equal(s.x.sd, 0);
  assert.equal(s.y.bias, 0);
  assert.ok(Math.abs(s.y.sd! - 2.01) < 0.01);
  assert.equal(s.y.median_abs, 2);
  assert.ok(Math.abs(s.median! - Math.hypot(10, 2)) < 0.01);
  assert.equal(s.unbiased_median, 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
});

const times = Array.from({ length: 300 }, (_, i) => i * 1000 / 30);
const circle = (t: number): Vec3 => ({ x: 0.3 * Math.cos(t / 400), y: 0.2 * Math.sin(t / 300), z: -0.1 * Math.sin(t / 500) });

test('bestLag finds how far a path trails another', () => {
  const gt = times.map(circle);
  for (const lag of [0, 66.7, 120]) {
    const r = bestLag(times, times.map(t => circle(t - lag)), times, gt)!;
    assert.ok(Math.abs(r.lag_ms - lag) < 3, `${r.lag_ms} vs ${lag}`);
  }
  // A steady offset doesn't count; too little movement can't be timed.
  assert.ok(Math.abs(bestLag(times, times.map(t => ({ ...circle(t - 50), x: circle(t - 50).x + 0.2 })), times, gt)!.lag_ms - 50) < 3);
  assert.equal(bestLag(times, times.map(() => ({ x: 0, y: 0, z: 0 })), times, times.map(() => ({ x: 0.001, y: 0, z: 0 }))), null);
});

test('jitter measures shaking about the path, not movement', () => {
  const still = times.map((_, i) => ({ x: i % 2 ? 0.01 : -0.01, y: 0, z: 0 }));
  const all = times.map(() => true);
  assert.ok(Math.abs(jitter(times, still, all).rms! - 0.01) < 0.001);
  // A steady glide has none.
  const glide = times.map(t => ({ x: t / 1000 * 0.05, y: 0, z: 0 }));
  assert.ok(jitter(times, glide, all).rms! < 1e-6);
  assert.equal(jitter(times, still, times.map(() => false)).rms, null);
});

test('motion states by speed, with peaks at a swing\'s local maximum', () => {
  const swing = times.map(t => ({ x: t < 3000 ? 0 : 0.5 * Math.sin((t - 3000) / 1000 * Math.PI * 2 / 2), y: 0, z: 0 }));
  const v = speeds(times, swing);
  const st = motionStates(times, v);
  assert.equal(st[30], 'rest');
  // Speed 0.5π m/s at its fastest: a swing, peaking twice a cycle.
  assert.ok(st.slice(100).includes('swing') && st.slice(100).includes('peak'));
  assert.ok(Math.abs(Math.max(...v.filter(Number.isFinite)) - 0.5 * Math.PI) < 0.02);
});

test('raises follow the game\'s hysteresis; false triggers and misses are counted as events', () => {
  assert.deepEqual(raisedStates([0, 0.05, 0, -0.05, -0.2, 0.05, null, 0.05]), [false, true, true, true, false, true, false, true]);
  const t = Array.from({ length: 100 }, (_, i) => i * 100);
  const gt = t.map(x => (x >= 2000 && x < 3000) || (x >= 6000 && x < 7000));
  const game = t.map(x => (x >= 2200 && x < 3100) || (x >= 8500 && x < 8800));
  const a = raiseAgreement(t, gt, game);
  assert.equal(a.gt_raises, 2); assert.equal(a.game_raises, 2);
  assert.equal(a.false_triggers, 1); assert.equal(a.misses, 1);
  assert.equal(a.onset_delay_ms.median, 200);
});

test('stage to camera: a camera at (0, -3, 1.2) looking down +y, as the generator places it', () => {
  const c2w = [1, 0, 0, 0, 0, 0, -1, -3, 0, 1, 0, 1.2, 0, 0, 0, 1];
  const p = stageToCamera(invertRigid(c2w), [0.5, 1, 1.0]);
  // 0.5 m to the right, 0.2 m below the lens, 4 m away.
  assert.ok(Math.abs(p.x - 0.5) < 1e-9 && Math.abs(p.y - 0.2) < 1e-9 && Math.abs(p.z - 4) < 1e-9, JSON.stringify(p));
});

// ---------------------------------------------------------------- a synthetic scene end to end

/*
 * One player 2.5 m from a 65° camera, built as arms.ts assumes people are (a 50 cm torso, 31 cm
 * upper arms, 25 cm forearms, square to the camera), the right forearm sweeping in front of them:
 * tracked exactly, handPose puts the wrist where it is; tracked a few frames late, the lag shows.
 */
const W = 640, HT = 480, FPS = 30, f = focalLength(W, 65);
const C2W = [1, 0, 0, 0, 0, 0, -1, -2.5, 0, 1, 0, 1.0, 0, 0, 0, 1];
const camToStage = (p: Vec3): Point3 => { const [xb, yb, zb] = [p.x, -p.y, -p.z]; return [xb + C2W[3], C2W[7] - zb, yb + C2W[11]]; };
function body(t: number): Vec3[] {
  const hip: Vec3 = { x: 0, y: 0.1, z: 2.5 };
  const pts: Vec3[] = Array.from({ length: 33 }, () => ({ ...hip, y: hip.y - 0.65 }));
  const at = (o: Vec3): Vec3 => ({ x: hip.x + o.x, y: hip.y + o.y, z: hip.z + o.z });
  pts[23] = at({ x: 0.12, y: 0, z: 0 }); pts[24] = at({ x: -0.12, y: 0, z: 0 });
  pts[11] = at({ x: 0.19, y: -0.5, z: 0 }); pts[12] = at({ x: -0.19, y: -0.5, z: 0 });
  for (const [s, e, w, i, p, sign] of [[11, 13, 15, 19, 17, 1], [12, 14, 16, 20, 18, -1]] as const) {
    // Upper arm forward-down; forearm swinging forward and across (right) or hanging forward (left).
    const up = { x: 0, y: Math.cos(0.9), z: -Math.sin(0.9) };
    pts[e] = { x: pts[s].x + up.x * 0.31, y: pts[s].y + up.y * 0.31, z: pts[s].z + up.z * 0.31 };
    const a = sign < 0 ? 0.8 * Math.sin(t / 1000 * Math.PI) : 0;
    const fore = { x: Math.sin(a) * 0.7 * -sign, y: -0.2, z: -Math.cos(a) * 0.7 };
    const l = Math.hypot(fore.x, fore.y, fore.z);
    pts[w] = { x: pts[e].x + fore.x / l * 0.25, y: pts[e].y + fore.y / l * 0.25, z: pts[e].z + fore.z / l * 0.25 };
    pts[i] = { x: pts[w].x + 0.02 * sign, y: pts[w].y - 0.02, z: pts[w].z - 0.07 }; pts[p] = { x: pts[w].x - 0.02 * sign, y: pts[w].y - 0.02, z: pts[w].z - 0.07 };
  }
  return pts;
}
const project = (p: Vec3) => [0.5 + p.x * f / p.z / W, 0.5 + p.y * f / p.z / HT];
function syntheticScene(): Scene {
  const gt: GtFrame[] = Array.from({ length: 10 * FPS }, (_, i) => {
    const t = i * 1000 / FPS, pts = body(t);
    const p: GtPerson = { id: 'p1', role: 'player', index: 0, kp: pts.map(q => [...project(q), q.z, 0] as GtJoint), kp3d: pts.map(camToStage),
      bbox: [0.3, 0.1, 0.7, 0.9], visible_frac: 1, in_frame: true, phase: 'swing' };
    return { frame: i + 1, t_ms: t, people: [p] };
  });
  const camera_to_world = Object.fromEntries(gt.map(g => [String(g.frame), C2W]));
  return { id: 'synthetic-pp', dir: '', spec: { players: 1 }, meta: { camera_to_world, camera: { K: [[f, 0, W / 2], [0, f, HT / 2], [0, 0, 1]], hfov_deg: 65 } }, gt, byFrame: new Map(gt.map(g => [g.frame, g])),
    width: W, height: HT, aspect: W / HT, fps: FPS, players: 1, category: 'pingpong', phases: [], focal: f / HT, focalSource: 'test', focalFromGt: null, features: [] };
}
/** The tracker's view of the GT `late` frames ago: exact picture points and world landmarks round the hips. */
function trackedOf(scene: Scene, late = 0): TrackedFrame[] {
  return scene.gt.map((g, i) => {
    const pts = body(scene.gt[Math.max(0, i - late)].t_ms);
    const hip = { x: (pts[23].x + pts[24].x) / 2, y: (pts[23].y + pts[24].y) / 2, z: (pts[23].z + pts[24].z) / 2 };
    return { frame: g.frame, t_ms: g.t_ms, received_ms: g.t_ms, lined: true,
      poses: [{ playerId: 0, kp: pts.map(q => [...project(q), 0, 1] as Joint), world: pts.map(q => [q.x - hip.x, q.y - hip.y, q.z - hip.z] as Point3) }] };
  });
}

test('the synthetic GT\'s arm is in the player\'s frame (x right, y up, z back), and the blade is where Game.tsx draws it', () => {
  const pts = body(0);
  const arm = gtArm(pts, 'right')!;
  // The right wrist: forward (−z) and down from its shoulder, on the player's right of the middle.
  assert.ok(arm.wrist.z < -0.3 && arm.wrist.y < -0.1, JSON.stringify(arm.wrist));
  const blade = bladeOf(arm.wrist, arm.dir);
  assert.ok(Math.abs(blade.z - (arm.wrist.z * 1.1 + arm.dir.z * 0.19)) < 1e-9);
});

test('pingpong metrics: an exactly tracked player scores (near) zero error and lag; a late one shows its lag', () => {
  const scene = syntheticScene();
  const exact = pingpongScene(scene, [], trackedOf(scene), { settings: { detail: 'world', input: { width: W, height: HT } } });
  const s = exact.summary;
  assert.equal(s.gt, true);
  assert.equal(s.paddle_tracked, 1);
  assert.ok(s.wrist_cm! < 0.5, `wrist ${s.wrist_cm} cm`);
  assert.ok(s.blade_cm! < 0.5, `blade ${s.blade_cm} cm`);
  assert.ok(s.dir_deg! < 1, `dir ${s.dir_deg}°`);
  assert.ok(Math.abs(s.lag_ms!) < 3, `lag ${s.lag_ms}`);
  assert.ok(s.world_arm_cm! < 0.1);
  assert.equal(s.depth_sign_wrong, 0);
  // The filter on a moving hand lags a little and smooths, but stays near.
  assert.ok(s.lag_filtered_ms! >= 0 && s.lag_filtered_ms! < 60, `filtered lag ${s.lag_filtered_ms}`);
  const late = pingpongScene(scene, [], trackedOf(scene, 3), { settings: { detail: 'world', input: { width: W, height: HT } } });
  assert.ok(Math.abs(late.summary.lag_ms! - 100) < 8, `lag ${late.summary.lag_ms}`);
  assert.ok(late.accuracy.by_side.right.wrist.median! > 1, `late wrist ${late.accuracy.by_side.right.wrist.median}`);
  // (arms.ts measures a bone's spread across the picture at its near end's depth: on a forearm
  // sweeping across the body that leaves about a centimetre, three at worst, even from exact input.)
  assert.ok(exact.accuracy.by_side.right.wrist.median! < 1.5 && exact.accuracy.by_side.right.wrist.p90! < 4, JSON.stringify(exact.accuracy.by_side.right.wrist));
  // The same at the camera's true field of view (65°, the game's): no difference.
  assert.equal(exact.fov.true, 65);
  assert.equal(s.wrist_true_fov_cm, s.wrist_cm);
});

test('pingpong metrics run on a clip without GT: found rate, jitter and rate only', () => {
  const scene = syntheticScene();
  const blind = { ...scene, gt: [], byFrame: new Map(), meta: {} } as Scene;
  const m = pingpongScene(blind, [], trackedOf(scene), { settings: { detail: 'hands', input: { width: W, height: HT } } });
  assert.equal(m.summary.gt, false);
  assert.equal(m.summary.wrist_cm, null);
  assert.equal(m.summary.hand_found, 0);
  assert.equal(m.summary.pose_hz, 30);
});

test('the cluster bootstrap is the plain one with single-scene clusters, and wider when variants of one render move together', () => {
  const d = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(x => x / 10);
  assert.deepEqual(clusterBootstrap(d, d.map((_, i) => String(i))), bootstrap(d));
  // Three renders, each with four identical variants: the interval is the three renders', not twelve scenes'.
  const v = [0.1, 0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9, 0.9], c = v.map((_, i) => String(Math.floor(i / 4)));
  const [lo, hi] = clusterBootstrap(v, c), [plo, phi] = bootstrap(v);
  assert.ok(hi - lo > phi - plo, `${lo}..${hi} vs ${plo}..${phi}`);
  assert.deepEqual(clusterBootstrap([1, 2, 3], ['a', 'a', 'b']), [NaN, NaN]);
});

test('paired comparison: a paddle bias made smaller is better, a lower found rate worse', () => {
  const row = (scene: string, bz: number, found: number): Row => ({ scene, cls: 'x/1p', cluster: scene,
    summary: { wrist_bias_cm: [0, 0, bz], hand_found: found } as unknown as Row['summary'] });
  const a = ['s1', 's2', 's3', 's4', 's5'].map((s, i) => row(s, -20 - i, 0.9));
  const b = ['s1', 's2', 's3', 's4', 's5'].map((s, i) => row(s, 5 + i * 0.1, 0.5 + i * 0.01));
  const cmp = compare(a, b);
  const bias = cmp.columns.wrist_bias_z as { verdict: string; delta: number };
  assert.equal(bias.verdict, 'better');
  assert.ok(bias.delta < -10);
  assert.equal((cmp.columns.hand_found as { verdict: string }).verdict, 'worse');
});
