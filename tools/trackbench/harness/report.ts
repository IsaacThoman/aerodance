// Aggregates metrics.json across scenes and estimators into a markdown report and its JSON.
//   node tools/trackbench/harness/report.ts [--estimators a,b] [--baseline mp-lite-game] [--scenes prefix[,prefix...]] [--name report-name] [--worst 5]
// Writes $TRACKBENCH_DATA/reports/<name>.md and .json.
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA, mean, parseArgs, readJson, round, writeJson } from './common.ts';
import type { SceneMetrics } from './metrics.ts';

/**
 * A scene where a metric has no value because tracking never got there (never numbered, never
 * calibrated, never tracked everybody), as opposed to one where it doesn't apply. Failures are
 * counted and listed, never silently left out of a mean.
 */
type Failed = (m: SceneMetrics) => boolean;
const calibratable = (m: SceneMetrics) => (m.calibration?.gt_hold_ms ?? 0) >= 3000;
const hasPlayers = (m: SceneMetrics) => (m.tracking?.whole_scene?.player_frames ?? 0) > 0;

/** The report's columns: where each is in metrics.json, which way is better, and what a failure is. */
export const COLUMNS: { key: string; label: string; better: 'higher' | 'lower'; get: (m: SceneMetrics) => number | null; digits?: number; failed?: Failed }[] = [
  { key: 'score_lost', label: 'score lost', better: 'lower', get: m => m.score?.score_lost ?? null, digits: 0 },
  { key: 'score_lost_frac', label: 'score lost %', better: 'lower', get: m => m.score?.score_lost_frac != null ? 100 * m.score.score_lost_frac : null, digits: 2 },
  { key: 'downgraded', label: 'windows downgraded', better: 'lower', get: m => m.score?.judgements?.downgraded_frac ?? null, digits: 3 },
  { key: 'identity', label: 'identity acc', better: 'higher', get: m => m.tracking?.after_numbering?.identity_accuracy ?? null, digits: 4, failed: hasPlayers },
  { key: 'lost', label: 'lost frac', better: 'lower', get: m => m.tracking?.whole_scene?.lost ?? null, digits: 4, failed: hasPlayers },
  { key: 'switches', label: 'id switches', better: 'lower', get: m => m.tracking?.identity_switches ?? null, digits: 0 },
  { key: 'numbering', label: 'numbered right', better: 'higher', get: m => m.tracking?.numbering ? Number(m.tracking.numbering.correct) : null, digits: 2, failed: hasPlayers },
  { key: 'all_tracked_delay', label: 'all tracked after (ms)', better: 'lower', get: m => m.tracking?.all_tracked_delay_ms ?? null, digits: 0, failed: hasPlayers },
  { key: 'calib', label: 'calibrated after hold (ms)', better: 'lower', get: m => m.calibration?.complete_after_hold_ms ?? null, digits: 0, failed: calibratable },
  { key: 'calib_resets', label: 'hold resets', better: 'lower', get: m => m.calibration?.hold_resets ?? null, digits: 1 },
  { key: 'recall', label: 'recall', better: 'higher', get: m => m.detection?.recall?.players ?? null, digits: 4 },
  { key: 'fp', label: 'FP/100 frames', better: 'lower', get: m => { const f = m.detection?.false_positives_per_100_frames; return f ? (f.duplicate ?? 0) + (f.mislocated ?? 0) + (f.distractor ?? 0) + (f.noise ?? 0) : null; }, digits: 2 },
  { key: 'pck20c', label: 'PCK@0.2 (corr)', better: 'higher', get: m => m.detection?.keypoints?.body?.pck20_corrected ?? null, digits: 3 },
  { key: 'pck10c', label: 'PCK@0.1 (corr)', better: 'higher', get: m => m.detection?.keypoints?.body?.pck10_corrected ?? null, digits: 3 },
  { key: 'err', label: 'joint err raw', better: 'lower', get: m => m.detection?.keypoints?.body?.error?.mean ?? null, digits: 3 },
  { key: 'err_c', label: 'joint err corr', better: 'lower', get: m => m.detection?.keypoints?.body?.error_corrected?.mean ?? null, digits: 3 },
  { key: 'limb', label: 'limb err (deg)', better: 'lower', get: m => m.detection?.keypoints?.limbs?.mean_deg_weighted ?? null, digits: 1 },
  { key: 'limb_usable', label: 'limbs usable', better: 'higher', get: m => m.detection?.keypoints?.limbs?.usable_frac ?? null, digits: 3 },
  { key: 'lr_swap', label: 'L/R swaps', better: 'lower', get: m => m.detection?.keypoints?.swaps?.body ?? null, digits: 4 },
  { key: 'sure_wrong', label: 'sure but wrong', better: 'lower', get: m => m.detection?.keypoints?.confidence?.sure_wrong ?? null, digits: 3 },
  { key: 'jitter', label: 'jitter', better: 'lower', get: m => m.detection?.jitter?.accel_error?.mean ?? null, digits: 4 },
  { key: 'inference', label: 'inference ms', better: 'lower', get: m => m.cost?.inference_ms?.mean ?? null, digits: 1 },
  { key: 'pose_hz', label: 'poses/s', better: 'higher', get: m => m.cost?.pose_rate_hz ?? null, digits: 1 },
];
const HEADLINE = ['score_lost', 'identity', 'lost', 'recall', 'pck20c', 'limb', 'calib', 'inference'];

