// Ping-pong metrics: how well the Table Tennis minigame's first-person paddle follows the player,
// computed from a run's tracked.jsonl by the game's own arms.ts (handPose), with its filters and
// constants, against the scene's 3D GT. Real clips without GT get what can be measured without it.
//   node tools/trackbench/harness/pingpong.ts <estimator-id> [scene-id...] [--jobs N]
// Writes runs/<estimator>/<scene>/pingpong.json. PINGPONG.md describes every measure.
//
// Frames: camera space is arms.ts's (x picture right, y down, z away, metres); the player's frame
// is that turned half round (x their right, y up, z back: forward is -z), as handPose reports the
// wrist from its shoulder. GT joints go from stage metres to camera space with meta.json's
// per-frame camera_to_world (Blender: the camera looks down its -Z, +Y up).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_FOV, SURELY_BACK, flatWorld, handPose } from '../../../apps/web/src/minigames/table-tennis/arms.ts';
import { BLADE_UP, HAND_FILTERS, MITT, RAISED, REACH } from '../../../apps/web/src/minigames/table-tennis/rig.ts';
import type { HandInput, HandPose, PicturePoint, Side, Vec3, WorldPoint } from '../../../apps/web/src/minigames/table-tennis/arms.ts';
import { OneEuro } from '../../../apps/web/src/minigames/table-tennis/oneEuro.ts';
import { detailHands } from '../../../packages/pose/webcamRecord.ts';
import type { HandSide, PoseDetail } from '../../../packages/pose/webcamRecord.ts';
import { DATA, loadScene, matchPoses, parseArgs, readJson, readJsonl, round, runDir, writeJson } from './common.ts';
import type { DetFrame, DetHand, GtFrame, GtPerson, Scene, TrackedFrame, TrackedPose } from './common.ts';
import { jobsOption, scenePool } from './pool.ts';

export const PINGPONG_VERSION = 1;
const SIDES: readonly Side[] = ['left', 'right'];
const ARM_JOINTS = { left: { shoulder: 11, elbow: 13, wrist: 15, index: 19, pinky: 17 }, right: { shoulder: 12, elbow: 14, wrist: 16, index: 20, pinky: 18 } } as const;
/** Hand-21: wrist, index, middle and pinky knuckles (MCP). */
const H = { wrist: 0, index: 5, middle: 9, pinky: 17 } as const;

/** Motion states, by the GT wrist's speed relative to its shoulder (m/s): at rest below REST, a swing from SWING, a peak a local maximum of a swing at PEAK or more. */
export const MOTION = { rest: 0.15, swing: 1.0, peak: 1.5, peakWindowMs: 100 } as const;
/** A bone counts as clearly towards or away from the camera when its GT depth change is at least this (m). */
export const CLEAR_DEPTH = 0.08;
/** A GT wrist this far (m) in front of its shoulder is reaching forward, as a ping-pong stance holds the paddle. */
export const FORWARD_REACH = 0.2;
/** Lag search range and step (ms): positive means the tracked path trails the GT. */
export const LAG = { min: -200, max: 400, step: 5 } as const;
/** Half-width (ms) of the moving average jitter is measured against. */
export const JITTER_WINDOW_MS = 200;
/** A raise (or a miss of one) counts as the same event within this (ms). */
export const RAISE_TOLERANCE_MS = 500;
/** Consecutive records further apart than this (ms) don't give a velocity. */
const MAX_VEL_GAP_MS = 120;

// ---------------------------------------------------------------- vectors and statistics

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 | null => { const l = norm(a); return l > 1e-9 ? scale(a, 1 / l) : null; };
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
/** Camera space to the player's frame (arms.ts view): x and y turned round, z the same. */
export const playerFrame = (p: Vec3): Vec3 => ({ x: -p.x, y: -p.y, z: p.z });
const vec = ([x, y, z]: readonly number[]): Vec3 => ({ x, y, z });

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);
/** The q-quantile, linearly interpolated (q in [0, 1]). */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = sorted(values), at = q * (s.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}
const meanOf = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sdOf = (values: readonly number[]) => {
  const m = meanOf(values);
  return m === null || values.length < 2 ? null : Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
};
/** n, median, p90 and mean of a list (in the units given, scaled by k). */
export function stats(values: readonly number[], k = 1, digits = 2) {
  return { n: values.length, median: round((quantile(values, 0.5) ?? NaN) * k, digits), p90: round((quantile(values, 0.9) ?? NaN) * k, digits), mean: round((meanOf(values) ?? NaN) * k, digits) };
}
/**
 * Error vectors (tracked − GT) summarised per axis and as a length: per axis the bias (signed
 * mean), the scatter (standard deviation: what calibrating the bias away leaves), and the median
 * and p90 of its size; for the length, its median and p90. Scaled by k (100: metres to cm).
 */
export function vectorStats(errors: readonly Vec3[], k = 100, digits = 2) {
  const axis = (a: 'x' | 'y' | 'z') => {
    const v = errors.map(e => e[a]);
    return { bias: round((meanOf(v) ?? NaN) * k, digits), sd: round((sdOf(v) ?? NaN) * k, digits), median_abs: round((quantile(v.map(Math.abs), 0.5) ?? NaN) * k, digits), p90_abs: round((quantile(v.map(Math.abs), 0.9) ?? NaN) * k, digits) };
  };
  const lengths = errors.map(norm);
  // What's left with each axis's bias taken away (the scatter a perfect calibration would leave).
  const bias = { x: meanOf(errors.map(e => e.x)) ?? 0, y: meanOf(errors.map(e => e.y)) ?? 0, z: meanOf(errors.map(e => e.z)) ?? 0 };
  const unbiased = errors.map(e => norm(sub(e, bias)));
  return { n: errors.length, x: axis('x'), y: axis('y'), z: axis('z'), median: round((quantile(lengths, 0.5) ?? NaN) * k, digits), p90: round((quantile(lengths, 0.9) ?? NaN) * k, digits),
    unbiased_median: round((quantile(unbiased, 0.5) ?? NaN) * k, digits) };
}
export const angleDeg = (a: Vec3, b: Vec3) => {
  const ua = unit(a), ub = unit(b);
  return ua && ub ? Math.acos(Math.max(-1, Math.min(1, dot(ua, ub)))) * 180 / Math.PI : NaN;
};

// ---------------------------------------------------------------- GT geometry

