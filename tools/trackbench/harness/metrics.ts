// Metrics for one estimator on one scene (README.md defines each one). As a command:
//   node tools/trackbench/harness/metrics.ts <estimator-id> [scene-id...]   (no scenes: every scene the estimator has run)
// First a pass over every scene the estimator has detections for learns its mean per-joint
// offset from the GT (runs/<estimator>/_offsets.json), then each scene's metrics.json is written.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { limbDirections, liveUsable, LIMBS, angleBetween } from '../../../packages/score/features.ts';
import type { Landmark } from '../../../packages/pose/choreography.ts';
import {
  BODY, DATA, JOINT_GROUPS, MIRROR, TORSO, danceWindow, fullyVisible, loadScene, matchPoses, mean, percentile, present, readJsonl,
  round, runDir, sceneDir, torsoScale, writeJson,
} from './common.ts';
import type { DetFrame, GtFrame, GtPerson, Joint, PoseKp, Scene, TrackedFrame } from './common.ts';
import { gtLandmarks, judgementChanges, referenceBundle, scoreRecords } from './score.ts';
import type { LiveRecord } from './score.ts';

export const METRICS_VERSION = 1;
/** A joint this close to the GT (torso lengths, offset-corrected) is correct, for confidence calibration. */
export const CORRECT = 0.2;
/** The game's joint confidence threshold. */
export const CONF = 0.5;
const ARMS = [13, 14, 15, 16], LEGS = [25, 26, 27, 28];
const DISTRACTOR_FEATURES = /mirror|tv|poster|coat|window|statue|mannequin|picture|photo/;

// ---------------------------------------------------------------- per-joint offsets

/** An estimator's mean per-joint offset from the GT, in the GT torso frame (u: the person's left, v: up the torso), in torso lengths. */
export interface Offsets { joints: { du: number; dv: number; n: number }[]; scenes: string[]; }
export const zeroOffsets = (): Offsets => ({ joints: Array.from({ length: 33 }, () => ({ du: 0, dv: 0, n: 0 })), scenes: [] });

/** The GT person's torso frame: v from the hip midpoint to the shoulder midpoint, u perpendicular, toward the person's left. */
function torsoFrame(p: GtPerson, aspect: number) {
  const k = p.kp;
  const sx = (k[11][0] + k[12][0]) / 2 * aspect, sy = (k[11][1] + k[12][1]) / 2, hx = (k[23][0] + k[24][0]) / 2 * aspect, hy = (k[23][1] + k[24][1]) / 2;
  let vx = sx - hx, vy = sy - hy;
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) { vx = 0; vy = -1; } else { vx /= len; vy /= len; }
  let ux = -vy, uy = vx;
  const lx = ((k[11][0] - k[12][0]) + (k[23][0] - k[24][0])) * aspect, ly = (k[11][1] - k[12][1]) + (k[23][1] - k[24][1]);
  if (ux * lx + uy * ly < 0) { ux = -ux; uy = -uy; }
  return { ux, uy, vx, vy };
}

/** Adds one scene's matched-player joint errors (joints not hidden by others or outside the picture) to an offsets sum. */
export function accumulateOffsets(scene: Scene, dets: readonly DetFrame[], sums: Offsets) {
  for (const f of dets) {
    const gt = scene.byFrame.get(f.frame);
    if (!gt) continue;
    const match = matchPoses(f.people.map(p => p.kp), gt, scene);
    match.forEach(({ person }, i) => {
      if (person < 0) return;
      const g = gt.people[person];
      if (g.role !== 'player') return;
      const s = torsoScale(g, scene), fr = torsoFrame(g, scene.aspect);
      f.people[i].kp.forEach((d, j) => {
        // (Visible or self-occluded: occlusion by others or the frame edge makes a model guess, which isn't its convention.)
        if (!d || g.kp[j][3] > 1) return;
        const ex = (d[0] - g.kp[j][0]) * scene.aspect / s, ey = (d[1] - g.kp[j][1]) / s;
        const o = sums.joints[j];
        o.du += ex * fr.ux + ey * fr.uy; o.dv += ex * fr.vx + ey * fr.vy; o.n++;
      });
    });
  }
  sums.scenes.push(scene.id);
}
export const finishOffsets = (sums: Offsets): Offsets =>
  ({ scenes: sums.scenes, joints: sums.joints.map(o => o.n ? { du: o.du / o.n, dv: o.dv / o.n, n: o.n } : { du: 0, dv: 0, n: 0 }) });

