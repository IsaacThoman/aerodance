// Would the scorer lose fewer points to tracking if it treated live poses differently?
// For every scene with a dance and every estimator's tracked.jsonl, scores the tracked poses
// with live-pose treatments applied before the game's scorer:
//   - against the right reference (the player's own GT dance): points kept, should go UP;
//   - against a wrong reference (the same dancer's GT shifted by WRONG_SHIFT_MS in the dance,
//     i.e. dancing other moves of the same song): should stay LOW, or the treatment just
//     hands out points.
// GT poses as live input give the controls for the right dance, wrong moves and standing still.
//
//   node tools/trackbench/studies/score-robustness.ts [--estimators a,b] [--scenes prefix,...] [--out file]
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Landmark } from '../../../packages/pose/choreography.ts';
import { DATA, danceWindow, loadScene, parseArgs, readJson, readJsonl, runDir, writeJson } from '../harness/common.ts';
import type { GtFrame, Joint, Scene, TrackedFrame } from '../harness/common.ts';
import { gtLandmarks, referenceBundle, scoreRecords } from '../harness/score.ts';
import type { LiveRecord } from '../harness/score.ts';

const WRONG_SHIFT_MS = 4000;

type Treat = (frames: { t: number; poses: { playerId: number; landmarks: Landmark[] }[] }[]) => void;
const clone = (l: Landmark): Landmark => ({ ...l });

/** Hold each joint's last confident position for up to ms while it's unsure (what livePose does for the character). */
const hold = (ms: number, threshold = 0.5): Treat => frames => {
  const held = new Map<number, { l: Landmark; at: number }[]>();
  for (const f of frames) for (const p of f.poses) {
    const h = held.get(p.playerId) ?? [];
    held.set(p.playerId, h);
    p.landmarks = p.landmarks.map((l, i) => {
      if ((l.confidence ?? 0) >= threshold) { h[i] = { l, at: f.t }; return l; }
      const last = h[i];
      return last && f.t - last.at <= ms ? { ...last.l, confidence: 0.5 } : l;
    });
  }
};
/** Count joints down to a lower confidence as sure. */
const gate = (threshold: number): Treat => frames => {
  for (const f of frames) for (const p of f.poses) p.landmarks = p.landmarks.map(l => (l.confidence ?? 0) >= threshold ? { ...l, confidence: Math.max(0.5, l.confidence ?? 0) } : l);
};
/** Joints outside the picture don't count (the model guesses them). */
const inFrame: Treat = frames => { for (const f of frames) for (const p of f.poses) p.landmarks = p.landmarks.map(l => l.x < 0 || l.x > 1 || l.y < 0 || l.y > 1 ? { ...l, confidence: 0 } : l); };
const trustAll: Treat = frames => { for (const f of frames) for (const p of f.poses) p.landmarks = p.landmarks.map(l => ({ ...l, confidence: 1 })); };
/** Exponential smoothing of positions per player (time constant ms), confidences as they are. */
const smooth = (ms: number): Treat => frames => {
  const state = new Map<number, { l: Landmark[]; t: number }>();
  for (const f of frames) for (const p of f.poses) {
    const s = state.get(p.playerId);
    if (!s || f.t - s.t > 300) { state.set(p.playerId, { l: p.landmarks.map(clone), t: f.t }); continue; }
    const k = 1 - Math.exp(-(f.t - s.t) / ms);
    p.landmarks = p.landmarks.map((l, i) => {
      const o = s.l[i];
      if ((l.confidence ?? 0) < 0.5) return l;
      return { ...l, x: o.x + (l.x - o.x) * k, y: o.y + (l.y - o.y) * k };
    });
    state.set(p.playerId, { l: p.landmarks.map(clone), t: f.t });
  }
};
const both = (...ts: Treat[]): Treat => frames => { for (const t of ts) t(frames); };

const TREATMENTS: Record<string, Treat | null> = {
  baseline: null,
  'gate-0.3': gate(0.3),
  'gate-0.2': gate(0.2),
  'gate-0.1': gate(0.1),
  'gate-0.05': gate(0.05),
  'hold-300+gate-0.2': both(hold(300), gate(0.2)),
  'hold-300': hold(300),
  'hold-500': hold(500),
  'hold-300+gate-0.3': both(hold(300), gate(0.3)),
  'smooth-50': smooth(50),
  'hold-300+smooth-50': both(hold(300), smooth(50)),
  'hold-300@0.1': hold(300, 0.1),
  'hold-150@0.1': hold(150, 0.1),
  'in-frame': inFrame,
  'hold-300+in-frame': both(hold(300, 0.1), inFrame),
  'trust-all': trustAll,
};