/** The inverse of a rigid 4x4 (row-major) transform. */
export function invertRigid(m: readonly number[]): number[] {
  const r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]], t = [m[3], m[7], m[11]];
  const out = Array(16).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = r[j][i];
    out[i * 4 + 3] = -(r[0][i] * t[0] + r[1][i] * t[1] + r[2][i] * t[2]);
  }
  out[15] = 1;
  return out;
}
/** A stage point into arms.ts camera space, given world_to_camera (Blender's camera: -Z forward, +Y up). */
export function stageToCamera(worldToCamera: readonly number[], [X, Y, Z]: readonly number[]): Vec3 {
  const m = worldToCamera;
  const x = m[0] * X + m[1] * Y + m[2] * Z + m[3], y = m[4] * X + m[5] * Y + m[6] * Z + m[7], z = m[8] * X + m[9] * Y + m[10] * Z + m[11];
  return { x, y: -y, z: -z };
}

/** A GT hand in the player's frame: its wrist from its shoulder, the axes arms.ts would give it (dir, across), and its blade. */
export interface GtArm { wrist: Vec3; dir: Vec3; across: Vec3; blade: Vec3; elbow: Vec3; shoulderCam: Vec3; wristCam: Vec3; }

/**
 * Where rig.ts (followHands) puts the blade's centre from a HandPose, relative to the shoulder in the
 * player's frame: the wrist (its reach scaled by REACH), then MITT and BLADE_UP along the hand.
 * (The game also eases it to the screen's rate and adds the aim assist's slide and its paddle
 * calibration's shift: a shift of the x and y bias, not depth; calibrate.ts.)
 */
export const bladeOf = (wrist: Vec3, dir: Vec3): Vec3 => add(scale(wrist, REACH), scale(dir, MITT + BLADE_UP));

/** dir and across as arms.ts makes them, from camera-space wrist, knuckles and middle. */
function axesOf(wrist: Vec3, index: Vec3, pinky: Vec3, middle: Vec3): { dir: Vec3; across: Vec3 } | null {
  const dir = unit(playerFrame(sub(middle, wrist)));
  const line = playerFrame(sub(index, pinky));
  if (!dir) return null;
  const across = unit(sub(line, scale(dir, dot(line, dir))));
  return across ? { dir, across } : null;
}

/** A GT person's arm on one side, from their camera-space joints (and 21-point hand, when the GT has it). */
export function gtArm(cam: readonly Vec3[], side: Side, hand?: readonly Vec3[]): GtArm | null {
  const j = ARM_JOINTS[side];
  const shoulder = cam[j.shoulder], wristCam = hand?.[H.wrist] ?? cam[j.wrist];
  const index = hand?.[H.index] ?? cam[j.index], pinky = hand?.[H.pinky] ?? cam[j.pinky];
  // Without the 21 points, the middle knuckle is taken between the index and pinky ones, as arms.ts does from the pose.
  const middle = hand?.[H.middle] ?? lerp(cam[j.index], cam[j.pinky], 0.5);
  const axes = axesOf(wristCam, index, pinky, middle);
  if (!axes) return null;
  const wrist = playerFrame(sub(wristCam, shoulder));
  return { wrist, ...axes, blade: bladeOf(wrist, axes.dir), elbow: playerFrame(sub(cam[j.elbow], shoulder)), shoulderCam: shoulder, wristCam };
}

/** The camera's true horizontal field of view (degrees) from meta.json's intrinsics, or the spec's; null when neither says. */
export function trueFov(scene: Scene): number | null {
  const cam = scene.meta.camera;
  const K = cam?.K ?? scene.meta.K;
  const w = (cam as { width?: number } | undefined)?.width ?? scene.meta.resolution?.[0];
  if (K && w) return 2 * Math.atan(w / 2 / K[0][0]) * 180 / Math.PI;
  return cam?.hfov_deg ?? scene.spec.camera?.hfov_deg ?? null;
}

/** Each GT frame's people in camera space (null without camera_to_world: no 3D GT). */
export function cameraSpace(scene: Scene): ((frame: GtFrame, person: GtPerson) => { body: Vec3[]; hands: Partial<Record<Side, Vec3[]>> }) | null {
  const c2w = scene.meta.camera_to_world;
  if (!c2w) return null;
  const cache = new Map<number, number[]>();
  return (frame, person) => {
    let w2c = cache.get(frame.frame);
    if (!w2c) {
      const m = c2w[String(frame.frame)];
      if (!m) throw Error(`${scene.id}: no camera_to_world for frame ${frame.frame}`);
      w2c = invertRigid(m);
      cache.set(frame.frame, w2c);
    }
    const hands: Partial<Record<Side, Vec3[]>> = {};
    for (const side of SIDES) { const h = person.hands?.[side]; if (h?.kp3d?.length === 21) hands[side] = h.kp3d.map(p => stageToCamera(w2c!, p)); }
    return { body: person.kp3d.map(p => stageToCamera(w2c!, p)), hands };
  };
}

// ---------------------------------------------------------------- time series

/** Speeds (|d/dt|, units per second) of a sampled path by central differences (one-sided at the ends and gaps). */
export function speeds(times: readonly number[], points: readonly Vec3[], maxGapMs = MAX_VEL_GAP_MS): number[] {
  return points.map((_, i) => {
    const a = i > 0 && times[i] - times[i - 1] <= maxGapMs ? i - 1 : i, b = i + 1 < points.length && times[i + 1] - times[i] <= maxGapMs ? i + 1 : i;
    return a === b ? NaN : norm(sub(points[b], points[a])) / ((times[b] - times[a]) / 1000);
  });
}

/** Each sample's motion state from its speed: rest, moving, swing, or peak (a swing's local maximum at PEAK or more). */
export function motionStates(times: readonly number[], speed: readonly number[]): ('rest' | 'moving' | 'swing' | 'peak' | 'unknown')[] {
  return speed.map((v, i) => {
    if (!Number.isFinite(v)) return 'unknown';
    if (v < MOTION.rest) return 'rest';
    if (v < MOTION.swing) return 'moving';
    if (v >= MOTION.peak) {
      let peak = true;
      for (let j = i - 1; j >= 0 && times[i] - times[j] <= MOTION.peakWindowMs; j--) if (speed[j] > v) peak = false;
      for (let j = i + 1; j < speed.length && times[j] - times[i] <= MOTION.peakWindowMs; j++) if (speed[j] > v) peak = false;
      if (peak) return 'peak';
    }
    return 'swing';
  });
}