// ---------------------------------------------------------------- detection and keypoint metrics

class Stat {
  v: number[] = [];
  add(x: number) { this.v.push(x); }
  get n() { return this.v.length; }
  summary(digits = 4) { return { n: this.n, mean: round(mean(this.v), digits), median: round(percentile(this.v, 0.5), digits), p90: round(percentile(this.v, 0.9), digits) }; }
}
const rate = (num: number, den: number, digits = 4) => den ? round(num / den, digits) : null;

/** Joint accumulators for one bucket of matched player frames (all, or dance-only). */
class KeypointBucket {
  raw = new Stat(); corrected = new Stat();
  pck = { raw10: 0, raw20: 0, cor10: 0, cor20: 0, n: 0 };
  byVis = [0, 1, 2].map(() => ({ raw: new Stat(), cor: new Stat(), pck10: 0, pck20: 0, cor20: 0 }));
  perJoint = Array.from({ length: 33 }, () => ({ raw: new Stat(), cor: new Stat() }));
  conf = { sure: 0, sureWrong: 0, correct: 0, correctUnsure: 0, outside: 0, outsideSure: 0, missing: 0 };
  limbs = LIMBS.map(() => ({ err: new Stat(), gtUsable: 0, usable: 0 }));
  swaps = { eligible: 0, body: 0, armsEligible: 0, arms: 0, legsEligible: 0, legs: 0 };
  frames = 0;

  add(d: readonly (Joint | null)[], g: GtPerson, scene: Scene, offsets: Offsets | null) {
    this.frames++;
    const s = torsoScale(g, scene), fr = torsoFrame(g, scene.aspect), A = scene.aspect;
    const err = (j: number, gj = j) => { const p = d[j]; return p ? Math.hypot((p[0] - g.kp[gj][0]) * A, p[1] - g.kp[gj][1]) / s : NaN; };
    for (let j = 0; j < 33; j++) {
      const p = d[j], vis = g.kp[j][3];
      if (!p) { if (vis !== 3) this.conf.missing++; continue; }
      const conf = p[3] ?? 1;
      if (vis === 3) { this.conf.outside++; if (conf >= CONF) this.conf.outsideSure++; continue; }
      const ex = (p[0] - g.kp[j][0]) * A / s, ey = (p[1] - g.kp[j][1]) / s;
      const o = offsets?.joints[j];
      const cx = o ? ex - (o.du * fr.ux + o.dv * fr.vx) : ex, cy = o ? ey - (o.du * fr.uy + o.dv * fr.vy) : ey;
      const raw = Math.hypot(ex, ey), cor = Math.hypot(cx, cy);
      this.perJoint[j].raw.add(raw); this.perJoint[j].cor.add(cor);
      const bv = this.byVis[vis];
      if (bv) { bv.raw.add(raw); bv.cor.add(cor); if (raw < 0.1) bv.pck10++; if (raw < 0.2) bv.pck20++; if (cor < 0.2) bv.cor20++; }
      if (BODY.includes(j)) {
        this.raw.add(raw); this.corrected.add(cor); this.pck.n++;
        if (raw < 0.1) this.pck.raw10++; if (raw < 0.2) this.pck.raw20++; if (cor < 0.1) this.pck.cor10++; if (cor < 0.2) this.pck.cor20++;
      }
      // Confidence calibration on every joint inside the picture.
      if (conf >= CONF) { this.conf.sure++; if (cor > CORRECT) this.conf.sureWrong++; }
      if (cor <= CORRECT) { this.conf.correct++; if (conf < CONF) this.conf.correctUnsure++; }
    }
    // Limb directions as the scorer computes them: GT limbs inside the picture, the estimator's where the game would use them.
    const toLandmarks = (kp: PoseKp): Landmark[] => kp.map(p => p ? { x: p[0]!, y: p[1]!, z: 0, confidence: p[3] ?? null } : { x: 0, y: 0, z: 0, confidence: 0 });
    const gtDirs = limbDirections(toLandmarks(g.kp.map(k => [k[0], k[1], 0, 1])), A, g.kp.map(k => k[3] !== 3));
    const detLm = toLandmarks(d);
    const detDirs = limbDirections(detLm, A, liveUsable(detLm).map((u, j) => u && !!d[j]));
    gtDirs.forEach((gd, i) => {
      if (!gd) return;
      this.limbs[i].gtUsable++;
      const dd = detDirs[i];
      if (!dd) return;
      this.limbs[i].usable++;
      this.limbs[i].err.add(angleBetween(dd, gd) * 180 / Math.PI);
    });
    // Left/right swaps: is the pose nearer the GT with its sides exchanged?
    const sep = (joints: number[]) => mean(joints.filter(j => j % 2 === 1).map(j => Math.hypot((g.kp[j][0] - g.kp[MIRROR[j]][0]) * A, g.kp[j][1] - g.kp[MIRROR[j]][1]) / s)) ?? 0;
    const inside = (joints: number[]) => joints.every(j => g.kp[j][3] !== 3 && d[j]);
    const swapped = (joints: number[]) => {
      const a = mean(joints.map(j => err(j))), b = mean(joints.map(j => err(j, MIRROR[j])));
      return a !== null && b !== null && a > 0.25 && b < 0.6 * a;
    };
    if (inside(BODY) && sep(BODY) > 0.3) { this.swaps.eligible++; if (swapped(BODY)) this.swaps.body++; }
    if (inside(ARMS) && sep(ARMS) > 0.3) { this.swaps.armsEligible++; if (swapped(ARMS)) this.swaps.arms++; }
    if (inside(LEGS) && sep(LEGS) > 0.3) { this.swaps.legsEligible++; if (swapped(LEGS)) this.swaps.legs++; }
  }

