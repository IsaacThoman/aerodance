// Shared pieces of the trackbench harness: where data lives, the contract's file formats
// (tools/trackbench/CONTRACT.md), scene loading and the GT geometry every metric uses.
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const DATA = process.env.TRACKBENCH_DATA || '/Volumes/development/aerodance-trackbench';
/**
 * A scene's folder: scenes/<id>, or clips/<id> for a real clip without GT (kept out of scenes/ so
 * suite runs that expect GT don't pick it up; run-game, track and pingpong.ts take it by name).
 */
export const sceneDir = (id: string) => {
  const scene = path.join(DATA, 'scenes', id), clip = path.join(DATA, 'clips', id);
  return !existsSync(scene) && existsSync(clip) ? clip : scene;
};
export const runDir = (estimator: string, scene: string) => path.join(DATA, 'runs', estimator, scene);

// ---------------------------------------------------------------- formats

/** [x, y, depth_m, vis]: vis 0 visible, 1 self-occluded, 2 occluded by another, 3 outside the frame. */
export type GtJoint = [number, number, number, number];
export interface GtPerson {
  id: string; role: 'player' | 'bystander'; index: number;
  kp: GtJoint[]; kp3d: [number, number, number][];
  bbox: [number, number, number, number] | null; visible_frac: number | null; in_frame: boolean; phase: string;
  /** Optional (ping-pong scenes): MediaPipe hand-21 points of each hand, the body's kp/kp3d conventions. */
  hands?: Partial<Record<'left' | 'right', { kp: GtJoint[]; kp3d: [number, number, number][] }>>;
  /** Optional (ping-pong scenes): the paddle held, its centre and its face's normal in stage metres. */
  paddle?: { hand: 'left' | 'right'; center: [number, number, number]; normal: [number, number, number] };
}
export interface GtFrame { frame: number; t_ms: number; people: GtPerson[]; }
/** [x, y, z, conf]; conf may be null (unknown) in tracked poses. */
export type Joint = [number, number, number, number | null];
export interface DetPerson { kp: (Joint | null)[]; score?: number | null; }
/** [x, y, z] metres. */
export type Point3 = [number, number, number];
/**
 * A hand the game's Hand Landmarker found at a person's wrist (webcamRecord.ts TrackedHand):
 * kp its 21 points in the picture ([x, y, z], 0-1 unmirrored, z from the wrist), world the same
 * in metres round the hand's middle, score how sure it is of the side.
 */
export interface DetHand { side: 'left' | 'right'; score: number; kp: Point3[]; world: Point3[]; }
export interface DetFrame {
  frame: number; t_ms: number; inference_ms?: number; people: DetPerson[];
  looks?: (number[] | null)[];
  /** Harness additions (realtime runs): when the result arrived, and whether the game dropped it as too old. */
  received_ms?: number; roundtrip_ms?: number; dropped?: boolean;
  /**
   * With a tracking detail (run-game --detail): per person, in people's order, MediaPipe's 33
   * world landmarks (metres round the hips: x right in the picture, y down, z away; null when
   * the worker gave none) and, while hands are on, the hands found at their wrists.
   */
  world?: (Point3[] | null)[];
  hands?: DetHand[][];
}
/** A tracked player's pose; world and hands as the game's LivePose has them (only with a detail asking for them). */
export interface TrackedPose { playerId: number; kp: Joint[]; world?: Point3[]; hands?: DetHand[]; }
export interface CalibState { progress: number; complete: boolean; hold: boolean; players: string[]; }
export interface TrackedFrame {
  frame: number; t_ms: number; received_ms: number; poses: TrackedPose[];
  /** The tracker has numbered the players left to right (PlayerTracker.lined). */
  lined: boolean;
  calib?: CalibState;
  /** GameSession's setup line-up retry reset the tracker before this record. */
  reset?: boolean;
  /** WebcamPoseSource dropped this result as too old (frame age >= 500 ms): nothing downstream saw it. */
  dropped?: boolean;
}