/** A path's position at time t (linear between samples; null outside it or across a gap). */
export function sampleAt(times: readonly number[], points: readonly Vec3[], t: number, maxGapMs = MAX_VEL_GAP_MS): Vec3 | null {
  if (!times.length || t < times[0] || t > times[times.length - 1]) return null;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  if (times[hi] - times[lo] > maxGapMs) return null;
  const span = times[hi] - times[lo];
  return span ? lerp(points[lo], points[hi], (t - times[lo]) / span) : points[lo];
}

/**
 * The time shift (ms) that best lines a tracked path up with the GT's: the lag minimising the
 * mean squared distance between the tracked samples and the GT path that long before, both with
 * their means taken away (so a steady offset doesn't count), searched over LAG and refined by a
 * parabola through the best three. Positive: the tracked path trails. Null with too little
 * movement to tell (the GT's spread under 2 cm) or too few samples.
 */
export function bestLag(trackedTimes: readonly number[], tracked: readonly Vec3[], gtTimes: readonly number[], gt: readonly Vec3[], range = LAG): { lag_ms: number; rms_cm: number; n: number } | null {
  const costs: { lag: number; cost: number; n: number }[] = [];
  for (let lag = range.min; lag <= range.max; lag += range.step) {
    const pairs: [Vec3, Vec3][] = [];
    trackedTimes.forEach((t, i) => { const g = sampleAt(gtTimes, gt, t - lag); if (g) pairs.push([tracked[i], g]); });
    if (pairs.length < 30) { costs.push({ lag, cost: Infinity, n: pairs.length }); continue; }
    const mt = scale(pairs.reduce((a, [p]) => add(a, p), { x: 0, y: 0, z: 0 }), 1 / pairs.length);
    const mg = scale(pairs.reduce((a, [, g]) => add(a, g), { x: 0, y: 0, z: 0 }), 1 / pairs.length);
    const spread = Math.sqrt(pairs.reduce((a, [, g]) => a + dot(sub(g, mg), sub(g, mg)), 0) / pairs.length);
    if (spread < 0.02) { costs.push({ lag, cost: Infinity, n: pairs.length }); continue; }
    costs.push({ lag, cost: pairs.reduce((a, [p, g]) => { const d = sub(sub(p, mt), sub(g, mg)); return a + dot(d, d); }, 0) / pairs.length, n: pairs.length });
  }
  let best = -1;
  costs.forEach((c, i) => { if (Number.isFinite(c.cost) && (best < 0 || c.cost < costs[best].cost)) best = i; });
  if (best < 0) return null;
  let lag = costs[best].lag;
  if (best > 0 && best + 1 < costs.length && Number.isFinite(costs[best - 1].cost) && Number.isFinite(costs[best + 1].cost)) {
    const [a, b, c] = [costs[best - 1].cost, costs[best].cost, costs[best + 1].cost];
    const den = a - 2 * b + c;
    if (den > 0) lag += range.step * 0.5 * (a - c) / den;
  }
  return { lag_ms: round(lag, 1)!, rms_cm: round(Math.sqrt(costs[best].cost) * 100, 2)!, n: costs[best].n };
}

/**
 * Jitter: the RMS distance (units of the points) of each masked sample from its path's own
 * moving average over ±windowMs (the samples in reach, all of them masked too), so it measures
 * shaking, not movement.
 */
export function jitter(times: readonly number[], points: readonly Vec3[], mask: readonly boolean[], windowMs = JITTER_WINDOW_MS): { rms: number | null; n: number } {
  let sum = 0, n = 0;
  for (let i = 0; i < points.length; i++) {
    if (!mask[i]) continue;
    // As many samples each side (so a steady glide averages to where it is), all masked.
    let before = 0, after = 0, ok = true;
    for (let j = i - 1; j >= 0 && times[i] - times[j] <= windowMs; j--) { if (!mask[j]) { ok = false; break; } before++; }
    for (let j = i + 1; ok && j < points.length && times[j] - times[i] <= windowMs; j++) { if (!mask[j]) { ok = false; break; } after++; }
    const k = Math.min(before, after);
    if (!ok || k < 2) continue;
    let acc = { x: 0, y: 0, z: 0 };
    for (let j = i - k; j <= i + k; j++) acc = add(acc, points[j]);
    const d = sub(points[i], scale(acc, 1 / (2 * k + 1)));
    sum += dot(d, d); n++;
  }
  return { rms: n ? Math.sqrt(sum / n) : null, n };
}

/** A hand raised (round.ts): its wrist above RAISED.up from its shoulder raises it, below RAISED.down lowers it; null (lost) lowers it. */
export function raisedStates(ys: readonly (number | null)[]): boolean[] {
  let up = false;
  return ys.map(y => (up = y !== null && y > (up ? RAISED.down : RAISED.up)));
}
/** Times a state turns on. */
const onsets = (times: readonly number[], states: readonly boolean[]) => times.filter((_, i) => states[i] && (i === 0 || !states[i - 1]));
/**
 * Raises as the game sees them against the GT's: false triggers (game raises with no GT raise
 * within the tolerance) and misses (GT raises the game never matches), and per frame the share
 * raised wrongly while down and not raised while up.
 */
export function raiseAgreement(times: readonly number[], gt: readonly boolean[], game: readonly boolean[], toleranceMs = RAISE_TOLERANCE_MS) {
  const g = onsets(times, gt), m = onsets(times, game);
  const near = (t: number, list: readonly number[]) => list.some(u => Math.abs(u - t) <= toleranceMs);
  const down = gt.filter(s => !s).length, up = gt.length - down;
  return {
    gt_raises: g.length, game_raises: m.length,
    false_triggers: m.filter(t => !near(t, g)).length, misses: g.filter(t => !near(t, m)).length,
    false_up_frac: down ? round(gt.filter((s, i) => !s && game[i]).length / down) : null,
    missed_up_frac: up ? round(gt.filter((s, i) => s && !game[i]).length / up) : null,
    onset_delay_ms: stats(g.flatMap(t => { const d = m.filter(u => Math.abs(u - t) <= toleranceMs).map(u => u - t); return d.length ? [d.sort((a, b) => Math.abs(a) - Math.abs(b))[0]] : []; }), 1, 0),
  };
}