  summary() {
    const c = this.conf;
    const groups = Object.fromEntries(Object.entries(JOINT_GROUPS).map(([name, joints]) => {
      const raw = joints.flatMap(j => this.perJoint[j].raw.v), cor = joints.flatMap(j => this.perJoint[j].cor.v);
      return [name, { n: raw.length, mean: round(mean(raw)), corrected: round(mean(cor)), pck20: rate(raw.filter(v => v < 0.2).length, raw.length), pck20_corrected: rate(cor.filter(v => v < 0.2).length, cor.length) }];
    }));
    let w = 0, sum = 0;
    this.limbs.forEach((l, i) => { const m = mean(l.err.v); if (m !== null) { sum += LIMBS[i].weight * m; w += LIMBS[i].weight; } });
    const allLimbs = this.limbs.flatMap(l => l.err.v);
    return {
      frames: this.frames,
      body: { error: this.raw.summary(), error_corrected: this.corrected.summary(),
        pck10: rate(this.pck.raw10, this.pck.n), pck20: rate(this.pck.raw20, this.pck.n), pck10_corrected: rate(this.pck.cor10, this.pck.n), pck20_corrected: rate(this.pck.cor20, this.pck.n) },
      by_vis: Object.fromEntries(this.byVis.map((b, vis) => [String(vis), { n: b.raw.n, mean: round(mean(b.raw.v)), corrected: round(mean(b.cor.v)), pck10: rate(b.pck10, b.raw.n), pck20: rate(b.pck20, b.raw.n), pck20_corrected: rate(b.cor20, b.raw.n) }])),
      groups,
      per_joint: this.perJoint.map(j => [round(mean(j.raw.v), 3), round(mean(j.cor.v), 3)]),
      limbs: {
        mean_deg_weighted: w ? round(sum / w, 2) : null, mean_deg: round(mean(allLimbs), 2), over30_frac: rate(allLimbs.filter(v => v > 30).length, allLimbs.length),
        usable_frac: rate(this.limbs.reduce((n, l) => n + l.usable, 0), this.limbs.reduce((n, l) => n + l.gtUsable, 0)),
        per_limb: Object.fromEntries(this.limbs.map((l, i) => [LIMBS[i].id, { mean_deg: round(mean(l.err.v), 2), p90_deg: round(percentile(l.err.v, 0.9), 2), usable_frac: rate(l.usable, l.gtUsable) }])),
      },
      swaps: { body: rate(this.swaps.body, this.swaps.eligible), body_frames: this.swaps.eligible, arms: rate(this.swaps.arms, this.swaps.armsEligible), legs: rate(this.swaps.legs, this.swaps.legsEligible) },
      confidence: {
        sure_wrong: rate(c.sureWrong, c.sure), correct_unsure: rate(c.correctUnsure, c.correct),
        outside_sure: rate(c.outsideSure, c.outside), missing_joints: c.missing,
      },
    };
  }
}

