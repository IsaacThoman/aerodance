// The harness's metrics for sim2real scenes, pseudo-GT aware.
//   TRACKBENCH_DATA=<sim2real root> node tools/trackbench/sim2real/s2r_metrics.ts <estimator> [scene...]
// Same definitions as harness/metrics.ts, with one change for pseudo-GT (gt.jsonl people with
// `pgt_ok`): joints the reference models didn't agree on are treated as unknown for the
// keypoint metrics (and the offsets they learn), by marking them outside the picture in a
// strict copy of the scene; detection recall, tracking, identity and score use the full
// (filled) pseudo-GT. Exact-GT scenes (no `pgt_ok`) give exactly harness/metrics.ts's numbers.
// Writes runs/<estimator>/<scene>/metrics.json and s2r-frames.jsonl (per matched player-frame:
// pose conditions and offset-corrected body-joint errors, for the failure-mode analysis), and
// runs/<estimator>/_offsets.json, all inside the sim2real root.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  BODY, DATA, loadScene, matchPoses, readJsonl, round, runDir, sceneDir, torsoScale, writeJson, writeJsonl,
} from '../harness/common.ts';
import type { DetFrame, GtPerson, Scene, TrackedFrame } from '../harness/common.ts';
import { accumulateOffsets, detectionMetrics, finishOffsets, sceneMetrics, zeroOffsets } from '../harness/metrics.ts';
import { LIMBS, angleBetween, limbDirections, liveUsable } from '../../../packages/score/features.ts';
import type { Landmark } from '../../../packages/pose/choreography.ts';
import type { Offsets } from '../harness/metrics.ts';

/** The scene with every joint the references didn't agree on marked outside the picture. */
export function strictScene(scene: Scene): Scene {
  const gt = scene.gt.map(f => ({
    ...f, people: f.people.map(p => {
      const ok = (p as GtPerson & { pgt_ok?: number[] }).pgt_ok;
      return ok ? { ...p, kp: p.kp.map((k, j) => ok[j] ? k : [k[0], k[1], k[2], 3] as typeof k) } : p;
    }),
  }));
  return { ...scene, gt, byFrame: new Map(gt.map(f => [f.frame, f])) };
}

const scenesWithRuns = (estimator: string) => {
  const dir = path.join(DATA, 'runs', estimator);
  return existsSync(dir) ? readdirSync(dir).filter(s => existsSync(path.join(dir, s, 'detections.jsonl')) && existsSync(path.join(sceneDir(s), 'gt.jsonl'))).sort() : [];
};

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

/**
 * Pose conditions from the (filled) GT, defined in 2D so they mean the same for exact and
 * pseudo-GT: arms overhead (a wrist above the nose), back view (the person's left shoulder on
 * the picture's left by over a quarter of their scale: they face away), low (hip midpoint less
 * than 0.9 scales above the lower ankle: crouching or floor work).
 */
function conditions(g: GtPerson, scale: number, aspect: number) {
  const k = g.kp;
  const armsUp = Math.min(k[15][1], k[16][1]) < k[0][1];
  const back = (k[12][0] - k[11][0]) * aspect > 0.25 * scale;
  const hipY = (k[23][1] + k[24][1]) / 2, ankleY = Math.max(k[27][1], k[28][1]);
  const low = (ankleY - hipY) < 0.9 * scale;
  return { arms_up: armsUp, back, low };
}