export interface Phase { name: string; start_s: number; end_s: number; }
/** The parts of spec.json and meta.json the harness reads (both written by the generator). */
interface CameraInfo { orientation?: string; hfov_deg?: number; fx_px?: number; intrinsics?: { fx?: number }; K?: number[][]; }
export interface SceneSpec {
  players?: number; category?: string; fps?: number; resolution?: [number, number]; phases?: Phase[];
  /** A variant's base scene (its render, when only post differs). */
  base?: string;
  camera?: CameraInfo; room?: { features?: string[] };
}
export interface SceneMeta extends SceneSpec {
  intrinsics?: { fx?: number }; K?: number[][];
  /** Per frame (as a string), the camera's 4x4 camera-to-world matrix, row-major (Blender: the camera looks down its -Z, +Y up). */
  camera_to_world?: Record<string, number[]>;
  /** Scenes with the same render_key share a render (post-only variants). */
  render_key?: string;
}
export interface Scene {
  id: string; dir: string;
  spec: SceneSpec; meta: SceneMeta;
  gt: GtFrame[]; byFrame: Map<number, GtFrame>;
  width: number; height: number; aspect: number; fps: number;
  players: number; category: string; phases: Phase[];
  /** Focal length in picture heights (a length L metres at depth Z spans f * L / Z picture heights). */
  focal: number; focalSource: string;
  /** The focal length the GT implies (estimateFocal), to check the GT against the spec. */
  focalFromGt: number | null;
  features: string[];
}

export const readJsonl = <T>(file: string): T[] => readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
export const writeJsonl = (file: string, rows: readonly unknown[]) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); };
export const readJson = <T = unknown>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/**
 * A paired bootstrap 95% interval for the mean of per-scene differences, reproducible (a seeded
 * mulberry32, exact in JavaScript's integers).
 */
export function bootstrap(diffs: readonly number[], n = 4000, seed = 12345): [number, number] {
  if (diffs.length < 3) return [NaN, NaN];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < n; b++) { let t = 0; for (let i = 0; i < diffs.length; i++) t += diffs[Math.floor(rand() * diffs.length)]; means.push(t / diffs.length); }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * n)], means[Math.floor(0.975 * n)]];
}
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * bootstrap with clusters: scenes that share a render (post-only variants of one take: the same
 * motion, framing and people) aren't independent, so whole clusters are resampled, and each
 * resample's mean is over the scenes in it. With every cluster a single scene it is bootstrap.
 * Fewer than three clusters: no interval.
 */
export function clusterBootstrap(diffs: readonly number[], clusters: readonly string[], n = 4000, seed = 12345): [number, number] {
  const byCluster = new Map<string, number[]>();
  diffs.forEach((d, i) => { const g = byCluster.get(clusters[i]); if (g) g.push(d); else byCluster.set(clusters[i], [d]); });
  const groups = [...byCluster.values()];
  if (groups.length < 3) return [NaN, NaN];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < n; b++) {
    let t = 0, k = 0;
    for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(rand() * groups.length)]; for (const d of g) t += d; k += g.length; }
    means.push(t / k);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * n)], means[Math.floor(0.975 * n)]];
}
export const writeJson = (file: string, data: unknown) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); };
export const round = (v: number | null | undefined, digits = 4) => v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

/** Width and height of a baseline JPEG, from its SOF marker. */
export function jpegSize(file: string): { width: number; height: number } | null {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    let i = 2;
    while (i + 9 < n) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  } finally { closeSync(fd); }
}

export const frameFiles = (dir: string) => existsSync(path.join(dir, 'frames')) ? readdirSync(path.join(dir, 'frames')).filter(f => /^\d+\.jpg$/.test(f)).sort() : [];