/** Detection and keypoint metrics for one scene. */
export function detectionMetrics(scene: Scene, dets: readonly DetFrame[], offsets: Offsets | null) {
  const recall = { players: 0, found: 0, danceP: 0, danceF: 0, fullP: 0, fullF: 0, byst: 0, bystFound: 0 };
  const fp = { duplicate: 0, mislocated: 0, distractor: 0, noise: 0 };
  let frames = 0, detections = 0;
  const distractors = scene.features.some(f => DISTRACTOR_FEATURES.test(f));
  const all = new KeypointBucket(), dance = new KeypointBucket();
  // For jitter: each GT player's matched pose by frame.
  const tracks = new Map<string, Map<number, (Joint | null)[]>>();
  for (const f of dets) {
    const gt = scene.byFrame.get(f.frame);
    if (!gt) continue;
    frames++; detections += f.people.length;
    const match = matchPoses(f.people.map(p => p.kp), gt, scene);
    const matchedPeople = new Set(match.map(m => m.person).filter(p => p >= 0));
    gt.people.forEach((p, j) => {
      if (!present(p)) return;
      const hit = matchedPeople.has(j);
      if (p.role === 'player') {
        recall.players++; if (hit) recall.found++;
        if (p.phase === 'dance') { recall.danceP++; if (hit) recall.danceF++; }
        if (fullyVisible(p)) { recall.fullP++; if (hit) recall.fullF++; }
      } else { recall.byst++; if (hit) recall.bystFound++; }
    });
    match.forEach(({ person }, i) => {
      const kp = f.people[i].kp;
      if (person >= 0) {
        const g = gt.people[person];
        if (g.role !== 'player') return;
        all.add(kp, g, scene, offsets);
        if (g.phase === 'dance') dance.add(kp, g, scene, offsets);
        if (!tracks.has(g.id)) tracks.set(g.id, new Map());
        tracks.get(g.id)!.set(f.frame, kp);
        return;
      }
      // An unmatched detection: on a GT person (a second copy of them, or too wrong to match), a distractor, or noise.
      const torso = TORSO.map(t => kp[t]).filter((p): p is Joint => !!p);
      const cx = mean(torso.map(p => p[0])), cy = mean(torso.map(p => p[1]));
      const on = cx === null || cy === null ? -1 : gt.people.findIndex(p => p.bbox && cx >= p.bbox[0] - 0.02 && cx <= p.bbox[2] + 0.02 && cy >= p.bbox[1] - 0.02 && cy <= p.bbox[3] + 0.02);
      if (on >= 0) { if (matchedPeople.has(on)) fp.duplicate++; else fp.mislocated++; }
      else if (distractors) fp.distractor++;
      else fp.noise++;
    });
  }
  // Jitter: acceleration over three consecutive frames, pose against GT.
  const jitter = { err: new Stat(), det: new Stat(), gt: new Stat() };
  for (const [id, byFrame] of tracks) for (const [n, kp] of byFrame) {
    const before = byFrame.get(n - 1), after = byFrame.get(n + 1);
    const g0 = scene.byFrame.get(n - 1)?.people.find(p => p.id === id), g1 = scene.byFrame.get(n)?.people.find(p => p.id === id), g2 = scene.byFrame.get(n + 1)?.people.find(p => p.id === id);
    if (!before || !after || !g0 || !g1 || !g2) continue;
    const s = torsoScale(g1, scene), A = scene.aspect;
    for (const j of BODY) {
      const a = before[j], b = kp[j], c = after[j];
      if (!a || !b || !c || [g0, g1, g2].some(g => g.kp[j][3] === 3)) continue;
      const ax = (a[0] - 2 * b[0] + c[0]) * A, ay = a[1] - 2 * b[1] + c[1];
      const gx = (g0.kp[j][0] - 2 * g1.kp[j][0] + g2.kp[j][0]) * A, gy = g0.kp[j][1] - 2 * g1.kp[j][1] + g2.kp[j][1];
      jitter.err.add(Math.hypot(ax - gx, ay - gy) / s); jitter.det.add(Math.hypot(ax, ay) / s); jitter.gt.add(Math.hypot(gx, gy) / s);
    }
  }
  const rms = (v: number[]) => v.length ? round(Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length)) : null;
  const per100 = (n: number) => frames ? round(100 * n / frames, 2) : null;
  return {
    frames, detections_per_frame: frames ? round(detections / frames, 3) : null,
    recall: { players: rate(recall.found, recall.players), player_frames: recall.players, dance: rate(recall.danceF, recall.danceP), fully_visible: rate(recall.fullF, recall.fullP), bystanders: rate(recall.bystFound, recall.byst) },
    false_positives_per_100_frames: { duplicate: per100(fp.duplicate), mislocated: per100(fp.mislocated), distractor: per100(fp.distractor), noise: per100(fp.noise) },
    keypoints: all.summary(), keypoints_dance: dance.summary(),
    jitter: { accel_error: jitter.err.summary(), accel_rms_pose: rms(jitter.det.v), accel_rms_gt: rms(jitter.gt.v), unit: `torso lengths per frame^2 at ${scene.fps} fps` },
  };
}