function frameRows(scene: Scene, strict: Scene, dets: readonly DetFrame[], offsets: Offsets) {
  const rows: unknown[] = [];
  for (const f of dets) {
    const gtFull = scene.byFrame.get(f.frame), gtStrict = strict.byFrame.get(f.frame);
    if (!gtFull || !gtStrict) continue;
    // Matched on the full GT (as recall is); errors only on agreed joints.
    const match = matchPoses(f.people.map(p => p.kp), gtFull, scene);
    match.forEach(({ person }, i) => {
      if (person < 0) return;
      const g = gtFull.people[person], gs = gtStrict.people[person];
      if (g.role !== 'player') return;
      const s = torsoScale(g, scene), fr = torsoFrame(g, scene.aspect), A = scene.aspect;
      const err: (number | null)[] = BODY.map(j => {
        const d = f.people[i].kp[j];
        if (!d || gs.kp[j][3] === 3) return null;
        const ex = (d[0] - g.kp[j][0]) * A / s, ey = (d[1] - g.kp[j][1]) / s, o = offsets.joints[j];
        return round(Math.hypot(ex - (o.du * fr.ux + o.dv * fr.vx), ey - (o.du * fr.uy + o.dv * fr.vy)), 4);
      });
      const conf: (number | null)[] = BODY.map(j => f.people[i].kp[j]?.[3] ?? null);
      // Scored-limb angle errors as the harness computes them (raw), and with the estimator's mean
      // per-joint offset removed first (convention-corrected): limb directions mix accuracy with
      // where a model puts a joint, and the GT's joint definitions differ between domains.
      const kp = f.people[i].kp;
      const corrected = kp.map((d, j) => {
        if (!d) return d;
        const o = offsets.joints[j];
        const du = o.du * s, dv = o.dv * s;
        return [d[0] - (du * fr.ux + dv * fr.vx) / A, d[1] - (du * fr.uy + dv * fr.vy), d[2], d[3]] as typeof d;
      });
      const lm = (k: typeof kp): Landmark[] => k.map(p => p ? { x: p[0]!, y: p[1]!, z: 0, confidence: p[3] ?? null } : { x: 0, y: 0, z: 0, confidence: 0 });
      const gtDirs = limbDirections(lm(gs.kp.map(k => [k[0], k[1], 0, 1])), A, gs.kp.map(k => k[3] !== 3));
      const limbErr = (k: typeof kp) => {
        const l = lm(k);
        const dirs = limbDirections(l, A, liveUsable(l).map((u, j) => u && !!k[j]));
        return LIMBS.map((_, li) => gtDirs[li] && dirs[li] ? round(angleBetween(dirs[li]!, gtDirs[li]!) * 180 / Math.PI, 2) : null);
      };
      rows.push({ frame: f.frame, id: g.id, ...conditions(g, s, A), err, conf, limb: limbErr(kp), limb_c: limbErr(corrected) });
    });
  }
  return rows;
}

if (import.meta.main) {
  const [estimator, ...only] = process.argv.slice(2);
  if (!estimator) { console.error('usage: TRACKBENCH_DATA=<root> node s2r_metrics.ts <estimator> [scene...]'); process.exit(2); }
  const ids = scenesWithRuns(estimator);
  const scenes = new Map(ids.map(id => { const s = loadScene(id); return [id, { full: s, strict: strictScene(s) }]; }));
  const sums = zeroOffsets();
  for (const id of ids) accumulateOffsets(scenes.get(id)!.strict, readJsonl<DetFrame>(path.join(runDir(estimator, id), 'detections.jsonl')), sums);
  const offsets = finishOffsets(sums);
  writeJson(path.join(DATA, 'runs', estimator, '_offsets.json'), offsets);
  for (const id of only.length ? only : ids) {
    const { full, strict } = scenes.get(id)!;
    const dir = runDir(estimator, id);
    const dets = readJsonl<DetFrame>(path.join(dir, 'detections.jsonl'));
    const tracked = existsSync(path.join(dir, 'tracked.jsonl')) ? readJsonl<TrackedFrame>(path.join(dir, 'tracked.jsonl')) : [];
    const m = sceneMetrics(full, dets, tracked, offsets, estimator);
    const k = detectionMetrics(strict, dets, offsets);
    m.detection.keypoints = k.keypoints;
    m.detection.keypoints_dance = k.keypoints_dance;
    m.detection.jitter = k.jitter;
    (m as Record<string, unknown>).pseudo_gt = full.gt.some(f => f.people.some(p => 'pgt_ok' in p));
    writeJson(path.join(dir, 'metrics.json'), m);
    writeJsonl(path.join(dir, 's2r-frames.jsonl'), frameRows(full, strict, dets, offsets));
    const s = m.score;
    console.log(`${id}: recall ${m.detection.recall.players} pck20c ${m.detection.keypoints.body.pck20_corrected} limb ${m.detection.keypoints.limbs.mean_deg_weighted}° id ${m.tracking.after_numbering.identity_accuracy}` +
      (s ? ` score lost ${s.score_lost}` : ''));
  }
}