/** The game's one-euro filters (HAND_FILTERS) over one hand's poses, each at its arrival time (s). */
export function filterHandPoses(poses: readonly { t: number; pose: HandPose }[]): HandPose[] {
  const f = { wrist: new OneEuro(...HAND_FILTERS.wrist), dir: new OneEuro(...HAND_FILTERS.dir), across: new OneEuro(...HAND_FILTERS.across) };
  const arr = (v: Vec3) => [v.x, v.y, v.z];
  return poses.map(({ t, pose }) => ({ from: pose.from, wrist: vec(f.wrist.filter(arr(pose.wrist), t)), dir: vec(f.dir.filter(arr(pose.dir), t)), across: vec(f.across.filter(arr(pose.across), t)) }));
}

// ---------------------------------------------------------------- the game's view of a tracked pose

/** A tracked pose as rig.ts trackHands reads it: landmarks with confidence as visibility, world (or flatWorld stand-ins). */
export function gameInputs(pose: TrackedPose, size: { width: number; height: number }) {
  const image: PicturePoint[] = pose.kp.map(([x, y, z, c]) => ({ x, y, z, visibility: c ?? 1 }));
  const world: WorldPoint[] = pose.world ? pose.world.map(vec) : flatWorld(image, size);
  return { image, world, flat: !pose.world };
}
const handInput = (h: DetHand): HandInput => ({ landmarks: h.kp.map(([x, y, z]) => ({ x, y, z })), world: h.world.map(vec) });

/** Which hands each player's detail asks the Hand Landmarker for (player k: the k-th list, or the last). */
export function wantedSides(detail: PoseDetail | null, playerId: number): HandSide[] {
  const lists = detailHands(detail);
  return lists.length ? lists[Math.min(playerId, lists.length - 1)] : [];
}

// ---------------------------------------------------------------- one scene

interface RunInfo { settings?: { detail?: PoseDetail | null; input?: { width: number; height: number }; realtime?: boolean; players?: number }; hands?: { state: string; events?: unknown[]; dropped_at_ms?: number | null }; completed?: boolean; error?: string; camera_frames_dropped?: number; frames?: number }

/** One hand's sample at one record. */
interface Sample {
  pid: number; side: Side; person: string | null; frame: number; t: number; recv: number;
  raw: HandPose; filt: HandPose; trueFov: HandPose | null;
  gt: GtArm | null; state: string; vis: number | null; phase: string | null;
}

/** Errors of a list of samples: wrist and blade, raw and filtered, at 65° and the true field of view. */
function errorBlock(samples: readonly Sample[]) {
  const s = samples.filter(x => x.gt);
  const w = (p: HandPose, g: GtArm) => sub(p.wrist, g.wrist);
  const b = (p: HandPose, g: GtArm) => sub(bladeOf(p.wrist, p.dir), g.blade);
  return {
    n: s.length,
    wrist: vectorStats(s.map(x => w(x.raw, x.gt!))),
    wrist_filtered: vectorStats(s.map(x => w(x.filt, x.gt!))),
    wrist_true_fov: vectorStats(s.filter(x => x.trueFov).map(x => w(x.trueFov!, x.gt!))),
    blade: vectorStats(s.map(x => b(x.raw, x.gt!))),
    blade_filtered: vectorStats(s.map(x => b(x.filt, x.gt!))),
    dir_deg: stats(s.map(x => angleDeg(x.raw.dir, x.gt!.dir)).filter(Number.isFinite), 1, 1),
    across_deg: stats(s.map(x => angleDeg(x.raw.across, x.gt!.across)).filter(Number.isFinite), 1, 1),
  };
}

const groupBy = <T>(items: readonly T[], key: (t: T) => string) => {
  const out: Record<string, T[]> = {};
  for (const it of items) (out[key(it)] ??= []).push(it);
  return out;
};