// ---------------------------------------------------------------- tracked players

/** A tracked joint the tracker filled in for a missing detection joint (toDetected) counts as missing. */
const trackedKp = (kp: readonly Joint[]) => kp.map(j => j[0] === 0 && j[1] === 0 && (j[3] ?? 1) === 0 ? null : j);
const torsoX = (p: GtPerson) => (p.kp[11][0] + p.kp[12][0] + p.kp[23][0] + p.kp[24][0]) / 4;

/**
 * Which GT person each player number should have: the GT players ordered right to left in the
 * raw frame (P1 on the left of the mirrored preview) at the record where the tracker first
 * numbered everyone; without one, at the first frame where every player is present, else by
 * their mean place.
 */
export function expectedNumbering(scene: Scene, tracked: readonly TrackedFrame[]): { mapping: string[]; at: number | null; source: string } {
  const ids = [...new Set(scene.gt.flatMap(f => f.people.filter(p => p.role === 'player').map(p => p.id)))];
  const order = (frame: GtFrame) => ids.map(id => ({ id, p: frame.people.find(q => q.id === id) })).sort((a, b) => (b.p ? torsoX(b.p) : -1) - (a.p ? torsoX(a.p) : -1)).map(x => x.id);
  const lined = tracked.find(r => r.lined && !r.dropped);
  const atLined = lined && scene.byFrame.get(lined.frame);
  if (atLined && ids.every(id => atLined.people.some(p => p.id === id))) return { mapping: order(atLined).slice(0, scene.players), at: lined.frame, source: 'lined' };
  const all = scene.gt.find(f => ids.every(id => f.people.some(p => p.id === id && present(p))));
  if (all) return { mapping: order(all).slice(0, scene.players), at: all.frame, source: 'all-present' };
  const meanX = (id: string) => mean(scene.gt.flatMap(f => f.people.filter(p => p.id === id).map(torsoX))) ?? 0;
  return { mapping: [...ids].sort((a, b) => meanX(b) - meanX(a)).slice(0, scene.players), at: null, source: 'mean-place' };
}