interface Row { scene: string; category: string; players: number; estimator: string; values: Record<string, number | null>; failed?: Record<string, boolean>; }

/** One scene's row: each column's value, and whether a missing one is a failure. */
export function rowOf(estimator: string, scene: string, m: SceneMetrics): Row {
  const values = Object.fromEntries(COLUMNS.map(c => [c.key, c.get(m)]));
  return { scene, category: m.category, players: m.players, estimator, values,
    failed: Object.fromEntries(COLUMNS.map(c => [c.key, values[c.key] === null && !!c.failed?.(m)])) };
}

export function collect(estimators: string[] | null, scenePrefix: string | null): Row[] {
  const runs = path.join(DATA, 'runs');
  if (!existsSync(runs)) return [];
  const rows: Row[] = [];
  for (const estimator of readdirSync(runs).filter(e => !e.startsWith('_') && !e.startsWith('.')).sort()) {
    if (estimators && !estimators.includes(estimator)) continue;
    const dir = path.join(runs, estimator);
    for (const scene of readdirSync(dir).sort()) {
      // A comma-separated list of prefixes, any of which matches.
      if (scenePrefix && !scenePrefix.split(',').some(prefix => scene.startsWith(prefix))) continue;
      const file = path.join(dir, scene, 'metrics.json');
      if (!existsSync(file)) continue;
      const m = readJson<SceneMetrics>(file);
      rows.push(rowOf(estimator, scene, m));
    }
  }
  return rows;
}

const fmt = (v: number | null | undefined, digits = 3) => v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
const signed = (v: number | null | undefined, digits = 3) => v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
const finiteOf = (r: Row | undefined, key: string) => { const v = r?.values[key]; return v !== null && v !== undefined && Number.isFinite(v) ? v : null; };
const avg = (rows: Row[], key: string) => round(mean(rows.map(r => finiteOf(r, key)).filter((v): v is number => v !== null)), 6);
const fails = (rows: Row[], key: string) => rows.filter(r => r.failed?.[key]).length;
/** A mean, with its failures beside it (they're not in it). */
const cell = (v: number | null, nFail: number, digits?: number) => fmt(v, digits) + (nFail ? ` (+${nFail} fail)` : '');

