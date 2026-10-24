// Review aids: intervals of a dance worth a look, each with a time range, a reason and a fix to
// try. They point at likely mistakes (jumps, stretched limbs, sliding feet, motion the character
// can't show, poses that disagree with the tracked video); an intended sharp accent or a
// deliberate difference from the video can be fine, so nothing here changes the dance.
import { LIMBS, angleBetween, limbDirections } from '../../packages/score/features.ts';
import type { LimbDirections } from '../../packages/score/features.ts';
import type { Landmark } from '../../packages/pose/choreography.ts';
import { createEvaluator, isKeyed } from './evaluate.ts';
import { aspectOf, baseLayer, MID_JOINTS } from './format.ts';
import type { Dance, Dancer, PointControl } from './format.ts';
import { mirrorRig, rigToLandmarks, screenLength } from './rig.ts';
import type { RigPose } from './rig.ts';
import { formatTime, songToVideo } from './time.ts';
import type { TrackingData } from './tracking.ts';

export type Severity = 'error' | 'warning' | 'info';
export interface Finding {
  kind: string; severity: Severity;
  dancer: string | null; control: string | null;
  /** Song time. */
  startMs: number; endMs: number;
  message: string;
  /** An op or command to try. */
  fix: string | null;
}
export interface CheckOptions {
  /** Tracking by id, to compare the dance with the video. */
  tracking?: (id: string) => TrackingData | null;
  range?: [number, number];
  stepMs?: number;
}
const DEG = 180 / Math.PI;
const SEGMENTS: readonly { name: string; a: PointControl; b: PointControl; length: 'upperArm' | 'forearm' | 'thigh' | 'shin' }[] = [
  { name: 'left upper arm', a: 'leftShoulder', b: 'leftElbow', length: 'upperArm' },
  { name: 'left forearm', a: 'leftElbow', b: 'leftWrist', length: 'forearm' },
  { name: 'right upper arm', a: 'rightShoulder', b: 'rightElbow', length: 'upperArm' },
  { name: 'right forearm', a: 'rightElbow', b: 'rightWrist', length: 'forearm' },
  { name: 'left thigh', a: 'leftHip', b: 'leftKnee', length: 'thigh' },
  { name: 'left shin', a: 'leftKnee', b: 'leftAnkle', length: 'shin' },
  { name: 'right thigh', a: 'rightHip', b: 'rightKnee', length: 'thigh' },
  { name: 'right shin', a: 'rightKnee', b: 'rightAnkle', length: 'shin' },
];
const MOVING: readonly PointControl[] = ['head', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle', 'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'leftHip', 'rightHip'];

/** Collects runs of flagged samples into findings, joining runs closer than joinMs. */
class Runs {
  private open = new Map<string, { start: number; end: number; worst: number; detail: string; make: (r: { start: number; end: number; worst: number; detail: string }) => Finding }>();
  readonly done: Finding[] = [];
  private readonly joinMs: number;
  private readonly minMs: number;
  constructor(joinMs = 120, minMs = 0) { this.joinMs = joinMs; this.minMs = minMs; }
  /** Flags [t, until] (until defaults to t). */
  flag(key: string, t: number, worst: number, detail: string, make: (r: { start: number; end: number; worst: number; detail: string }) => Finding, until = t) {
    const run = this.open.get(key);
    if (run && t - run.end <= this.joinMs) {
      run.end = Math.max(run.end, until);
      if (worst > run.worst) { run.worst = worst; run.detail = detail; }
      return;
    }
    if (run) this.close(key);
    this.open.set(key, { start: t, end: until, worst, detail, make });
  }
  close(key: string) {
    const run = this.open.get(key);
    if (!run) return;
    this.open.delete(key);
    if (run.end - run.start >= this.minMs) this.done.push(run.make(run));
  }
  finish() { for (const key of [...this.open.keys()]) this.close(key); return this.done; }
}
const usableAll = Array<boolean>(33).fill(true);
/** Weighted mean angle (degrees) between two sets of limb directions, and the worst limb. */
export function directionError(a: LimbDirections, b: LimbDirections): { mean: number; worst: string; worstDeg: number } | null {
  let sum = 0, weight = 0, worst = '', worstDeg = 0;
  LIMBS.forEach((limb, i) => {
    const da = a[i], db = b[i];
    if (!da || !db) return;
    const deg = angleBetween(da, db) * DEG;
    sum += deg * limb.weight; weight += limb.weight;
    if (deg > worstDeg) { worstDeg = deg; worst = limb.id; }
  });
  return weight ? { mean: sum / weight, worst, worstDeg } : null;
}