/** Loads a rendered scene (or a fixture written in the same layout). */
export function loadScene(id: string, dir = sceneDir(id)): Scene {
  const spec = existsSync(path.join(dir, 'spec.json')) ? readJson<SceneSpec>(path.join(dir, 'spec.json')) : {};
  const meta = existsSync(path.join(dir, 'meta.json')) ? readJson<SceneMeta>(path.join(dir, 'meta.json')) : {};
  // A real clip has no GT: its frames still run (what can be measured without it: pingpong.ts).
  const gt = existsSync(path.join(dir, 'gt.jsonl')) ? readJsonl<GtFrame>(path.join(dir, 'gt.jsonl')) : [];
  const first = frameFiles(dir)[0];
  const size = (first && jpegSize(path.join(dir, 'frames', first)))
    || (meta.resolution && { width: meta.resolution[0], height: meta.resolution[1] })
    || (spec.resolution && (spec.camera?.orientation === 'portrait' && spec.resolution[0] > spec.resolution[1]
      ? { width: spec.resolution[1], height: spec.resolution[0] } : { width: spec.resolution[0], height: spec.resolution[1] }))
    || { width: 640, height: 480 };
  const fps = meta.fps ?? spec.fps ?? 30;
  const aspect = size.width / size.height;
  const scene: Scene = {
    id, dir, spec, meta, gt, byFrame: new Map(gt.map(f => [f.frame, f])),
    width: size.width, height: size.height, aspect, fps,
    players: spec.players ?? meta.players ?? Math.max(1, new Set(gt.flatMap(f => f.people.filter(p => p.role === 'player').map(p => p.id))).size),
    category: spec.category ?? meta.category ?? 'unknown',
    phases: spec.phases ?? meta.phases ?? [],
    focal: NaN, focalSource: '', focalFromGt: null,
    features: spec.room?.features ?? [],
  };
  const { focal, source } = focalOf(scene);
  scene.focal = focal; scene.focalSource = source;
  scene.focalFromGt = estimateFocal(gt, aspect);
  return scene;
}

/** The camera's focal length in picture heights: from meta's intrinsics, else the spec's field of view, else estimated from the GT. */
function focalOf(scene: Scene): { focal: number; source: string } {
  const m = scene.meta;
  const hfov = m.camera?.hfov_deg ?? scene.spec.camera?.hfov_deg;
  // Over 90 degrees the picture (and GT) are barrel-distorted after rendering, so the pinhole
  // intrinsics in meta are wrong for it: use the focal length the GT implies instead.
  const distorted = typeof hfov === 'number' && hfov > 90;
  const fx = m.intrinsics?.fx ?? m.camera?.intrinsics?.fx ?? m.camera?.fx_px ?? m.camera?.K?.[0]?.[0] ?? m.K?.[0]?.[0];
  if (!distorted && typeof fx === 'number' && fx > 0) return { focal: fx / scene.height, source: 'meta.intrinsics' };
  // (Over 90 degrees the generator adds barrel distortion, so a pinhole focal length is wrong there.)
  if (typeof hfov === 'number' && hfov > 0 && hfov <= 90) return { focal: scene.aspect / (2 * Math.tan(hfov * Math.PI / 360)), source: 'hfov' };
  const est = estimateFocal(scene.gt, scene.aspect);
  return { focal: est ?? 1.2, source: est ? 'gt-estimate' : 'default' };
}

/**
 * The focal length the GT implies: a torso's projected length times its depth over its 3D
 * length is the focal length when the torso is square to the camera, less otherwise; its 95th
 * percentile over the scene. Used as a fallback, and to check the GT against the spec.
 */
export function estimateFocal(gt: readonly GtFrame[], aspect: number): number | null {
  const ratios: number[] = [];
  for (const f of gt) for (const p of f.people) {
    if (!p.kp3d || torsoVisible(p) < 4) continue;
    const s = mid2(p.kp, 11, 12), h = mid2(p.kp, 23, 24);
    const len2 = Math.hypot((s.x - h.x) * aspect, s.y - h.y);
    const len3 = torso3d(p);
    const z = (p.kp[11][2] + p.kp[12][2] + p.kp[23][2] + p.kp[24][2]) / 4;
    if (len3 > 0.05 && z > 0) ratios.push(len2 * z / len3);
  }
  if (ratios.length < 10) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(0.95 * (ratios.length - 1))];
}