export function trackedMetrics(scene: Scene, tracked: readonly TrackedFrame[], mapping: string[]) {
  const records = tracked.filter(r => !r.dropped);
  const window = danceWindow(scene);
  const linedAt = records.find(r => r.lined)?.t_ms ?? null;
  type Cat = 'correct' | 'wrong_player' | 'bystander' | 'ghost' | 'lost';
  const counts = () => ({ trackable: 0, correct: 0, wrong_player: 0, bystander: 0, ghost: 0, lost: 0, phantom: 0 });
  const after = counts(), whole = counts(), dance = counts();
  const sequences = mapping.map(() => [] as string[]);
  const bystanderRuns = mapping.map(() => ({ frames: 0, events: 0, inRun: false }));
  let firstAll: number | null = null, firstAllCorrect: number | null = null;
  let numbering: { correct: boolean; players_correct: number } | null = null;
  for (const r of records) {
    const gt = scene.byFrame.get(r.frame);
    const match = matchPoses(r.poses.map(p => trackedKp(p.kp)), gt, scene);
    const who = new Map(r.poses.map((p, i) => [p.playerId, match[i].person >= 0 ? gt!.people[match[i].person] : null]));
    const inDance = window ? r.t_ms >= window[0] && r.t_ms <= window[1] : false;
    const allFound = mapping.length > 0 && r.poses.length === mapping.length;
    let allCorrect = allFound;
    mapping.forEach((id, k) => {
      const person = gt?.people.find(p => p.id === id);
      const trackable = !!person && present(person);
      const has = who.has(k), got = who.get(k);
      let cat: Cat | 'phantom' | null = null;
      if (trackable) cat = !has ? 'lost' : !got ? 'ghost' : got.id === id ? 'correct' : got.role === 'bystander' ? 'bystander' : 'wrong_player';
      else if (has) cat = got && got.id !== id ? (got.role === 'bystander' ? 'bystander' : 'wrong_player') : 'phantom';
      if (cat !== 'correct') allCorrect = false;
      if (got) sequences[k].push(got.id);
      const b = bystanderRuns[k];
      if (got?.role === 'bystander') { b.frames++; if (!b.inRun) b.events++; b.inRun = true; } else if (has || trackable) b.inRun = false;
      for (const [bucket, use] of [[whole, true], [after, r.lined], [dance, inDance]] as const) {
        if (!use || !cat) continue;
        if (trackable) bucket.trackable++;
        bucket[cat]++;
      }
    });
    if (firstAll === null && allFound) firstAll = r.t_ms;
    if (firstAllCorrect === null && allCorrect && r.lined) firstAllCorrect = r.t_ms;
    if (!numbering && r.lined && mapping.length) {
      const ok = mapping.filter((id, k) => who.get(k)?.id === id).length;
      numbering = { correct: ok === mapping.length, players_correct: ok };
    }
  }
  const switches = sequences.reduce((n, seq) => n + seq.filter((id, i) => i > 0 && id !== seq[i - 1]).length, 0);
  const inView = !mapping.length ? null : scene.gt.find(f => mapping.every(id => f.people.some(p => p.id === id && present(p))))?.t_ms ?? null;
  const summarize = (c: ReturnType<typeof counts>) => ({
    player_frames: c.trackable, identity_accuracy: rate(c.correct, c.trackable), lost: rate(c.lost, c.trackable),
    wrong_player: rate(c.wrong_player, c.trackable), bystander: rate(c.bystander, c.trackable), ghost: rate(c.ghost, c.trackable), phantom_frames: c.phantom,
  });
  return {
    records: records.length, lined_at_ms: linedAt, numbering,
    after_numbering: summarize(after), whole_scene: summarize(whole), dance: summarize(dance),
    identity_switches: switches,
    bystander_takeovers: { events: bystanderRuns.reduce((n, b) => n + b.events, 0), frames: bystanderRuns.reduce((n, b) => n + b.frames, 0) },
    all_in_view_ms: inView,
    all_tracked_ms: firstAll, all_tracked_delay_ms: firstAll !== null && inView !== null ? round(firstAll - inView, 1) : null,
    all_correct_ms: firstAllCorrect, all_correct_delay_ms: firstAllCorrect !== null && inView !== null ? round(firstAllCorrect - inView, 1) : null,
  };
}

export function calibrationMetrics(scene: Scene, tracked: readonly TrackedFrame[]) {
  const records = tracked.filter(r => !r.dropped && r.calib);
  if (!records.length) return null;
  const window = danceWindow(scene);
  let holds = 0, resets = 0, was = false, complete: number | null = null;
  for (const r of records) {
    const c = r.calib!;
    if (c.complete) { complete = r.t_ms; break; }
    // (Holds and resets count during setup: once the dance starts, nobody is holding still.)
    if (window && r.t_ms >= window[0]) continue;
    if (c.hold && !was) holds++;
    if (!c.hold && was) resets++;
    was = c.hold;
  }
  const ids = [...new Set(scene.gt.flatMap(f => f.people.filter(p => p.role === 'player').map(p => p.id)))];
  const holdStart = scene.gt.find(f => ids.length && ids.every(id => f.people.some(p => p.id === id && p.phase === 'hold')))?.t_ms ?? null;
  const holdEnd = holdStart === null ? null : scene.gt.find(f => f.t_ms > holdStart && ids.some(id => f.people.find(p => p.id === id)?.phase !== 'hold'))?.t_ms ?? null;
  return {
    complete_ms: complete, holds_started: holds, hold_resets: resets,
    tracking_refreshes: tracked.filter(r => r.reset).length,
    gt_hold_start_ms: holdStart, gt_hold_ms: holdStart !== null && holdEnd !== null ? round(holdEnd - holdStart, 1) : null, complete_after_hold_ms: complete !== null && holdStart !== null ? round(complete - holdStart, 1) : null,
    complete_before_dance: complete !== null && window ? complete <= window[0] : complete !== null ? true : false,
  };
}

