// How much of a change in score lost to tracking is the scorer's, and how much the tracking's?
// Compares, per scene: the baseline run as its own game scored it (its metrics.json), the
// baseline's tracking scored with the working tree's scorer (a score-robustness.ts report's
// 'baseline:lost_share'), and the other run (its metrics.json). Means overall, by category and by
// player count, paired bootstrap 95% intervals for each share (resampling render clusters), and the scenes that lose more on
// the same scorer.
//
//   node tools/trackbench/studies/scorer-share.ts --baseline dev-final --estimator final4-game --robustness <score-robustness.json> [--name out]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { clusterBootstrap, DATA, parseArgs, readJson } from '../harness/common.ts';
import { renderCluster } from '../harness/split.ts';

const opts = parseArgs(process.argv.slice(2), { baseline: 'string', estimator: 'string', robustness: 'string', name: 'string' }).opts;
const baseline = String(opts.baseline ?? 'dev-final'), estimator = String(opts.estimator ?? ''), robustness = String(opts.robustness ?? '');
if (!estimator || !robustness) { console.error('usage: scorer-share.ts --baseline <run> --estimator <run> --robustness <score-robustness.json> [--name out]'); process.exit(2); }
type M = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const lost = (m: M) => m.score.players.reduce((n: number, p: M) => n + p.lost / Math.max(1, p.gt_score), 0) / m.score.players.length;
const metrics = (run: string, s: string): M | null => { try { return readJson<M>(path.join(DATA, 'runs', run, s, 'metrics.json')); } catch { return null; } };

const rows = readJson<{ rows: M[] }>(robustness).rows;
const rescored = new Map(rows.filter(r => r.estimator === baseline && typeof r['baseline:lost_share'] === 'number').map(r => [r.scene as string, r['baseline:lost_share'] as number]));
const scenes = [...rescored.keys()].filter(s => metrics(baseline, s) && metrics(estimator, s)).sort();
const per = scenes.map(s => {
  const a = metrics(baseline, s)!, b = metrics(estimator, s)!;
  return { scene: s, category: a.category as string, players: a.players as number, before: lost(a), rescored: rescored.get(s)!, after: lost(b) };
});
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`, pts = (v: number) => (v * 100).toFixed(1);
const group = (key: (r: typeof per[number]) => string) => {
  const g = new Map<string, typeof per>();
  for (const r of per) { const k = key(r); g.set(k, [...(g.get(k) ?? []), r]); }
  return [...g].map(([k, v]) => ({ group: k, n: v.length, before: mean(v.map(r => r.before)), rescored: mean(v.map(r => r.rescored)), after: mean(v.map(r => r.after)) }));
};
const scorer = per.map(r => r.rescored - r.before), tracking = per.map(r => r.after - r.rescored);
const out = {
  baseline, estimator, robustness, scenes: per.length,
  all: { before: mean(per.map(r => r.before)), rescored: mean(per.map(r => r.rescored)), after: mean(per.map(r => r.after)) },
  // (Scenes that share a render are resampled together.)
  scorer_share: { mean: mean(scorer), ci: clusterBootstrap(scorer, per.map(r => renderCluster(r.scene))) },
  tracking_share: { mean: mean(tracking), ci: clusterBootstrap(tracking, per.map(r => renderCluster(r.scene))) },
  by_category: group(r => r.category), by_players: group(r => String(r.players)),
  worse_on_same_scorer: per.filter(r => r.after > r.rescored).sort((a, b) => (b.after - b.rescored) - (a.after - a.rescored)).map(r => ({ scene: r.scene, rescored: r.rescored, after: r.after })),
  scenes_detail: per,
};
const md = [
  `# Scorer's share and tracking's share: ${baseline} → ${estimator}`, '',
  `${per.length} scenes. "rescored" is ${baseline}'s tracking scored with the working tree's scorer (${path.basename(robustness)}).`, '',
  `| | ${baseline} | rescored | ${estimator} |`, '|---|---|---|---|',
  `| all scenes | ${pct(out.all.before)} | ${pct(out.all.rescored)} | ${pct(out.all.after)} |`,
  ...out.by_category.map(g => `| ${g.group} (${g.n}) | ${pct(g.before)} | ${pct(g.rescored)} | ${pct(g.after)} |`),
  ...out.by_players.map(g => `| ${g.group} player(s) (${g.n}) | ${pct(g.before)} | ${pct(g.rescored)} | ${pct(g.after)} |`), '',
  `Scorer's share: ${pts(out.scorer_share.mean)} points [${out.scorer_share.ci.map(pts).join(', ')}]. Tracking's share: ${pts(out.tracking_share.mean)} points [${out.tracking_share.ci.map(pts).join(', ')}].`, '',
  `Scenes that lose more on the same scorer: ${out.worse_on_same_scorer.map(r => `${r.scene} ${pts(r.rescored)} → ${pts(r.after)}`).join(', ') || 'none'}.`, '',
];
const name = String(opts.name ?? `scorer-share-${estimator}`);
writeFileSync(path.join(DATA, 'reports', `${name}.json`), JSON.stringify(out, null, 1));
writeFileSync(path.join(DATA, 'reports', `${name}.md`), md.join('\n'));
console.log(md.join('\n'));
console.log(`→ ${path.join(DATA, 'reports', name + '.md')}`);
