// Synthetic scenes in the contract's layout (spec.json, meta.json, gt.jsonl; no frames) for the
// harness tests: stick-figure people with a 3D skeleton projected through a pinhole camera, so
// 2D GT, depths and 3D GT agree like a render's would.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson, writeJsonl } from './common.ts';
import type { DetFrame, GtFrame, GtJoint, GtPerson, Joint } from './common.ts';

export interface FixturePerson {
  id: string; role?: 'player' | 'bystander';
  /** Stage x, y (metres) over time. */
  at: (t: number) => [number, number];
  /** Seconds of holding still before dancing (the calibration hold). */
  holdS?: number;
  /** Phase offset of the dance (radians), so people dance differently. */
  style?: number;
  /** Seconds during which the person is off stage. */
  absent?: (t: number) => boolean;
}
export interface FixtureOptions {
  id?: string; durationS?: number; fps?: number; width?: number; height?: number; hfov?: number;
  camera?: { distance: number; height: number };
  people: FixturePerson[]; players?: number;
  holdS?: number;
}

type V3 = [number, number, number];

/** The 33 MediaPipe joints of a person standing at (x, y) facing the camera, in stage metres, posed at dance time t. */
function skeleton(x: number, y: number, t: number, dancing: boolean, style: number): V3[] {
  const j: V3[] = Array.from({ length: 33 }, () => [0, 0, 0]);
  const w = (k: number) => dancing ? Math.sin(2 * Math.PI * 0.6 * t + style + k) : 0;
  const sway = dancing ? 0.05 * Math.sin(2 * Math.PI * 0.3 * t + style) : 0;
  const cx = x + sway;
  const hipZ = 0.95 - (dancing ? 0.04 * (1 + w(1)) : 0), shZ = hipZ + 0.5, headZ = shZ + 0.25;
  // The person's left is the camera's right (+x).
  const set = (i: number, p: V3) => { j[i] = p; };
  set(11, [cx + 0.19, y, shZ]); set(12, [cx - 0.19, y, shZ]);
  set(23, [cx + 0.11, y, hipZ]); set(24, [cx - 0.11, y, hipZ]);
  // Arms in the frontal plane: angle from hanging down, outward.
  const arm = (side: 1 | -1, sh: V3, a: number, b: number, wrist: number) => {
    const up = 0.3, fore = 0.27;
    const e: V3 = [sh[0] + side * up * Math.sin(a), sh[1] - 0.02, sh[2] - up * Math.cos(a)];
    const w2: V3 = [e[0] + side * fore * Math.sin(a + b), e[1] - 0.04, e[2] - fore * Math.cos(a + b)];
    set(wrist - 2, e); set(wrist, w2);
    const dir: V3 = [side * Math.sin(a + b), 0, -Math.cos(a + b)];
    const hand = (i: number, off: number, len: number) => set(i, [w2[0] + dir[0] * len + off, w2[1] - 0.02, w2[2] + dir[2] * len]);
    hand(wrist + 2, side * 0.02, 0.09); hand(wrist + 4, 0, 0.1); hand(wrist + 6, -side * 0.03, 0.06);
  };
  arm(1, j[11], 0.35 + (dancing ? 1.1 * (1 + w(0)) : 0), dancing ? 0.6 * (1 + w(2)) : 0.1, 15);
  arm(-1, j[12], 0.35 + (dancing ? 1.1 * (1 + w(3)) : 0), dancing ? 0.6 * (1 + w(4)) : 0.1, 16);
  const leg = (side: 1 | -1, hip: V3, i: number, k: number) => {
    const bend = dancing ? 0.25 * (1 + w(k)) : 0;
    const knee: V3 = [hip[0] + side * 0.03, hip[1] - 0.45 * Math.sin(bend), hip[2] - 0.45 * Math.cos(bend)];
    const ankle: V3 = [knee[0], hip[1], Math.max(0.08, knee[2] - 0.42)];
    set(i, knee); set(i + 2, ankle); set(i + 4, [ankle[0], ankle[1] + 0.06, 0.03]); set(i + 6, [ankle[0], ankle[1] - 0.16, 0.02]);
  };
  leg(1, j[23], 25, 5); leg(-1, j[24], 26, 6);
  const head = (i: number, dx: number, dz: number) => set(i, [cx + dx, y - 0.1, headZ + dz]);
  head(0, 0, -0.02);
  head(1, 0.02, 0.02); head(2, 0.035, 0.02); head(3, 0.05, 0.02); head(4, -0.02, 0.02); head(5, -0.035, 0.02); head(6, -0.05, 0.02);
  set(7, [cx + 0.075, y - 0.02, headZ + 0.01]); set(8, [cx - 0.075, y - 0.02, headZ + 0.01]);
  head(9, 0.025, -0.06); head(10, -0.025, -0.06);
  return j;
}