export function checkDance(dance: Dance, { tracking, range, stepMs = 1000 / 60 }: CheckOptions = {}): Finding[] {
  const [start, end] = range ?? [dance.song.playableStartMs, dance.song.playableEndMs];
  const aspect = aspectOf(dance), findings: Finding[] = [];
  for (const dancer of dance.dancers) {
    const evaluator = createEvaluator(dance, dancer), body = dancer.body;
    const keyed = Object.values(baseLayer(dancer).channels).some(k => k.length);
    if (!keyed) findings.push({ kind: 'no-keys', severity: 'warning', dancer: dancer.id, control: null, startMs: start, endMs: end,
      message: `${dancer.id} has no keys and stands in the neutral pose`, fix: `{"op":"pose","dancer":"${dancer.id}","t":${start},"from":"tracking"} or key it by hand` });
    for (const joint of Object.keys(MID_JOINTS)) if (keyed && !isKeyed(dancer, joint))
      findings.push({ kind: 'auto-joint', severity: 'info', dancer: dancer.id, control: joint, startMs: start, endMs: end,
        message: `${dancer.id} ${joint} has no keys, so it bends automatically; the scorer compares it, so key it where the video shows it`,
        fix: `{"op":"key","dancer":"${dancer.id}","t":…,"set":{"${joint}":[x, y]}}` });
    const tracked = trackingFor(dance, dancer, tracking);
    const runs = new Runs(), slow = new Runs(150, 100), drift = new Runs(1, 0);
    let prev: RigPose | null = null, prevT = 0;
    const samples: { t: number; rig: RigPose; landmarks: Landmark[] }[] = [];
    for (let t = start; t <= end + 1e-6; t += stepMs) samples.push({ t, rig: evaluator.rig(t), landmarks: evaluator.landmarks(t) });
    const floorY = median(samples.map(s => Math.max(s.rig.points.leftAnkle[1], s.rig.points.rightAnkle[1])));
    const make = (kind: string, severity: Severity, control: string | null, message: (w: number, d: string) => string, fix: string | null) =>
      (r: { start: number; end: number; worst: number; detail: string }): Finding => ({ kind, severity, dancer: dancer.id, control,
        startMs: Math.round(r.start), endMs: Math.round(r.end), message: message(r.worst, r.detail), fix });
    const dancerT = (t: number) => t - dancer.timeOffsetMs;
    for (const { t, rig } of samples) {
      const P = rig.points;
      for (const s of SEGMENTS) {
        const ratio = screenLength(P[s.a], P[s.b], aspect) / body[s.length];
        if (ratio > 1.15) runs.flag(`stretch-${s.name}`, t, ratio, '', make('stretched-limb', 'warning', s.b,
          w => `${dancer.id}'s ${s.name} is ${w.toFixed(2)}× its length on screen: a limb can't stretch. Key ${s.b} (or ${s.a}) closer, or refit the body if it's measured too short`,
          `{"op":"key","dancer":"${dancer.id}","t":…,"set":{"${s.b}":[x, y]}}`));
        if (ratio < 0.2) slow.flag(`short-${s.name}`, t, ratio, '', make('end-on-limb', 'info', s.b,
          () => `${dancer.id}'s ${s.name} points almost straight at the camera; its scoring direction is unstable there`, null));
      }
      // The character leans its body at most 0.65 rad; its head turns and tilts within limits too.
      const hip = mid(P.leftHip, P.rightHip), sh = mid(P.leftShoulder, P.rightShoulder);
      const roll = Math.abs(Math.atan2((sh[0] - hip[0]) * aspect, hip[1] - sh[1]));
      if (roll > 0.65) slow.flag('lean', t, roll * DEG, '', make('character-limit', 'info', 'torso',
        w => `${dancer.id} leans ${w.toFixed(0)}° from upright; the character leans at most 37°`, null));
      for (const side of ['leftAnkle', 'rightAnkle'] as const)
        if (P[side][1] > floorY + 0.04) slow.flag(`below-${side}`, t, P[side][1] - floorY, '', make('character-limit', 'info', side,
          w => `${dancer.id}'s ${side} is ${w.toFixed(3)} frame heights below the floor line; the character's foot stops at the floor`, null));
      if (prev) {
        const dt = (t - prevT) / 1000;
        for (const c of MOVING) {
          const speed = screenLength(prev.points[c], P[c], aspect) / dt;
          if (speed > 6) runs.flag(`fast-${c}`, t, speed, '', make('jump', 'warning', c,
            w => `${dancer.id} ${c} moves ${w.toFixed(1)} frame heights per second: a jump or pop, not a movement. Smooth the keys, or mark an intended step with interp "hold"`,
            `{"op":"interp","dancer":"${dancer.id}","range":"…","controls":["${c}"],"interp":"smooth"}`));
        }
        for (const side of ['leftAnkle', 'rightAnkle'] as const) {
          const grounded = P[side][1] > floorY - 0.015;
          const planted = dancer.contacts.some(c => c.control === side && dancerT(t) >= c.startMs && dancerT(t) <= c.endMs);
          const speed = Math.abs(P[side][0] - prev.points[side][0]) * aspect / dt;
          if (grounded && !planted && speed > 0.25) slow.flag(`slide-${side}`, t, speed, '', make('foot-slide', 'warning', side,
            w => `${dancer.id}'s ${side} slides along the floor at up to ${w.toFixed(2)} frame heights per second; plant it if the foot is still in the video`,
            `{"op":"contact","dancer":"${dancer.id}","control":"${side}","start":…,"end":…}`));
        }
      }
      prev = rig; prevT = t;
    }
    // Contacts that pull the animation a long way at their start.
    const free = createEvaluator(dance, dancer, { contacts: false });
    for (const c of dancer.contacts) {
      const anchor = free.rigAt(c.startMs).points[c.control];
      for (const at of [c.startMs - c.blendMs, c.endMs + c.blendMs]) {
        const off = screenLength(anchor, free.rigAt(at).points[c.control], aspect);
        if (off > 0.05) findings.push({ kind: 'contact-pull', severity: 'info', dancer: dancer.id, control: c.control,
          startMs: at + dancer.timeOffsetMs, endMs: at + dancer.timeOffsetMs,
          message: `Contact ${c.id} pulls ${c.control} ${off.toFixed(3)} frame heights at ${formatTime(at, dance)}; key the ${c.control} where it lands and leaves`, fix: null });
      }
    }
    // Compare with the tracked video.
    if (tracked) {
      const windowMs = 500;
      for (let w = start; w < end; w += windowMs) {
        let sum = 0, mirroredSum = 0, n = 0, worst = '', worstDeg = 0;
        for (const s of samples) {
          if (s.t < w || s.t >= w + windowMs) continue;
          const live = tracked.data.poseAt(tracked.slot, songToVideo(dance, s.t));
          if (!live) continue;
          const usable = live.map(l => l.confidence === null || l.confidence >= 0.5);
          const ref = limbDirections(live, aspect, usable);
          const e = directionError(limbDirections(s.landmarks, aspect, usableAll), ref);
          const m = directionError(limbDirections(rigToLandmarks(mirrorRig(s.rig, s.rig.points.leftHip[0] / 2 + s.rig.points.rightHip[0] / 2), body, aspect), aspect, usableAll), ref);
          if (!e || !m) continue;
          sum += e.mean; mirroredSum += m.mean; n++;
          if (e.worstDeg > worstDeg) { worstDeg = e.worstDeg; worst = e.worst; }
        }
        if (n < 3) continue;
        const mean = sum / n, mirrored = mirroredSum / n;
        const until = Math.min(end, w + windowMs);
        if (mean > 25) drift.flag('drift', w, mean, worst, make('video-mismatch', 'warning', null,
          (v, d) => `${dancer.id}'s limbs point ${v.toFixed(0)}° away from the tracked video on average (worst: ${d})`,
          `dance frames <project> --range … --views overlay --reference to compare`), until);
        if (mirrored + 15 < mean) drift.flag('mirror', w, mean - mirrored, '', make('left-right', 'warning', null,
          v => `${dancer.id} matches the video ${v.toFixed(0)}° better with left and right swapped: the dancer's left is image right in an unmirrored video`,
          `{"op":"mirror","dancer":"${dancer.id}","range":"…","about":"self"}`), until);
      }
    }
    findings.push(...runs.finish(), ...slow.finish(), ...drift.finish());
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.startMs - b.startMs);
}
function trackingFor(dance: Dance, dancer: Dancer, lookup: CheckOptions['tracking']) {
  if (!lookup) return null;
  for (const source of dance.sources.tracking) {
    const slot = source.dancers.indexOf(dancer.id);
    const data = slot >= 0 ? lookup(source.id) : null;
    if (data) return { data, slot };
  }
  return null;
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const mid = (a: readonly number[], b: readonly number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export interface Comparison {
  dancer: string;
  /** One row per window: the mean angle (degrees) between the dance's and the video's direction for each scored limb. */
  windows: { startMs: number; endMs: number; mean: number; limbs: Record<string, number | null> }[];
  /** Over the whole range. */
  limbs: Record<string, number | null>;
}
/** How far each scored limb points from the tracked video, per window: where to look first. */
export function compareToTracking(dance: Dance, lookup: (id: string) => TrackingData | null, { range, windowMs = 500, stepMs = 1000 / 30 }:
  { range?: [number, number]; windowMs?: number; stepMs?: number } = {}): Comparison[] {
  const [start, end] = range ?? [dance.song.playableStartMs, dance.song.playableEndMs];
  const aspect = aspectOf(dance), out: Comparison[] = [];
  for (const dancer of dance.dancers) {
    const tracked = trackingFor(dance, dancer, lookup);
    if (!tracked) continue;
    const evaluator = createEvaluator(dance, dancer);
    const total = LIMBS.map(() => ({ sum: 0, n: 0 }));
    const windows: Comparison['windows'] = [];
    for (let w = start; w < end - 1e-6; w += windowMs) {
      const sums = LIMBS.map(() => ({ sum: 0, n: 0 }));
      for (let t = w; t < Math.min(end, w + windowMs) - 1e-6; t += stepMs) {
        const live = tracked.data.poseAt(tracked.slot, songToVideo(dance, t));
        if (!live) continue;
        const ref = limbDirections(live, aspect, live.map(l => l.confidence === null || l.confidence >= 0.5));
        const mine = limbDirections(evaluator.landmarks(t), aspect, usableAll);
        LIMBS.forEach((_, i) => {
          const a = mine[i], b = ref[i];
          if (!a || !b) return;
          const deg = angleBetween(a, b) * DEG;
          sums[i].sum += deg; sums[i].n++; total[i].sum += deg; total[i].n++;
        });
      }
      const limbs = Object.fromEntries(LIMBS.map((l, i) => [l.id, sums[i].n ? Math.round(sums[i].sum / sums[i].n * 10) / 10 : null]));
      const weighted = LIMBS.reduce((acc, l, i) => sums[i].n ? { s: acc.s + l.weight * sums[i].sum / sums[i].n, w: acc.w + l.weight } : acc, { s: 0, w: 0 });
      windows.push({ startMs: Math.round(w), endMs: Math.round(Math.min(end, w + windowMs)), mean: weighted.w ? Math.round(weighted.s / weighted.w * 10) / 10 : NaN, limbs });
    }
    out.push({ dancer: dancer.id, windows, limbs: Object.fromEntries(LIMBS.map((l, i) => [l.id, total[i].n ? Math.round(total[i].sum / total[i].n * 10) / 10 : null])) });
  }
  return out;
}