/** The scene with every GT frame in the dance window replaced by the one shift later (wrapping round the window). */
function shifted(scene: Scene, window: [number, number], shift: number): Scene {
  const inWin = scene.gt.filter(f => f.t_ms >= window[0] && f.t_ms <= window[1]);
  const len = inWin.length;
  const gt: GtFrame[] = scene.gt.map(f => {
    const i = inWin.indexOf(f);
    if (i < 0) return f;
    const j = (i + Math.round(shift / (1000 / scene.fps))) % len;
    return { ...f, people: inWin[j].people };
  });
  return { ...scene, gt, byFrame: new Map(gt.map(f => [f.frame, f])) };
}

const args = parseArgs(process.argv.slice(2), { estimators: "string", scenes: "string", out: "string" }).opts;
const runs = path.join(DATA, 'runs');
const estimators = args.estimators ? String(args.estimators).split(',') : readdirSync(runs).filter(e => !e.startsWith('_'));
const prefixes = args.scenes ? String(args.scenes).split(',') : [];
const rows: Record<string, unknown>[] = [];
const sceneCache = new Map<string, Scene>();
for (const est of estimators) {
  if (!existsSync(path.join(runs, est))) continue;
  for (const sid of readdirSync(path.join(runs, est)).sort()) {
    if (sid.startsWith('_') || (prefixes.length && !prefixes.some(p => sid.startsWith(p)))) continue;
    const dir = runDir(est, sid);
    if (!existsSync(path.join(dir, 'tracked.jsonl')) || !existsSync(path.join(dir, 'metrics.json'))) continue;
    const metrics = readJson<{ expected_numbering?: { mapping: string[] } }>(path.join(dir, 'metrics.json'));
    const mapping = metrics.expected_numbering?.mapping ?? [];
    let scene = sceneCache.get(sid);
    if (!scene) { try { scene = loadScene(sid); } catch { continue; } sceneCache.set(sid, scene); }
    const window = danceWindow(scene);
    if (!window || !mapping.length || window[1] - window[0] < WRONG_SHIFT_MS + 2000) continue;
    const right = referenceBundle(scene, mapping, window);
    const wrong = referenceBundle(shifted(scene, window, WRONG_SHIFT_MS), mapping, window);
    const tracked = readJsonl<TrackedFrame>(path.join(dir, 'tracked.jsonl')).filter(r => !r.dropped);
    const live = () => tracked.map(r => ({ t: r.t_ms, received: r.received_ms, poses: r.poses.map(p => ({ playerId: p.playerId, landmarks: p.kp.map(([x, y, z, c]: Joint) => ({ x, y, z, confidence: c })) })) }));
    const gtLive: LiveRecord[] = scene.gt.map(f => ({ captureMs: f.t_ms, receivedMs: f.t_ms, poses: mapping.flatMap((id, playerId) => { const p = f.people.find(q => q.id === id); return p && p.in_frame !== false ? [{ playerId, landmarks: gtLandmarks(p) }] : []; }) }));
    const mean = (rs: { score: number }[]) => rs.reduce((n, r) => n + r.score, 0) / rs.length;
    const row: Record<string, unknown> = { estimator: est, scene: sid, category: scene.category, players: mapping.length,
      gt_right: mean(scoreRecords(right, mapping.length, gtLive, scene.aspect).results), gt_wrong: mean(scoreRecords(wrong, mapping.length, gtLive, scene.aspect).results) };
    // Idle control: the estimator's own output while the players stood still in setup, looped
    // over the dance (somebody standing there instead of dancing).
    const holdFrames = new Set(scene.gt.filter(f => mapping.every(id => f.people.find(p => p.id === id)?.phase === 'hold')).map(f => f.frame));
    const idleSrc = tracked.filter(r => holdFrames.has(r.frame) && r.poses.length === mapping.length);
    const idle = () => idleSrc.length < 30 ? null : live().filter(f => f.t >= window[0] - 1000).map((f, i) => {
      const src = idleSrc[i % idleSrc.length];
      return { ...f, poses: src.poses.map(p => ({ playerId: p.playerId, landmarks: p.kp.map(([x, y, z, c]: Joint) => ({ x, y, z, confidence: c })) })) };
    });
    // The same still-player control with GT poses, at the GT frame rate.
    const gtIdleSrc = gtLive.filter((f, i) => holdFrames.has(scene.gt[i].frame) && f.poses.length === mapping.length);
    if (gtIdleSrc.length >= 30) {
      const gtIdle = gtLive.filter(f => f.captureMs >= window[0] - 1000).map((f, i) => ({ ...f, poses: gtIdleSrc[i % gtIdleSrc.length].poses }));
      row.gt_idle = mean(scoreRecords(right, mapping.length, gtIdle, scene.aspect).results);
    }
    for (const [name, treat] of Object.entries(TREATMENTS)) {
      const frames = live();
      treat?.(frames);
      const recs: LiveRecord[] = frames.map(f => ({ captureMs: f.t, receivedMs: f.received, poses: f.poses }));
      row[`${name}:right`] = mean(scoreRecords(right, mapping.length, recs, scene.aspect).results);
      row[`${name}:wrong`] = mean(scoreRecords(wrong, mapping.length, recs, scene.aspect).results);
      const still = idle();
      if (still) { treat?.(still); row[`${name}:idle`] = mean(scoreRecords(right, mapping.length, still.map(f => ({ captureMs: f.t, receivedMs: f.received, poses: f.poses })), scene.aspect).results); }
    }
    rows.push(row);
    console.log(est, sid, `baseline ${Math.round(row['baseline:right'] as number)} / wrong ${Math.round(row['baseline:wrong'] as number)}`, `hold-300 ${Math.round(row['hold-300:right'] as number)}`);
  }
}
// Summary: per estimator and treatment, mean points kept vs GT (right) and mean wrong-dance score.
const summary: Record<string, Record<string, { right_lost: number; wrong: number; idle: number; gt_idle: number; n: number; idle_n: number; gt_idle_n: number }>> = {};
for (const r of rows) {
  const s = summary[r.estimator as string] ??= {};
  for (const name of Object.keys(TREATMENTS)) {
    const e = s[name] ??= { right_lost: 0, wrong: 0, idle: 0, gt_idle: 0, n: 0, idle_n: 0, gt_idle_n: 0 };
    e.right_lost += (r.gt_right as number) - (r[`${name}:right`] as number);
    e.wrong += r[`${name}:wrong`] as number;
    e.n++;
    if (typeof r[`${name}:idle`] === 'number') { e.idle += r[`${name}:idle`] as number; e.idle_n++;
      if (typeof r.gt_idle === 'number') { e.gt_idle += r.gt_idle; e.gt_idle_n++; }
    }
  }
}
for (const s of Object.values(summary)) for (const e of Object.values(s)) { e.right_lost = Math.round(e.right_lost / e.n); e.wrong = Math.round(e.wrong / e.n); e.idle = e.idle_n ? Math.round(e.idle / e.idle_n) : NaN; e.gt_idle = e.gt_idle_n ? Math.round(e.gt_idle / e.gt_idle_n) : NaN; }
const gtIdleRows = rows.filter(r => typeof r.gt_idle === 'number');
const gtIdle = Math.round(gtIdleRows.reduce((n, r) => n + (r.gt_idle as number), 0) / Math.max(1, gtIdleRows.length));
const gtWrong = Math.round(rows.reduce((n, r) => n + (r.gt_wrong as number), 0) / Math.max(1, rows.length));
writeJson(String(args.out ?? path.join(DATA, 'reports', 'score-robustness.json')), { wrong_shift_ms: WRONG_SHIFT_MS, gt_wrong_mean: gtWrong, gt_idle_mean: gtIdle, summary, rows });
console.log(`\nGT live vs wrong dance: ${gtWrong}; GT idle (all available scenes): ${gtIdle}`);
for (const [est, s] of Object.entries(summary)) {
  console.log(est, Object.entries(s).map(([k, v]) => `${k}: lost ${v.right_lost} wrong ${v.wrong} idle ${v.idle} GT idle (paired) ${v.gt_idle}`).join(' | '));
}
