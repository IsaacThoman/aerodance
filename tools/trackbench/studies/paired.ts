// The comparison the final report uses: every estimator on the same scenes (the cohort every one
// of them has metrics for), failures counted rather than dropped, and differences from the
// baseline as paired bootstrap 95% intervals over scenes.
//
//   node tools/trackbench/studies/paired.ts [--estimators a,b,...] [--baseline mp-lite-game] [--scenes p1,p2] [--name out]
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrap, DATA, parseArgs, readJson, writeJson } from '../harness/common.ts';

const opts = parseArgs(process.argv.slice(2), { estimators: 'string', baseline: 'string', scenes: 'string', name: 'string', exclude: 'string' }).opts;
const baseline = String(opts.baseline ?? 'mp-lite-game');
const estimators = opts.estimators ? String(opts.estimators).split(',') : [baseline, 'mp-full-game', 'mp-heavy-game', 'rtmo-s', 'rtmpose-s', 'movenet-multipose', 'apple-vision'];
const prefixes = opts.scenes ? String(opts.scenes).split(',') : [];
const exclude = opts.exclude ? String(opts.exclude).split(',') : [];
type M = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (m: M, p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as M)[k] : undefined), m);

/** One measure: how to read it from metrics.json, and what a failure is (null = not applicable). */
interface Measure { key: string; label: string; read: (m: M) => number | null | 'fail'; higherBetter: boolean; fmt: (v: number) => string; }
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const MEASURES: Measure[] = [
  { key: 'score_lost', label: 'score lost to tracking', higherBetter: false, fmt: pct,
    read: m => { const s = m.score; return s ? (s.players as M[]).reduce((n, p) => n + p.lost / Math.max(1, p.gt_score), 0) / s.players.length : null; } },
  { key: 'downgraded', label: 'judgement windows downgraded', higherBetter: false, fmt: pct, read: m => (get(m, 'score.judgements.downgraded_frac') as number | null) ?? null },
  { key: 'identity', label: 'identity accuracy (after numbering)', higherBetter: true, fmt: pct,
    read: m => m.players < 2 ? null : (get(m, 'tracking.after_numbering.identity_accuracy') as number | null) ?? 'fail' },
  { key: 'numbered', label: 'numbered correctly', higherBetter: true, fmt: pct,
    read: m => m.players < 2 ? null : get(m, 'tracking.numbering.correct') === true ? 1 : 0 },
  { key: 'lost', label: 'player-frames lost', higherBetter: false, fmt: pct, read: m => (get(m, 'tracking.whole_scene.lost') as number | null) ?? 'fail' },
  { key: 'recall', label: 'player recall (detections)', higherBetter: true, fmt: pct, read: m => (get(m, 'detection.recall.players') as number | null) ?? null },
  { key: 'pck20', label: 'PCK@0.2 torso (raw)', higherBetter: true, fmt: v => v.toFixed(3), read: m => (get(m, 'detection.keypoints.body.pck20') as number | null) ?? null },
  { key: 'pck20c', label: 'PCK@0.2 torso (offsets from held-out split)', higherBetter: true, fmt: v => v.toFixed(3),
    read: m => m.offsets_in_sample ? null : (get(m, 'detection.keypoints.body.pck20_corrected') as number | null) ?? null },
  { key: 'limb', label: 'scored-limb angle error (deg)', higherBetter: false, fmt: v => v.toFixed(2), read: m => (get(m, 'detection.keypoints.limbs.mean_deg_weighted') as number | null) ?? null },
  { key: 'usable', label: 'scored limbs usable (above the scorer\'s confidence gate)', higherBetter: true, fmt: pct, read: m => (get(m, 'detection.keypoints.limbs.usable_frac') as number | null) ?? null },
  { key: 'sure_wrong', label: 'sure joints that are wrong', higherBetter: false, fmt: pct, read: m => (get(m, 'detection.keypoints.confidence.sure_wrong') as number | null) ?? null },
  { key: 'calib', label: 'calibrated before the dance', higherBetter: true, fmt: pct,
    read: m => m.calibration && m.calibration.gt_hold_ms !== null && m.calibration.gt_hold_ms >= 3000 ? (m.calibration.complete_before_dance ? 1 : 0) : null },
  { key: 'calib_ms', label: 'calibration time after hold start (ms, completed only)', higherBetter: false, fmt: v => v.toFixed(0),
    read: m => m.calibration && m.calibration.complete_after_hold_ms !== null && m.calibration.complete_before_dance ? m.calibration.complete_after_hold_ms : null },
];