export function pingpongScene(scene: Scene, dets: readonly DetFrame[], tracked: readonly TrackedFrame[], run: RunInfo = {}, estimator = '') {
  const detail = run.settings?.detail ?? null;
  const size = run.settings?.input ?? { width: scene.width, height: scene.height };
  const fov = trueFov(scene);
  const hasGt = scene.gt.some(f => f.people.length);
  const toCam = hasGt ? cameraSpace(scene) : null;
  const records = tracked.filter(r => !r.dropped);
  const durationS = records.length > 1 ? (records[records.length - 1].t_ms - records[0].t_ms) / 1000 : 0;

  // GT people per record (per-frame Hungarian on 2D, as metrics.ts matches poses).
  const matchOf = (r: TrackedFrame) => {
    const gtf = scene.byFrame.get(r.frame);
    if (!gtf || !gtf.people.length) return r.poses.map(() => null);
    return matchPoses(r.poses.map(p => p.kp), gtf, scene).map(m => m.person >= 0 ? gtf.people[m.person] : null);
  };

  // Each player's each hand through handPose (65°, and the true FOV) and the game's filters.
  const samples: Sample[] = [];
  const handsLog: { pid: number; frame: number; recv: number; person: GtPerson | null; gtf: GtFrame | undefined; pose: TrackedPose }[] = [];
  const perHand = new Map<string, { t: number; pose: HandPose; trueFov: HandPose | null; r: TrackedFrame; person: GtPerson | null }[]>();
  const worldRows: { pose: TrackedPose; cam: Vec3[] }[] = [];
  const gtArmCache = new Map<string, GtArm | null>();
  const gtArmAt = (gtf: GtFrame, person: GtPerson, side: Side) => {
    const key = `${gtf.frame}|${person.id}|${side}`;
    if (!gtArmCache.has(key)) { const c = toCam!(gtf, person); gtArmCache.set(key, gtArm(c.body, side, c.hands[side])); }
    return gtArmCache.get(key)!;
  };
  for (const r of records) {
    const people = matchOf(r);
    const gtf = scene.byFrame.get(r.frame);
    r.poses.forEach((pose, i) => {
      const person = people[i];
      handsLog.push({ pid: pose.playerId, frame: r.frame, recv: r.received_ms, person, gtf, pose });
      const { image, world } = gameInputs(pose, size);
      if (person && toCam && gtf && pose.world) worldRows.push({ pose, cam: toCam(gtf, person).body });
      for (const side of SIDES) {
        const det = pose.hands?.find(h => h.side === side);
        const hand = det ? handInput(det) : undefined;
        const raw = handPose({ landmarks: image, world }, hand, side, size, DEFAULT_FOV);
        if (!raw) continue;
        const atFov = fov ? handPose({ landmarks: image, world }, hand, side, size, fov) : null;
        const key = `${pose.playerId}|${side}`;
        if (!perHand.has(key)) perHand.set(key, []);
        perHand.get(key)!.push({ t: r.received_ms / 1000, pose: raw, trueFov: atFov, r, person });
      }
    });
  }
  // Per GT person and side: the GT path (wrist from shoulder) over every GT frame, its speeds and motion states.
  const gtPaths = new Map<string, { times: number[]; wrist: Vec3[]; state: Map<number, string> }>();
  if (toCam) {
    const people = new Set(scene.gt.flatMap(f => f.people.filter(p => p.role === 'player').map(p => p.id)));
    for (const id of people) for (const side of SIDES) {
      const times: number[] = [], wrist: Vec3[] = [], frames: number[] = [];
      for (const f of scene.gt) {
        const p = f.people.find(q => q.id === id);
        if (!p || p.phase === 'offstage') continue;
        const arm = gtArmAt(f, p, side);
        if (!arm) continue;
        times.push(f.t_ms); wrist.push(arm.wrist); frames.push(f.frame);
      }
      const st = motionStates(times, speeds(times, wrist));
      gtPaths.set(`${id}|${side}`, { times, wrist, state: new Map(frames.map((fr, i) => [fr, st[i]])) });
    }
  }
  for (const [key, list] of perHand) {
    const [pid, side] = [Number(key.split('|')[0]), key.split('|')[1] as Side];
    const filtered = filterHandPoses(list);
    list.forEach((x, i) => {
      const gtf = scene.byFrame.get(x.r.frame);
      const gt = x.person && gtf && toCam ? gtArmAt(gtf, x.person, side) : null;
      const vis = x.person ? x.person.kp[ARM_JOINTS[side].wrist][3] : null;
      samples.push({ pid, side, person: x.person?.id ?? null, frame: x.r.frame, t: x.r.t_ms, recv: x.r.received_ms, raw: x.pose, filt: filtered[i], trueFov: x.trueFov,
        gt, state: x.person ? gtPaths.get(`${x.person.id}|${side}`)?.state.get(x.r.frame) ?? 'unknown' : 'unknown', vis, phase: x.person?.phase ?? null });
    });
  }

  // The paddle hand(s): the GT's, else the detail's one side for that player, else both; the free hand the other(s).
  const paddleOf = (pid: number, person: string | null): Side[] => {
    const gp = person ? scene.gt.find(f => f.people.some(p => p.id === person && p.paddle))?.people.find(p => p.id === person)?.paddle?.hand : undefined;
    if (gp) return [gp];
    const wanted = wantedSides(detail, pid);
    return wanted.length === 1 ? wanted : ['left', 'right'];
  };
  const isPaddle = (s: Sample) => paddleOf(s.pid, s.person).includes(s.side);
  const freeOf = (pid: number, person: string | null): Side[] => { const p = paddleOf(pid, person); return p.length === 1 ? SIDES.filter(s => s !== p[0]) : ['left', 'right']; };

  // ---- accuracy, split
  const gtSamples = samples.filter(s => s.gt);
  const paddle = gtSamples.filter(isPaddle);
  const paddleAll = samples.filter(isPaddle);
  const accuracy = {
    paddle: errorBlock(paddle),
    by_side: Object.fromEntries(SIDES.map(side => [side, errorBlock(gtSamples.filter(s => s.side === side))])),
    by_motion: Object.fromEntries(Object.entries(groupBy(paddle, s => s.state)).map(([k, v]) => [k, errorBlock(v)])),
    by_visibility: Object.fromEntries(Object.entries(groupBy(paddle, s => String(s.vis))).map(([k, v]) => [k, errorBlock(v)])),
    by_source: Object.fromEntries(Object.entries(groupBy(paddle, s => s.raw.from)).map(([k, v]) => [k, errorBlock(v)])),
    by_phase: Object.fromEntries(Object.entries(groupBy(paddle, s => s.phase ?? 'none')).map(([k, v]) => [k, errorBlock(v)])),
    // Reaching forward (the GT wrist FORWARD_REACH in front of the shoulder), as a ping-pong stance does, or not.
    by_reach: Object.fromEntries(Object.entries(groupBy(paddle, s => s.gt!.wrist.z < -FORWARD_REACH ? 'forward' : 'not_forward')).map(([k, v]) => [k, errorBlock(v)])),
    by_player: Object.fromEntries(Object.entries(groupBy(paddle, s => s.person ?? '?')).map(([k, v]) => [k, errorBlock(v)])),
  };

  // ---- coverage: present GT player-frames whose paddle hand the game has a pose for
  let wanted = 0, covered = 0;
  if (hasGt) {
    const have = new Set(samples.map(s => `${s.frame}|${s.person}|${s.side}`));
    const pidOf = new Map<string, number>();
    for (const s of samples) if (s.person) pidOf.set(s.person, s.pid);
    const recFrames = new Set(records.map(r => r.frame));
    for (const f of scene.gt) {
      if (!recFrames.has(f.frame)) continue;
      for (const p of f.people) {
        if (p.role !== 'player' || p.phase === 'offstage' || !p.in_frame) continue;
        for (const side of paddleOf(pidOf.get(p.id) ?? 0, p.id)) {
          if (p.kp[ARM_JOINTS[side].shoulder][3] === 3) continue;
          wanted++; if (have.has(`${f.frame}|${p.id}|${side}`)) covered++;
        }
      }
    }
  }

  // ---- velocity and lag, per player and hand
  const velocity: Record<string, unknown> = {}, lag: Record<string, unknown> = {};
  const velErrs: { raw: Vec3[]; filt: Vec3[]; ratioRaw: number[]; ratioFilt: number[]; state: string[] } = { raw: [], filt: [], ratioRaw: [], ratioFilt: [], state: [] };
  const lags: { raw: number[]; filt: number[] } = { raw: [], filt: [] };
  for (const [key, group] of Object.entries(groupBy(gtSamples, s => `${s.pid}|${s.side}|${s.person}`))) {
    const g = group.sort((a, b) => a.t - b.t);
    const errs = { raw: [] as Vec3[], filt: [] as Vec3[] };
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i], dt = (b.t - a.t) / 1000;
      if (b.t - a.t > MAX_VEL_GAP_MS || dt <= 0) continue;
      const vg = scale(sub(b.gt!.wrist, a.gt!.wrist), 1 / dt);
      const vr = scale(sub(b.raw.wrist, a.raw.wrist), 1 / dt), vf = scale(sub(b.filt.wrist, a.filt.wrist), 1 / dt);
      errs.raw.push(sub(vr, vg)); errs.filt.push(sub(vf, vg));
      if (isPaddle(b)) {
        velErrs.raw.push(sub(vr, vg)); velErrs.filt.push(sub(vf, vg)); velErrs.state.push(b.state);
        if (norm(vg) >= MOTION.swing) { velErrs.ratioRaw.push(norm(vr) / norm(vg)); velErrs.ratioFilt.push(norm(vf) / norm(vg)); }
      }
    }
    velocity[key] = { raw: vectorStats(errs.raw), filtered: vectorStats(errs.filt) };
    const person = g[0].person!, side = g[0].side;
    const path = gtPaths.get(`${person}|${side}`);
    if (path) {
      const raw = bestLag(g.map(s => s.t), g.map(s => s.raw.wrist), path.times, path.wrist);
      // The filter runs at arrival times: its output is placed at its frame's capture time like the raw one, so only its own lag shows.
      const filt = bestLag(g.map(s => s.t), g.map(s => s.filt.wrist), path.times, path.wrist);
      lag[key] = { raw, filtered: filt };
      if (isPaddle(g[0])) { if (raw) lags.raw.push(raw.lag_ms); if (filt) lags.filt.push(filt.lag_ms); }
    }
  }
  const swingIdx = velErrs.state.map((s, i) => (s === 'swing' || s === 'peak') ? i : -1).filter(i => i >= 0);
  const latency = records.map(r => r.received_ms - r.t_ms);

  // ---- jitter at rest (GT rest, or still by the tracked path itself without GT)
  const jitterOf = (list: Sample[], pick: (s: Sample) => Vec3, mask: boolean[]) => jitter(list.map(s => s.t), list.map(pick), mask);
  const jit = { raw: [] as number[], filtered: [] as number[], blade_filtered: [] as number[], n: 0 };
  for (const group of Object.values(groupBy(samples.filter(isPaddle), s => `${s.pid}|${s.side}`))) {
    const g = group.sort((a, b) => a.t - b.t);
    let mask: boolean[];
    if (hasGt) mask = g.map(s => s.state === 'rest');
    else {
      // Still: the filtered wrist moving under the rest speed.
      const v = speeds(g.map(s => s.t), g.map(s => s.filt.wrist));
      mask = v.map(x => Number.isFinite(x) && x < MOTION.rest);
    }
    const r = jitterOf(g, s => s.raw.wrist, mask), f = jitterOf(g, s => s.filt.wrist, mask), b = jitterOf(g, s => bladeOf(s.filt.wrist, s.filt.dir), mask);
    if (r.rms !== null) { jit.raw.push(r.rms); jit.n += r.n; }
    if (f.rms !== null) jit.filtered.push(f.rms);
    if (b.rms !== null) jit.blade_filtered.push(b.rms);
  }

  // ---- Hand Landmarker
  const handStats = { wanted: 0, found: 0, wrong_side: 0, wrong_person: 0, checked: 0, kp21_px: [] as number[], kp21_rel: [] as number[], wrist_px: [] as number[], pose_wrist_px: [] as number[], index_px: [] as number[], pinky_px: [] as number[], flips_no_gt: 0, hands_no_gt: 0 };
  type XY = readonly (number | null)[];
  const px = (a: XY, b: XY) => Math.hypot((a[0]! - b[0]!) * size.width, (a[1]! - b[1]!) * size.height);
  const droppedAt = run.hands?.dropped_at_ms ?? Infinity;
  for (const { pid, recv, person, gtf, pose } of handsLog) {
    // (Once the game drops two people's hands for being too slow, none are wanted.)
    const wantedHere = recv >= droppedAt ? [] : wantedSides(detail, pid);
    for (const side of wantedHere) {
      const det = pose.hands?.find(h => h.side === side);
      const j = ARM_JOINTS[side], other = ARM_JOINTS[side === 'left' ? 'right' : 'left'];
      if (!hasGt) {
        // Without GT: a found hand nearer the pose's other wrist than its own is a side flip.
        if ((pose.kp[j.wrist][3] ?? 1) < 0.3) continue;
        handStats.wanted++;
        if (!det) continue;
        handStats.found++; handStats.hands_no_gt++;
        if (px(det.kp[0], pose.kp[other.wrist]) < px(det.kp[0], pose.kp[j.wrist])) handStats.flips_no_gt++;
        continue;
      }
      if (!person || !gtf || person.kp[j.wrist][3] === 3) continue;
      handStats.wanted++;
      if (!det) continue;
      handStats.found++;
      const at = det.kp[0];
      // Wrong side / wrong person: the GT wrist nearest the hand's wrist is the person's other one, or someone else's.
      let best: { id: string; side: Side; d: number } | null = null;
      for (const p of gtf.people) for (const s of SIDES) {
        const w = p.kp[ARM_JOINTS[s].wrist];
        if (w[3] === 3) continue;
        const d = px(at, w);
        if (!best || d < best.d) best = { id: p.id, side: s, d };
      }
      const apart = px(person.kp[j.wrist], person.kp[other.wrist]);
      if (best) {
        if (best.id !== person.id) handStats.wrong_person++;
        else if (best.side !== side && apart > 0.05 * size.height) handStats.wrong_side++;
        handStats.checked++;
      }
      if (best && best.id === person.id && best.side === side) {
        handStats.wrist_px.push(px(at, person.kp[j.wrist]));
        handStats.pose_wrist_px.push(px(pose.kp[j.wrist], person.kp[j.wrist]));
        handStats.index_px.push(px(det.kp[H.index], person.kp[j.index]));
        handStats.pinky_px.push(px(det.kp[H.pinky], person.kp[j.pinky]));
        const gh = person.hands?.[side]?.kp;
        if (gh?.length === 21) {
          const e = mean21(det.kp, gh, px);
          const len = px(gh[H.wrist], gh[H.middle]);
          handStats.kp21_px.push(e);
          if (len > 1) handStats.kp21_rel.push(e / len);
        }
      }
    }
  }

  // ---- world landmarks: root-aligned arm error, and depth directions
  const BONES: [number, number][] = [[11, 13], [13, 15], [12, 14], [14, 16]];
  const worldErr: number[] = [];
  const depth = { clear: 0, sign_wrong: 0, gt_back: 0, back_read_forward: 0, gt_forward: 0, forward_read_back: 0 };
  for (const { pose, cam } of worldRows) {
    const w = pose.world!.map(vec);
    const hipT = lerp(w[23], w[24], 0.5), hipG = lerp(cam[23], cam[24], 0.5);
    for (const i of [11, 12, 13, 14, 15, 16]) worldErr.push(norm(sub(sub(w[i], hipT), sub(cam[i], hipG))));
    for (const [a, b] of BONES) {
      const dzG = cam[b].z - cam[a].z, dzT = w[b].z - w[a].z;
      if (Math.abs(dzG) < CLEAR_DEPTH) continue;
      depth.clear++;
      if (Math.sign(dzG) !== Math.sign(dzT)) depth.sign_wrong++;
      // arms.ts takes a bone as pointing forward unless the model says back by SURELY_BACK.
      if (dzG > 0) { depth.gt_back++; if (!(dzT > SURELY_BACK)) depth.back_read_forward++; }
      else { depth.gt_forward++; if (dzT > SURELY_BACK) depth.forward_read_back++; }
    }
  }

  // ---- the free hand's raise (the serve)
  const raise: Record<string, unknown> = {};
  const raiseTotals = { false_triggers: 0, misses: 0, gt_raises: 0, game_raises: 0, minutes: 0 };
  if (toCam) {
    for (const group of Object.values(groupBy(samples, s => `${s.pid}|${s.side}`))) {
      const { pid, side } = group[0];
      // Per record of this player: the hand's filtered wrist height (null while lost), and the GT's.
      const person = group.find(s => s.person)?.person ?? null;
      if (!person || !freeOf(pid, person).includes(side)) continue;
      const bySeq = new Map(group.map(s => [s.frame, s]));
      const times: number[] = [], game: (number | null)[] = [], gtY: (number | null)[] = [];
      let lastAt = -Infinity, lastY: number | null = null;
      for (const r of records) {
        const gtf = scene.byFrame.get(r.frame);
        const p = gtf?.people.find(q => q.id === person);
        if (!gtf || !p || p.phase === 'offstage') continue;
        const s = bySeq.get(r.frame);
        if (s && s.person === person) { lastAt = r.received_ms; lastY = s.filt.wrist.y; }
        // The game keeps a hand's last pose until it's LOST_MS (500) old.
        game.push(r.received_ms - lastAt < 500 ? lastY : null);
        const arm = gtArmAt(gtf, p, side);
        gtY.push(arm ? arm.wrist.y : null);
        times.push(r.t_ms);
      }
      if (times.length < 2) continue;
      const a = raiseAgreement(times, raisedStates(gtY), raisedStates(game));
      raise[`${pid}|${side}`] = a;
      raiseTotals.false_triggers += a.false_triggers; raiseTotals.misses += a.misses; raiseTotals.gt_raises += a.gt_raises; raiseTotals.game_raises += a.game_raises;
      raiseTotals.minutes += (times[times.length - 1] - times[0]) / 60000;
    }
  }

  // ---- cost
  const inf = dets.map(d => d.inference_ms).filter((v): v is number => typeof v === 'number');
  const rt = dets.map(d => d.roundtrip_ms).filter((v): v is number => typeof v === 'number');
  const cost = {
    inference_ms: stats(inf, 1, 1), roundtrip_ms: stats(rt, 1, 1), p95_inference_ms: round(quantile(inf, 0.95), 1),
    results: dets.length, kept: records.length, dropped_results: tracked.length - records.length,
    camera_frames_dropped: run.camera_frames_dropped ?? 0,
    pose_hz: durationS ? round((records.length - 1) / durationS, 2) : null,
    latency_ms: stats(latency, 1, 1), realtime: !!run.settings?.realtime,
    hands_state: run.hands?.state ?? null, hands_dropped_at_ms: run.hands?.dropped_at_ms ?? null,
    completed: run.completed ?? true, error: run.error ?? null,
  };

  const p = accuracy.paddle;
  const swingVel = { raw: swingIdx.map(i => velErrs.raw[i]), filt: swingIdx.map(i => velErrs.filt[i]) };
  const summary = {
    gt: hasGt && !!toCam,
    paddle_tracked: wanted ? round(covered / wanted) : null,
    wrist_cm: p.wrist.median, wrist_p90_cm: p.wrist.p90,
    wrist_bias_cm: [p.wrist.x.bias, p.wrist.y.bias, p.wrist.z.bias], wrist_sd_cm: [p.wrist.x.sd, p.wrist.y.sd, p.wrist.z.sd],
    wrist_unbiased_cm: p.wrist.unbiased_median,
    wrist_true_fov_cm: p.wrist_true_fov.median, wrist_true_fov_bias_cm: [p.wrist_true_fov.x.bias, p.wrist_true_fov.y.bias, p.wrist_true_fov.z.bias],
    blade_cm: p.blade.median, blade_p90_cm: p.blade.p90, blade_filtered_cm: p.blade_filtered.median,
    blade_bias_cm: [p.blade.x.bias, p.blade.y.bias, p.blade.z.bias], blade_sd_cm: [p.blade.x.sd, p.blade.y.sd, p.blade.z.sd],
    blade_swing_cm: errorBlock(paddle.filter(s => s.state === 'swing' || s.state === 'peak')).blade_filtered.median,
    blade_rest_cm: accuracy.by_motion.rest?.blade_filtered.median ?? null,
    forward_share: paddle.length ? round(paddle.filter(s => s.gt!.wrist.z < -FORWARD_REACH).length / paddle.length) : null,
    wrist_forward_cm: accuracy.by_reach.forward?.wrist.median ?? null,
    wrist_forward_bias_cm: accuracy.by_reach.forward ? [accuracy.by_reach.forward.wrist.x.bias, accuracy.by_reach.forward.wrist.y.bias, accuracy.by_reach.forward.wrist.z.bias] : null,
    wrist_forward_sd_cm: accuracy.by_reach.forward ? [accuracy.by_reach.forward.wrist.x.sd, accuracy.by_reach.forward.wrist.y.sd, accuracy.by_reach.forward.wrist.z.sd] : null,
    blade_forward_cm: accuracy.by_reach.forward?.blade_filtered.median ?? null,
    across_deg: p.across_deg.median,
    dir_deg: p.dir_deg.median, from_hand: paddleAll.length ? round(paddleAll.filter(s => s.raw.from === 'hand').length / paddleAll.length) : null,
    swing_vel_err_ms: vectorStats(swingVel.raw, 1).median, swing_vel_err_filtered_ms: vectorStats(swingVel.filt, 1).median,
    swing_speed_ratio: round(quantile(velErrs.ratioRaw, 0.5), 3), swing_speed_ratio_filtered: round(quantile(velErrs.ratioFilt, 0.5), 3),
    lag_ms: round(quantile(lags.raw, 0.5), 1), lag_filtered_ms: round(quantile(lags.filt, 0.5), 1), latency_ms: round(meanOf(latency), 1),
    jitter_rest_cm: round((quantile(jit.raw, 0.5) ?? NaN) * 100, 2), jitter_rest_filtered_cm: round((quantile(jit.filtered, 0.5) ?? NaN) * 100, 2),
    jitter_blade_filtered_cm: round((quantile(jit.blade_filtered, 0.5) ?? NaN) * 100, 2),
    hand_found: handStats.wanted ? round(handStats.found / handStats.wanted) : null,
    hand_wrong_side: handStats.checked ? round(handStats.wrong_side / handStats.checked) : hasGt ? null : handStats.hands_no_gt ? round(handStats.flips_no_gt / handStats.hands_no_gt) : null,
    hand_wrong_person: handStats.checked ? round(handStats.wrong_person / handStats.checked) : null,
    hand_wrist_px: round(quantile(handStats.wrist_px, 0.5), 2), pose_wrist_px: round(quantile(handStats.pose_wrist_px, 0.5), 2),
    hand_kp21_rel: round(quantile(handStats.kp21_rel, 0.5), 3),
    world_arm_cm: round((quantile(worldErr, 0.5) ?? NaN) * 100, 2),
    depth_sign_wrong: depth.clear ? round(depth.sign_wrong / depth.clear) : null,
    back_read_forward: depth.gt_back ? round(depth.back_read_forward / depth.gt_back) : null,
    forward_read_back: depth.gt_forward ? round(depth.forward_read_back / depth.gt_forward) : null,
    raise_false_per_min: raiseTotals.minutes ? round(raiseTotals.false_triggers / raiseTotals.minutes, 2) : null,
    raise_miss: raiseTotals.gt_raises ? round(raiseTotals.misses / raiseTotals.gt_raises) : null,
    inference_ms: cost.inference_ms.mean, pose_hz: cost.pose_hz, completed: cost.completed,
  };

  return {
    version: PINGPONG_VERSION, estimator, scene: scene.id, category: scene.category, players: scene.players, detail, input: size,
    fov: { assumed: DEFAULT_FOV, true: round(fov, 2), distorted: (fov ?? 0) > 90 },
    summary,
    accuracy, coverage: { wanted, covered },
    velocity: { paddle: { raw: vectorStats(velErrs.raw, 1), filtered: vectorStats(velErrs.filt, 1) }, paddle_swing: { raw: vectorStats(swingVel.raw, 1), filtered: vectorStats(swingVel.filt, 1) }, per_hand: velocity },
    lag, jitter: { rest_raw_cm: stats(jit.raw, 100), rest_filtered_cm: stats(jit.filtered, 100), samples: jit.n, source: hasGt ? 'gt rest' : 'tracked still' },
    hands: { ...handStats, kp21_px: stats(handStats.kp21_px), kp21_rel: stats(handStats.kp21_rel, 1, 3), wrist_px: stats(handStats.wrist_px), pose_wrist_px: stats(handStats.pose_wrist_px), index_px: stats(handStats.index_px), pinky_px: stats(handStats.pinky_px) },
    world: { arm_cm: stats(worldErr, 100), depth },
    raise: { per_hand: raise, ...raiseTotals },
    cost,
  };
}