/** Builds a fixture scene and writes it to a fresh temporary directory; returns the directory. */
export function writeFixtureScene(o: FixtureOptions, dir = mkdtempSync(path.join(os.tmpdir(), 'trackbench-'))): string {
  const { id = 'fixture', durationS = 10, fps = 30, width = 640, height = 480, hfov = 65, camera = { distance: 3.4, height: 1.0 }, holdS = 3.5 } = o;
  const aspect = width / height, fw = 0.5 / Math.tan(hfov * Math.PI / 360);
  const players = o.players ?? o.people.filter(p => (p.role ?? 'player') === 'player').length;
  const project = ([x, y, z]: V3): [number, number, number] => {
    const X = x, Y = -(z - camera.height), Z = y + camera.distance;
    return [0.5 + fw * X / Z, 0.5 + fw * aspect * Y / Z, Z];
  };
  const frames: GtFrame[] = [];
  const n = Math.round(durationS * fps);
  for (let f = 1; f <= n; f++) {
    const t = (f - 1) / fps;
    const people: GtPerson[] = [];
    o.people.forEach((p, index) => {
      if (p.absent?.(t)) return;
      const hold = p.holdS ?? holdS, dancing = t >= hold;
      const [x, y] = p.at(t);
      const k3 = skeleton(x, y, t - hold, dancing, p.style ?? index * 1.7);
      const kp: GtJoint[] = k3.map(v => { const [u, w, d] = project(v); return [u, w, d, u < 0 || u > 1 || w < 0 || w > 1 ? 3 : 0]; });
      const xs = kp.map(k => k[0]), ys = kp.map(k => k[1]);
      const clip = (v: number) => Math.min(1, Math.max(0, v));
      const bbox: [number, number, number, number] = [clip(Math.min(...xs) - 0.02), clip(Math.min(...ys) - 0.04), clip(Math.max(...xs) + 0.02), clip(Math.max(...ys) + 0.01)];
      people.push({ id: p.id, role: p.role ?? 'player', index, kp, kp3d: k3, bbox, visible_frac: 1, in_frame: kp.some(k => k[3] !== 3), phase: dancing ? 'dance' : 'hold' });
    });
    frames.push({ frame: f, t_ms: (f - 1) * 1000 / fps, people });
  }
  mkdirSync(dir, { recursive: true });
  const spec = { id, category: 'fixture', duration_s: durationS, fps, resolution: [width, height], players,
    camera: { height_m: camera.height, distance_m: camera.distance, hfov_deg: hfov }, room: { features: [] },
    phases: [{ name: 'setup', start_s: 0, end_s: holdS }, { name: 'dance', start_s: holdS, end_s: durationS }] };
  writeJson(path.join(dir, 'spec.json'), spec);
  writeJson(path.join(dir, 'meta.json'), { fps, resolution: [width, height], frames: n });
  writeJsonl(path.join(dir, 'gt.jsonl'), frames);
  return dir;
}

/** A Gaussian random source (seeded). */
export function gaussian(seed = 1) {
  let s = seed;
  const u = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

export interface PerfectOptions {
  /** Adds to each joint, given the GT person and joint: [dx, dy] in picture fractions. */
  perturb?: (p: GtPerson, joint: number, frame: GtFrame) => [number, number];
  /** Drops a person from a frame's detections. */
  drop?: (p: GtPerson, frame: GtFrame) => boolean;
  /** Exchanges left and right joint labels. */
  mirrorLabels?: (p: GtPerson, frame: GtFrame) => boolean;
  /** Whether bystanders are detected too (default true). */
  bystanders?: boolean;
}

/** The "perfect estimator": the GT as detections (joints outside the picture unsure), optionally perturbed. */
export function perfectDetections(gt: readonly GtFrame[], o: PerfectOptions = {}): DetFrame[] {
  const MIRROR = [0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31];
  return gt.map(f => ({
    frame: f.frame, t_ms: f.t_ms, inference_ms: 10,
    people: f.people.filter(p => p.in_frame && !(o.drop?.(p, f)) && (o.bystanders !== false || p.role === 'player')).map(p => {
      const mirror = o.mirrorLabels?.(p, f);
      return { score: 1, kp: p.kp.map((_, j): Joint => {
        const src = p.kp[mirror ? MIRROR[j] : j];
        const [dx, dy] = o.perturb?.(p, j, f) ?? [0, 0];
        return [src[0] + dx, src[1] + dy, 0, src[3] === 3 ? 0.1 : 0.95];
      }) };
    }),
  }));
}