// ---------------------------------------------------------------- score fidelity

const toLandmarks = (kp: readonly Joint[]): Landmark[] => kp.map(([x, y, z, c]) => ({ x, y, z, confidence: c }));

export function scoreMetrics(scene: Scene, tracked: readonly TrackedFrame[], mapping: string[]) {
  const window = danceWindow(scene);
  if (!window || !mapping.length) return null;
  const bundle = referenceBundle(scene, mapping, window);
  const aspect = scene.aspect;
  const records = tracked.filter(r => !r.dropped);
  const live: LiveRecord[] = records.map(r => ({ captureMs: r.t_ms, receivedMs: r.received_ms, poses: r.poses.map(p => ({ playerId: p.playerId, landmarks: toLandmarks(p.kp) })) }));
  const gtAt = (frame: GtFrame) => mapping.flatMap((id, playerId) => {
    const p = frame.people.find(q => q.id === id);
    return p && p.in_frame !== false ? [{ playerId, landmarks: gtLandmarks(p) }] : [];
  });
  const gtAll: LiveRecord[] = scene.gt.map(f => ({ captureMs: f.t_ms, receivedMs: f.t_ms, poses: gtAt(f) }));
  const gtSame: LiveRecord[] = records.flatMap(r => { const f = scene.byFrame.get(r.frame); return f ? [{ captureMs: r.t_ms, receivedMs: r.received_ms, poses: gtAt(f) }] : []; });
  const tr = scoreRecords(bundle, mapping.length, live, aspect);
  const ga = scoreRecords(bundle, mapping.length, gtAll, aspect);
  const gs = scoreRecords(bundle, mapping.length, gtSame, aspect);
  const per = mapping.map((id, k) => {
    const t = tr.results[k], g = ga.results[k], s = gs.results[k];
    return { player: k + 1, gt_person: id, gt_score: g.score, gt_same_times_score: s.score, tracked_score: t.score, lost: g.score - t.score,
      tracked_grade: t.grade, gt_grade: g.grade, tracked_coverage: round(t.coverage, 3), tracked_judgements: t.judgements, gt_judgements: g.judgements,
      tracked_mean_offset_ms: round(t.meanOffsetMs, 1) };
  });
  const avg = (f: (p: typeof per[number]) => number) => Math.round(per.reduce((n, p) => n + f(p), 0) / per.length);
  return {
    window_ms: window, max_score: 1_000_000,
    gt_score: avg(p => p.gt_score), gt_same_times_score: avg(p => p.gt_same_times_score), tracked_score: avg(p => p.tracked_score),
    score_lost: avg(p => p.lost), score_lost_frac: round(avg(p => p.lost) / Math.max(1, avg(p => p.gt_score)), 4),
    players: per, judgements: judgementChanges(ga.judgements, tr.judgements),
  };
}

// ---------------------------------------------------------------- cost

export function costMetrics(scene: Scene, dets: readonly DetFrame[], tracked: readonly TrackedFrame[]) {
  const inf = dets.map(d => d.inference_ms).filter((v): v is number => typeof v === 'number');
  const trips = dets.map(d => d.roundtrip_ms).filter((v): v is number => typeof v === 'number');
  const ts = scene.gt.map(f => f.t_ms);
  const durationS = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 1000 + 1 / scene.fps : 0;
  const kept = tracked.filter(r => !r.dropped).length;
  return {
    inference_ms: { mean: round(mean(inf), 2), p95: round(percentile(inf, 0.95), 2) },
    roundtrip_ms: trips.length ? { mean: round(mean(trips), 2), p95: round(percentile(trips, 0.95), 2) } : null,
    frames: scene.gt.length, processed: dets.length, dropped_results: tracked.filter(r => r.dropped).length,
    pose_rate_hz: durationS ? round(kept / durationS, 2) : null, camera_fps: scene.fps,
  };
}