const runsRoot = path.join(DATA, 'runs');
const scenesOf = (e: string) => existsSync(path.join(runsRoot, e)) ? readdirSync(path.join(runsRoot, e)).filter(s => existsSync(path.join(runsRoot, e, s, 'metrics.json'))) : [];
let cohort = scenesOf(baseline).filter(s => !s.startsWith('_') && !s.startsWith('real-') && (!prefixes.length || prefixes.some(p => s.startsWith(p))) && !exclude.some(p => s.startsWith(p)));
for (const e of estimators) { const have = new Set(scenesOf(e)); cohort = cohort.filter(s => have.has(s)); }
cohort.sort();
const metrics = new Map<string, M>();
for (const e of estimators) for (const s of cohort) metrics.set(`${e}|${s}`, readJson<M>(path.join(runsRoot, e, s, 'metrics.json')));
const categoryOf = (s: string) => metrics.get(`${baseline}|${s}`)!.category as string;


function table(scenes: string[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const ms of MEASURES) {
    const row: Record<string, unknown> = {};
    for (const e of estimators) {
      const vals = scenes.map(s => ms.read(metrics.get(`${e}|${s}`)!));
      const finite = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const fails = vals.filter(v => v === 'fail').length;
      const entry: Record<string, unknown> = { n: finite.length, fails, mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null };
      if (e !== baseline) {
        // Paired: scenes where both have a finite value.
        const diffs: number[] = [];
        scenes.forEach(s => { const a = ms.read(metrics.get(`${baseline}|${s}`)!), b = ms.read(metrics.get(`${e}|${s}`)!); if (typeof a === 'number' && typeof b === 'number') diffs.push(b - a); });
        const d = diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null;
        const [lo, hi] = bootstrap(diffs);
        const better = d === null || !Number.isFinite(lo) ? null : ms.higherBetter ? (lo > 0 ? 'better' : hi < 0 ? 'worse' : 'same') : (hi < 0 ? 'better' : lo > 0 ? 'worse' : 'same');
        Object.assign(entry, { paired_n: diffs.length, delta: d, ci: [lo, hi], verdict: better });
      }
      row[e] = entry;
    }
    out[ms.key] = row;
  }
  return out;
}

const all = table(cohort);
const byCategory: Record<string, ReturnType<typeof table>> = {};
for (const c of [...new Set(cohort.map(categoryOf))].sort()) byCategory[c] = table(cohort.filter(s => categoryOf(s) === c));

const lines: string[] = [];
const fmtCell = (ms: Measure, e: string, t: ReturnType<typeof table>) => {
  const x = t[ms.key][e] as M;
  if (x.mean === null) return x.fails ? `fail ×${x.fails}` : '–';
  let cell = ms.fmt(x.mean) + (x.fails ? ` (+${x.fails} fail)` : '');
  if (e !== baseline && x.delta !== null && x.paired_n >= 3) {
    const sign = (v: number) => (v >= 0 ? '+' : '') + ms.fmt(v).replace(/^-/, '−');
    cell += `<br>Δ ${sign(x.delta)} [${sign(x.ci[0])}, ${sign(x.ci[1])}]${x.verdict === 'better' ? ' ✓' : x.verdict === 'worse' ? ' ✗' : ''}`;
  }
  return cell;
};
const render = (title: string, t: ReturnType<typeof table>, n: number) => {
  lines.push(`### ${title} (${n} scenes)`, '', `| measure | ${estimators.join(' | ')} |`, `|---|${estimators.map(() => '---').join('|')}|`);
  for (const ms of MEASURES) if (estimators.some(e => (t[ms.key][e] as M).n || (t[ms.key][e] as M).fails)) lines.push(`| ${ms.label} | ${estimators.map(e => fmtCell(ms, e, t)).join(' | ')} |`);
  lines.push('');
};
lines.push(`# Paired comparison vs ${baseline}`, '', `Cohort: ${cohort.length} scenes every estimator has metrics for. Δ = mean paired difference from ${baseline} with a 95% bootstrap interval over scenes; ✓/✗ = interval excludes zero (better/worse). "fail" = the metric has no value because tracking never got there (e.g. never numbered), counted separately rather than dropped.`, '');
render('All scenes', all, cohort.length);
for (const [c, t] of Object.entries(byCategory)) render(c, t, cohort.filter(s => categoryOf(s) === c).length);
const name = String(opts.name ?? 'paired');
writeFileSync(path.join(DATA, 'reports', `${name}.md`), lines.join('\n') + '\n');
writeJson(path.join(DATA, 'reports', `${name}.json`), { baseline, estimators, cohort, all, byCategory });
console.log(lines.slice(0, 22).join('\n'));
console.log(`\n→ ${path.join(DATA, 'reports', `${name}.md`)}`);