export function buildReport(rows: Row[], baseline: string | null, worst = 5) {
  const estimators = [...new Set(rows.map(r => r.estimator))];
  const categories = [...new Set(rows.map(r => r.category))].sort();
  const scenes = [...new Set(rows.map(r => r.scene))].sort();
  const base = baseline && estimators.includes(baseline) ? baseline : null;
  const col = (key: string) => COLUMNS.find(c => c.key === key)!;
  // Means over the scenes both an estimator and the baseline ran, so deltas compare like with like.
  const find = (e: string, scene: string) => rows.find(r => r.estimator === e && r.scene === scene);
  // Deltas are means of per-scene differences over the scenes where both have a value (paired),
  // with how many pairs, and the failures each side has on the scenes both ran.
  const summary = estimators.map(e => {
    const mine = rows.filter(r => r.estimator === e);
    const shared = base ? mine.filter(r => find(base, r.scene)) : [];
    return { estimator: e, scenes: mine.length, means: Object.fromEntries(COLUMNS.map(c => [c.key, avg(mine, c.key)])),
      fails: Object.fromEntries(COLUMNS.map(c => [c.key, fails(mine, c.key)])),
      deltas: base && e !== base ? Object.fromEntries(COLUMNS.map(c => {
        const diffs = shared.flatMap(r => { const a = finiteOf(r, c.key), b = finiteOf(find(base, r.scene), c.key); return a !== null && b !== null ? [a - b] : []; });
        return [c.key, { delta: round(mean(diffs), 6), pairs: diffs.length, fails: fails(shared, c.key), base_fails: shared.filter(r => find(base, r.scene)!.failed?.[c.key]).length }];
      })) : null };
  });
  const byCategory = categories.map(category => ({ category, estimators: estimators.map(e => {
    const mine = rows.filter(r => r.category === category && r.estimator === e);
    return { estimator: e, scenes: mine.length, means: Object.fromEntries(COLUMNS.map(c => [c.key, avg(mine, c.key)])), fails: Object.fromEntries(COLUMNS.map(c => [c.key, fails(mine, c.key)])) };
  }) }));
  // Failures are the worst of all, so they head each list.
  const worstScenes = Object.fromEntries(estimators.map(e => [e, Object.fromEntries(HEADLINE.map(key => {
    const c = col(key);
    const failed = rows.filter(r => r.estimator === e && r.failed?.[key]).map(r => ({ scene: r.scene, value: null as number | null, failed: true }));
    const list = rows.filter(r => r.estimator === e && finiteOf(r, key) !== null).sort((a, b) => c.better === 'lower' ? b.values[key]! - a.values[key]! : a.values[key]! - b.values[key]!);
    return [key, [...failed, ...list.slice(0, Math.max(0, worst - failed.length)).map(r => ({ scene: r.scene, value: r.values[key], failed: false }))]];
  }))]));

  const md: string[] = [`# trackbench report`, '', `${scenes.length} scenes, ${estimators.length} estimators${base ? `, deltas against ${base}` : ''}. Metric definitions: tools/trackbench/harness/README.md.`, ''];
  md.push('## Summary (mean over scenes)', '', 'Means are over the scenes with a value; "+n fail" counts scenes where tracking never got there (not in the mean). Δ is the mean per-scene difference over scenes where both have a value, with the failures on the scenes both ran (this → baseline).', '',
    `| estimator | scenes | ${COLUMNS.map(c => c.label).join(' | ')} |`, `|---|---|${COLUMNS.map(() => '---').join('|')}|`);
  for (const s of summary) {
    md.push(`| ${s.estimator} | ${s.scenes} | ${COLUMNS.map(c => cell(s.means[c.key], s.fails[c.key], c.digits)).join(' | ')} |`);
    if (s.deltas) md.push(`| Δ vs ${base} | | ${COLUMNS.map(c => { const d = s.deltas![c.key]; return signed(d.delta, c.digits) + (d.fails || d.base_fails ? ` (fails ${d.fails} vs ${d.base_fails})` : ''); }).join(' | ')} |`);
  }
  md.push('', '## By category', '');
  for (const { category, estimators: es } of byCategory) {
    md.push(`### ${category}`, '', `| estimator | scenes | ${HEADLINE.map(k => col(k).label).join(' | ')} |`, `|---|---|${HEADLINE.map(() => '---').join('|')}|`);
    for (const e of es.filter(x => x.scenes)) md.push(`| ${e.estimator} | ${e.scenes} | ${HEADLINE.map(k => cell(e.means[k], e.fails[k], col(k).digits)).join(' | ')} |`);
    md.push('');
  }
  md.push('## Per scene: score lost (identity accuracy, recall)', '', `| scene | category | players | ${estimators.join(' | ')} |`, `|---|---|---|${estimators.map(() => '---').join('|')}|`);
  for (const scene of scenes) {
    const r0 = rows.find(r => r.scene === scene)!;
    md.push(`| ${scene} | ${r0.category} | ${r0.players} | ${estimators.map(e => { const r = rows.find(x => x.scene === scene && x.estimator === e); return r ? `${fmt(r.values.score_lost, 0)} (${fmt(r.values.identity, 3)}, ${fmt(r.values.recall, 3)})` : '–'; }).join(' | ')} |`);
  }
  if (base) {
    md.push('', `## Per scene deltas against ${base}: score lost`, '', `| scene | ${estimators.filter(e => e !== base).join(' | ')} |`, `|---|${estimators.filter(e => e !== base).map(() => '---').join('|')}|`);
    for (const scene of scenes) {
      const b = rows.find(r => r.scene === scene && r.estimator === base)?.values.score_lost ?? null;
      md.push(`| ${scene} | ${estimators.filter(e => e !== base).map(e => { const v = rows.find(r => r.scene === scene && r.estimator === e)?.values.score_lost ?? null; return v !== null && b !== null ? signed(v - b, 0) : '–'; }).join(' | ')} |`);
    }
  }
  md.push('', `## Worst scenes (${worst} per metric)`, '');
  for (const e of estimators) {
    md.push(`### ${e}`, '');
    for (const key of HEADLINE) {
      const list = worstScenes[e][key];
      if (list.length) md.push(`- ${col(key).label}: ${list.map(w => `${w.scene} (${w.failed ? 'fail' : fmt(w.value, col(key).digits)})`).join(', ')}`);
    }
    md.push('');
  }
  return { markdown: md.join('\n') + '\n', json: { generated: new Date().toISOString(), baseline: base, columns: COLUMNS.map(({ key, label, better }) => ({ key, label, better })), summary, by_category: byCategory, worst: worstScenes, rows } };
}

if (import.meta.main) {
  const { opts } = parseArgs(process.argv.slice(2), { estimators: 'string', baseline: 'string', scenes: 'string', name: 'string', worst: 'string' });
  const rows = collect(opts.estimators ? String(opts.estimators).split(',') : null, opts.scenes ? String(opts.scenes) : null);
  if (!rows.length) { console.error('No metrics.json found (run metrics.ts first)'); process.exit(1); }
  const { markdown, json } = buildReport(rows, String(opts.baseline ?? 'mp-lite-game'), Number(opts.worst ?? 5));
  const name = String(opts.name ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  const dir = path.join(DATA, 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), markdown);
  writeJson(path.join(dir, `${name}.json`), json);
  console.log(path.join(dir, `${name}.md`));
}