// ---------------------------------------------------------------- geometry

export const TORSO = [11, 12, 23, 24];
/** Shoulders, elbows, wrists, hips, knees, ankles. */
export const BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
/** MediaPipe left/right pairs (choreography.ts PAIRS). */
export const PAIRS: [number, number][] = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
export const MIRROR = (() => { const m = Array.from({ length: 33 }, (_, i) => i); for (const [a, b] of PAIRS) { m[a] = b; m[b] = a; } return m; })();
export const JOINT_GROUPS: Record<string, number[]> = {
  face: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], shoulders: [11, 12], elbows: [13, 14], wrists: [15, 16],
  hands: [17, 18, 19, 20, 21, 22], hips: [23, 24], knees: [25, 26], ankles: [27, 28], feet: [29, 30, 31, 32],
};

const mid2 = (kp: readonly (readonly number[])[], a: number, b: number) => ({ x: (kp[a][0] + kp[b][0]) / 2, y: (kp[a][1] + kp[b][1]) / 2 });
const inFrame = (j: GtJoint) => j[3] !== 3;
export const torsoVisible = (p: GtPerson) => TORSO.filter(i => inFrame(p.kp[i])).length;
export function torso3d(p: GtPerson) {
  const k = p.kp3d;
  const s = [0, 1, 2].map(c => (k[11][c] + k[12][c]) / 2), h = [0, 1, 2].map(c => (k[23][c] + k[24][c]) / 2);
  return Math.hypot(s[0] - h[0], s[1] - h[1], s[2] - h[2]);
}

/**
 * A GT person's size in the picture, in picture heights: their 3D torso length (shoulder
 * midpoint to hip midpoint) projected at their torso's depth. Unlike the 2D torso, it doesn't
 * shrink when they bend or turn, so errors in "torso lengths" mean the same on every frame.
 */
export function torsoScale(p: GtPerson, scene: Pick<Scene, 'focal' | 'aspect'>): number {
  const z = (p.kp[11][2] + p.kp[12][2] + p.kp[23][2] + p.kp[24][2]) / 4;
  const len = p.kp3d ? torso3d(p) : 0;
  if (len > 0.05 && z > 0.05) return scene.focal * len / z;
  // No 3D: the 2D torso (or shoulder width), like the tracker's body size.
  const s = mid2(p.kp, 11, 12), h = mid2(p.kp, 23, 24);
  return Math.max(Math.hypot((s.x - h.x) * scene.aspect, s.y - h.y), Math.hypot((p.kp[11][0] - p.kp[12][0]) * scene.aspect, p.kp[11][1] - p.kp[12][1]) / 0.75, 0.01);
}

/**
 * A GT person the game should find: at least three torso joints inside the picture and, when
 * the masks say, at least a quarter of them not hidden by others.
 */
export const present = (p: GtPerson) => p.in_frame !== false && torsoVisible(p) >= 3 && (p.visible_frac ?? 1) >= 0.25;
/** Fully in view: every body joint in the picture and nine tenths unhidden. */
export const fullyVisible = (p: GtPerson) => BODY.every(i => inFrame(p.kp[i])) && (p.visible_frac ?? 1) >= 0.9;

/**
 * How far a pose is from a GT person: the mean, over body joints inside the picture that the
 * pose has, of the joint distance (aspect-corrected) in the person's torso lengths, as labelled
 * or with left and right exchanged, whichever is nearer. Infinity with fewer than three joints
 * to compare.
 */
/** A pose's joints as any of the formats give them ([x, y, ...], or null when missing). */
export type PoseKp = readonly (readonly (number | null)[] | null)[];