// ---------------------------------------------------------------- one scene

export type SceneMetrics = ReturnType<typeof sceneMetrics>;
export function sceneMetrics(scene: Scene, dets: readonly DetFrame[], tracked: readonly TrackedFrame[], offsets: Offsets | null, estimator = '') {
  const numbering = expectedNumbering(scene, tracked);
  return {
    version: METRICS_VERSION, estimator, scene: scene.id, category: scene.category, players: scene.players,
    frame: { width: scene.width, height: scene.height, fps: scene.fps, focal_heights: round(scene.focal), focal_source: scene.focalSource, focal_from_gt: round(scene.focalFromGt) },
    expected_numbering: numbering,
    detection: detectionMetrics(scene, dets, offsets),
    tracking: trackedMetrics(scene, tracked, numbering.mapping),
    calibration: calibrationMetrics(scene, tracked),
    score: scoreMetrics(scene, tracked, numbering.mapping),
    cost: costMetrics(scene, dets, tracked),
    offsets_from: offsets ? offsets.scenes.length : 0,
    offsets_in_sample: offsets ? offsets.scenes.includes(scene.id) : null,
  };
}

// ---------------------------------------------------------------- command

const scenesWithRuns = (estimator: string) => {
  const dir = path.join(DATA, 'runs', estimator);
  return existsSync(dir) ? readdirSync(dir).filter(s => existsSync(path.join(dir, s, 'detections.jsonl')) && existsSync(path.join(sceneDir(s), 'gt.jsonl'))).sort() : [];
};

/**
 * Scenes the per-joint offsets are fitted on: the ten clean single-player genre scenes, frozen,
 * so corrected metrics elsewhere are held out and every estimator is corrected from the same
 * scenes. (Corrected metrics on these scenes themselves are in-sample.) An estimator that hasn't
 * run on them falls back to every scene it has, in-sample, and says so in _offsets.json.
 */
export const OFFSET_SCENES = /^base-genre-/;
export function suiteOffsets(estimator: string): Offsets {
  const sums = zeroOffsets();
  const all = scenesWithRuns(estimator), split = all.filter(s => OFFSET_SCENES.test(s));
  for (const id of split.length >= 5 ? split : all) accumulateOffsets(loadScene(id), readJsonl<DetFrame>(path.join(runDir(estimator, id), 'detections.jsonl')), sums);
  const offsets = finishOffsets(sums);
  writeJson(path.join(DATA, 'runs', estimator, '_offsets.json'), offsets);
  return offsets;
}

if (import.meta.main) {
  const [estimator, ...scenes] = process.argv.slice(2);
  if (!estimator) { console.error('usage: node tools/trackbench/harness/metrics.ts <estimator-id> [scene-id...]'); process.exit(2); }
  const offsets = suiteOffsets(estimator);
  console.log(`${estimator}: offsets from ${offsets.scenes.length} scenes`);
  for (const id of scenes.length ? scenes : scenesWithRuns(estimator)) {
    const dir = runDir(estimator, id);
    const tracked = existsSync(path.join(dir, 'tracked.jsonl')) ? readJsonl<TrackedFrame>(path.join(dir, 'tracked.jsonl')) : [];
    if (!tracked.length) console.warn(`${id}: no tracked.jsonl (run track.ts first); tracking metrics will be empty`);
    const m = sceneMetrics(loadScene(id), readJsonl<DetFrame>(path.join(dir, 'detections.jsonl')), tracked, offsets, estimator);
    writeJson(path.join(dir, 'metrics.json'), m);
    const s = m.score;
    console.log(`${id}: recall ${m.detection.recall.players} pck20c ${m.detection.keypoints.body.pck20_corrected} limb ${m.detection.keypoints.limbs.mean_deg_weighted}° id ${m.tracking.after_numbering.identity_accuracy} lost ${m.tracking.whole_scene.lost}` +
      (s ? ` score ${s.tracked_score}/${s.gt_score} (lost ${s.score_lost})` : '') + (m.calibration ? ` calib ${m.calibration.complete_ms ?? 'never'}` : ''));
  }
}