/** Mean 2D distance (pixels) of a found hand's 21 points from the GT's. */
function mean21(kp: readonly number[][], gt: readonly number[][], px: (a: readonly (number | null)[], b: readonly (number | null)[]) => number) {
  let s = 0;
  for (let i = 0; i < 21; i++) s += px(kp[i], gt[i]);
  return s / 21;
}

export type PingpongMetrics = ReturnType<typeof pingpongScene>;

/** One scene's ping-pong metrics from its run's files. */
export function pingpongRun({ estimator, id }: { estimator: string; id: string }): PingpongMetrics {
  const dir = runDir(estimator, id);
  const run = existsSync(path.join(dir, 'run.json')) ? readJson<RunInfo>(path.join(dir, 'run.json')) : {};
  const dets = existsSync(path.join(dir, 'detections.jsonl')) ? readJsonl<DetFrame>(path.join(dir, 'detections.jsonl')) : [];
  return pingpongScene(loadScene(id), dets, readJsonl<TrackedFrame>(path.join(dir, 'tracked.jsonl')), run, estimator);
}

if (import.meta.main) {
  const { positional: [estimator, ...scenes], opts } = parseArgs(process.argv.slice(2), { jobs: 'string' });
  if (!estimator) { console.error('usage: node tools/trackbench/harness/pingpong.ts <estimator-id> [scene-id...] [--jobs N]'); process.exit(2); }
  const root = path.join(DATA, 'runs', estimator);
  const ids = scenes.length ? scenes : readdirSync(root).filter(s => existsSync(path.join(root, s, 'tracked.jsonl')));
  const results = await scenePool<{ estimator: string; id: string }, PingpongMetrics>(new URL(import.meta.url), pingpongRun, ids.map(id => ({ estimator, id })), jobsOption(opts.jobs));
  for (const m of results) {
    writeJson(path.join(runDir(estimator, m.scene), 'pingpong.json'), m);
    const s = m.summary;
    console.log(`${m.scene}: wrist ${s.wrist_cm} cm (bias ${s.wrist_bias_cm.join('/')}) blade ${s.blade_cm}/${s.blade_filtered_cm} cm, lag ${s.lag_ms}/${s.lag_filtered_ms} ms, hands found ${s.hand_found}, ${s.inference_ms} ms`);
  }
}