export function poseDistance(kp: PoseKp, gt: GtPerson, scale: number, aspect: number, sides: 'as-labelled' | 'either' = 'either'): number {
  const at = (mirror: boolean) => {
    let sum = 0, n = 0;
    for (const i of BODY) {
      const d = kp[mirror ? MIRROR[i] : i], g = gt.kp[i];
      if (!d || !inFrame(g)) continue;
      sum += Math.hypot((d[0]! - g[0]) * aspect, d[1]! - g[1]); n++;
    }
    return n >= 3 ? sum / n / scale : Infinity;
  };
  // A pose with its left and right exchanged is still that person (the swap counts against its joints, not its detection).
  return sides === 'either' ? Math.min(at(false), at(true)) : at(false);
}

/**
 * Minimum-cost assignment of rows to columns (Hungarian / Kuhn-Munkres, O(n^3)) on a
 * rectangular cost matrix. Pairs costing more than gate (or Infinity) are left unassigned.
 * Returns, per row, its column or -1.
 */
export function hungarian(costs: readonly (readonly number[])[], gate = Infinity): number[] {
  const rows = costs.length, cols = rows ? costs[0].length : 0;
  if (!rows || !cols) return Array(rows).fill(-1);
  const n = Math.max(rows, cols), BIG = 1e9;
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    const c = i < rows && j < cols ? costs[i][j] : BIG;
    return Number.isFinite(c) && c <= gate ? c : BIG;
  }));
  const u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = Array(n + 1).fill(Infinity), used = Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = Array(rows).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] && p[j] - 1 < rows && j - 1 < cols && a[p[j] - 1][j - 1] < BIG) result[p[j] - 1] = j - 1;
  return result;
}

/** The match gate: a pose more than this many torso lengths (mean body joint distance) from a GT person isn't them. */
export const MATCH_GATE = 1.0;

/** Matches poses to GT people (Hungarian on poseDistance, gated). Returns per pose the GT person's index in frame.people, or -1, and the distance. */
export function matchPoses(poses: readonly PoseKp[], gt: GtFrame | undefined, scene: Pick<Scene, 'focal' | 'aspect'>, gate = MATCH_GATE) {
  const people = gt?.people ?? [];
  const scales = people.map(p => torsoScale(p, scene));
  const costs = poses.map(kp => people.map((p, j) => poseDistance(kp, p, scales[j], scene.aspect)));
  const assigned = hungarian(costs, gate);
  return assigned.map((j, i) => ({ person: j, distance: j >= 0 ? costs[i][j] : Infinity }));
}

export const percentile = (values: readonly number[], q: number) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
export const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** Seconds of a named phase of the spec, or null. */
export function phaseRange(scene: Scene, name: string): [number, number] | null {
  const ps = scene.phases.filter(p => p.name === name);
  if (!ps.length) return null;
  return [Math.min(...ps.map(p => p.start_s)) * 1000, Math.max(...ps.map(p => p.end_s)) * 1000];
}

/**
 * The dance window in ms: the spec's "dance" phase, else the span of frames where any player's
 * GT segment is a dance, else null.
 */
export function danceWindow(scene: Scene): [number, number] | null {
  const spec = phaseRange(scene, 'dance');
  if (spec) return spec;
  const ts = scene.gt.filter(f => f.people.some(p => p.role === 'player' && p.phase === 'dance')).map(f => f.t_ms);
  return ts.length ? [Math.min(...ts), Math.max(...ts)] : null;
}

/** Parses --flag value / --flag options after positional arguments. */
export function parseArgs(argv: string[], flags: Record<string, 'bool' | 'string'>) {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2);
      if (!(key in flags)) throw Error(`Unknown option --${key}`);
      if (flags[key] === 'bool') opts[key] = true;
      else opts[key] = inline ?? argv[++i];
    } else positional.push(a);
  }
  return { positional, opts };
}
