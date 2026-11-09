// The ping-pong report: pingpong.json's summaries as a compact table per scene class (category
// and player count) and overall, and a paired comparison of two runs, scene by scene, with
// bootstrap 95% intervals that resample scenes sharing a render together (clusterBootstrap).
//   node tools/trackbench/harness/pp-report.ts <run> [--compare <run-b>] [--scenes p1,p2] [--exclude p1,p2] [--name <name>]
// Prints Markdown, and writes $TRACKBENCH_DATA/reports/<name>.md and .json (name defaults to pp-<run>[-vs-<run-b>]).
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA, clusterBootstrap, parseArgs, readJson, round, sceneDir, writeJson } from './common.ts';
import type { SceneMeta } from './common.ts';
import type { PingpongMetrics } from './pingpong.ts';

type Summary = PingpongMetrics['summary'];
export interface Row { scene: string; cls: string; cluster: string; summary: Summary; }

/** A report column: how to read it off a scene's summary, how to print it, and which way is better. */
interface Column { key: string; label: string; get: (s: Summary) => number | null; digits: number; better: 'lower' | 'higher' | 'closer0' | 'closer1' }
const at = (k: keyof Summary) => (s: Summary) => { const v = s[k]; return typeof v === 'number' ? v : null; };
const axis = (k: 'wrist_bias_cm' | 'wrist_sd_cm' | 'blade_bias_cm' | 'blade_sd_cm', i: number) => (s: Summary) => s[k]?.[i] ?? null;
export const COLUMNS: Column[] = [
  { key: 'paddle_tracked', label: 'paddle tracked', get: at('paddle_tracked'), digits: 3, better: 'higher' },
  { key: 'wrist_cm', label: 'wrist cm', get: at('wrist_cm'), digits: 1, better: 'lower' },
  { key: 'wrist_bias_x', label: 'bias x', get: axis('wrist_bias_cm', 0), digits: 1, better: 'closer0' },
  { key: 'wrist_bias_y', label: 'bias y', get: axis('wrist_bias_cm', 1), digits: 1, better: 'closer0' },
  { key: 'wrist_bias_z', label: 'bias z', get: axis('wrist_bias_cm', 2), digits: 1, better: 'closer0' },
  { key: 'wrist_sd_x', label: 'sd x', get: axis('wrist_sd_cm', 0), digits: 1, better: 'lower' },
  { key: 'wrist_sd_y', label: 'sd y', get: axis('wrist_sd_cm', 1), digits: 1, better: 'lower' },
  { key: 'wrist_sd_z', label: 'sd z', get: axis('wrist_sd_cm', 2), digits: 1, better: 'lower' },
  { key: 'wrist_unbiased_cm', label: 'wrist, bias off', get: at('wrist_unbiased_cm'), digits: 1, better: 'lower' },
  { key: 'wrist_true_fov_cm', label: 'wrist, true FOV', get: at('wrist_true_fov_cm'), digits: 1, better: 'lower' },
  { key: 'blade_cm', label: 'blade cm', get: at('blade_cm'), digits: 1, better: 'lower' },
  { key: 'blade_filtered_cm', label: 'blade filt', get: at('blade_filtered_cm'), digits: 1, better: 'lower' },
  { key: 'blade_p90_cm', label: 'blade p90', get: at('blade_p90_cm'), digits: 1, better: 'lower' },
  { key: 'blade_swing_cm', label: 'blade swing', get: at('blade_swing_cm'), digits: 1, better: 'lower' },
  { key: 'forward_share', label: 'forward share', get: at('forward_share'), digits: 3, better: 'higher' },
  { key: 'wrist_forward_cm', label: 'wrist fwd cm', get: at('wrist_forward_cm'), digits: 1, better: 'lower' },
  { key: 'wrist_forward_bias_z', label: 'fwd bias z', get: (s: Summary) => s.wrist_forward_bias_cm?.[2] ?? null, digits: 1, better: 'closer0' },
  { key: 'wrist_forward_sd_z', label: 'fwd sd z', get: (s: Summary) => s.wrist_forward_sd_cm?.[2] ?? null, digits: 1, better: 'lower' },
  { key: 'blade_forward_cm', label: 'blade fwd filt', get: at('blade_forward_cm'), digits: 1, better: 'lower' },
  { key: 'dir_deg', label: 'dir °', get: at('dir_deg'), digits: 1, better: 'lower' },
  { key: 'across_deg', label: 'across °', get: at('across_deg'), digits: 1, better: 'lower' },
  { key: 'swing_speed_ratio_filtered', label: 'swing speed ×', get: at('swing_speed_ratio_filtered'), digits: 2, better: 'closer1' },
  { key: 'swing_vel_err_filtered_ms', label: 'swing vel err m/s', get: at('swing_vel_err_filtered_ms'), digits: 2, better: 'lower' },
  { key: 'lag_ms', label: 'lag ms', get: at('lag_ms'), digits: 0, better: 'closer0' },
  { key: 'lag_filtered_ms', label: 'lag filt', get: at('lag_filtered_ms'), digits: 0, better: 'closer0' },
  { key: 'latency_ms', label: 'latency ms', get: at('latency_ms'), digits: 0, better: 'lower' },
  { key: 'jitter_rest_cm', label: 'jitter cm', get: at('jitter_rest_cm'), digits: 2, better: 'lower' },
  { key: 'jitter_rest_filtered_cm', label: 'jitter filt', get: at('jitter_rest_filtered_cm'), digits: 2, better: 'lower' },
  { key: 'hand_found', label: 'hand found', get: at('hand_found'), digits: 3, better: 'higher' },
  { key: 'hand_wrong_side', label: 'wrong side', get: at('hand_wrong_side'), digits: 3, better: 'lower' },
  { key: 'hand_wrong_person', label: 'wrong person', get: at('hand_wrong_person'), digits: 3, better: 'lower' },
  { key: 'hand_wrist_px', label: 'hand wrist px', get: at('hand_wrist_px'), digits: 1, better: 'lower' },
  { key: 'pose_wrist_px', label: 'pose wrist px', get: at('pose_wrist_px'), digits: 1, better: 'lower' },
  { key: 'world_arm_cm', label: 'world arm cm', get: at('world_arm_cm'), digits: 1, better: 'lower' },
  { key: 'depth_sign_wrong', label: 'depth sign wrong', get: at('depth_sign_wrong'), digits: 3, better: 'lower' },
  { key: 'back_read_forward', label: 'back read fwd', get: at('back_read_forward'), digits: 3, better: 'lower' },
  { key: 'swing_false_per_min', label: 'false swings/min', get: at('swing_false_per_min'), digits: 2, better: 'lower' },
  { key: 'swing_rest_false_per_min', label: 'rest false swings/min', get: at('swing_rest_false_per_min'), digits: 2, better: 'lower' },
  { key: 'swing_miss', label: 'swing miss', get: at('swing_miss'), digits: 3, better: 'lower' },
  { key: 'serve_false_per_min', label: 'false serves/min', get: at('serve_false_per_min'), digits: 2, better: 'lower' },
  { key: 'serve_miss', label: 'serve miss', get: at('serve_miss'), digits: 3, better: 'lower' },
  { key: 'raise_false_per_min', label: 'raise false/min', get: at('raise_false_per_min'), digits: 2, better: 'lower' },
  { key: 'raise_miss', label: 'raise miss', get: at('raise_miss'), digits: 3, better: 'lower' },
  { key: 'inference_ms', label: 'infer ms', get: at('inference_ms'), digits: 1, better: 'lower' },
  { key: 'pose_hz', label: 'pose Hz', get: at('pose_hz'), digits: 1, better: 'higher' },
];
/** The columns the compact class table prints (the JSON has every one). */
export const COMPACT = ['paddle_tracked', 'wrist_cm', 'wrist_bias_x', 'wrist_bias_y', 'wrist_bias_z', 'wrist_sd_x', 'wrist_sd_y', 'wrist_sd_z', 'blade_filtered_cm', 'blade_swing_cm', 'wrist_forward_cm', 'wrist_forward_bias_z',
  'lag_filtered_ms', 'jitter_rest_filtered_cm', 'hand_found', 'hand_wrong_side', 'back_read_forward', 'swing_false_per_min', 'swing_miss', 'raise_false_per_min', 'inference_ms', 'pose_hz'];

/** Scenes sharing a render (post-only variants) are one cluster: meta.json's render_key, else the scene. */
export function clusterOf(scene: string): string {
  const dir = sceneDir(scene);
  const meta = existsSync(path.join(dir, 'meta.json')) ? readJson<SceneMeta>(path.join(dir, 'meta.json')) : {};
  return meta.render_key ?? scene;
}
const classOf = (m: PingpongMetrics) => `${m.category}/${m.players}p`;

export function collectRows(run: string, include: string[] = [], exclude: string[] = []): Row[] {
  const root = path.join(DATA, 'runs', run);
  if (!existsSync(root)) throw Error(`No run ${run}`);
  return readdirSync(root).filter(s => existsSync(path.join(root, s, 'pingpong.json')))
    .filter(s => (!include.length || include.some(p => s.startsWith(p))) && !exclude.some(p => s.startsWith(p))).sort()
    .map(scene => { const m = readJson<PingpongMetrics>(path.join(root, scene, 'pingpong.json')); return { scene, cls: classOf(m), cluster: clusterOf(scene), summary: m.summary }; });
}

const meanOf = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
/** Each column's mean over the rows that have it (each scene counts once). */
export function aggregate(rows: readonly Row[]) {
  return Object.fromEntries(COLUMNS.map(c => [c.key, round(meanOf(rows.map(r => c.get(r.summary)).filter((v): v is number => v !== null && Number.isFinite(v))), c.digits + 1)]));
}

/** Paired differences b − a over the scenes both have, with cluster-bootstrap intervals and a verdict. */
export function compare(a: readonly Row[], b: readonly Row[]) {
  const byScene = new Map(a.map(r => [r.scene, r]));
  const pairs = b.filter(r => byScene.has(r.scene)).map(r => ({ a: byScene.get(r.scene)!, b: r }));
  return {
    scenes: pairs.length, clusters: new Set(pairs.map(p => p.a.cluster)).size,
    columns: Object.fromEntries(COLUMNS.map(c => {
      const ok = pairs.map(p => ({ va: c.get(p.a.summary), vb: c.get(p.b.summary), cluster: p.a.cluster })).filter(p => p.va !== null && p.vb !== null && Number.isFinite(p.va) && Number.isFinite(p.vb));
      // "Closer to 0/1" columns compare sizes: |b| − |a| (or |b − 1| − |a − 1|).
      const size = (v: number) => c.better === 'closer0' ? Math.abs(v) : c.better === 'closer1' ? Math.abs(v - 1) : v;
      const diffs = ok.map(p => size(p.vb!) - size(p.va!));
      const [lo, hi] = clusterBootstrap(diffs, ok.map(p => p.cluster));
      const higher = c.better === 'higher';
      const verdict = !Number.isFinite(lo) ? null : (higher ? lo > 0 : hi < 0) ? 'better' : (higher ? hi < 0 : lo > 0) ? 'worse' : 'same';
      return [c.key, { n: ok.length, a: round(meanOf(ok.map(p => p.va!)), c.digits + 1), b: round(meanOf(ok.map(p => p.vb!)), c.digits + 1), delta: round(meanOf(diffs), c.digits + 1), ci: [round(lo, c.digits + 1), round(hi, c.digits + 1)], verdict, measured: c.better.startsWith('closer') ? 'size' : 'value' }];
    })),
  };
}

const fmt = (v: number | null | undefined, digits: number) => v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);

export function markdown(run: string, rows: readonly Row[], other?: { run: string; rows: readonly Row[] }) {
  const cols = COMPACT.map(k => COLUMNS.find(c => c.key === k)!);
  const out: string[] = [`# Ping-pong report: ${run}${other ? ` vs ${other.run}` : ''}`, '',
    `${rows.length} scenes. Means over scenes of each scene's summary (pingpong.json; PINGPONG.md defines them). cm in the player's frame: x their right, y up, z back (bias z < 0: the paddle is read nearer the camera than it is).`, ''];
  const table = (title: string, groups: [string, readonly Row[]][]) => {
    out.push(`## ${title}`, '', `| class | scenes | ${cols.map(c => c.label).join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`);
    for (const [name, g] of groups) {
      const agg = aggregate(g);
      out.push(`| ${name} | ${g.length} | ${cols.map(c => fmt(agg[c.key], c.digits)).join(' | ')} |`);
    }
    out.push('');
  };
  const classes = [...new Set(rows.map(r => r.cls))].sort();
  table(run, [...classes.map((c): [string, readonly Row[]] => [c, rows.filter(r => r.cls === c)]), ['**all**', rows]]);
  if (other) {
    const oc = [...new Set(other.rows.map(r => r.cls))].sort();
    table(other.run, [...oc.map((c): [string, readonly Row[]] => [c, other.rows.filter(r => r.cls === c)]), ['**all**', other.rows]]);
    const cmp = compare(rows, other.rows);
    out.push(`## Paired: ${other.run} − ${run}`, '', `${cmp.scenes} scenes in ${cmp.clusters} render clusters; 95% intervals resample clusters. "closer to 0/1" columns compare sizes (|b| − |a|).`, '',
      '| measure | n | a | b | Δ | 95% CI | verdict |', '|---|---|---|---|---|---|---|');
    for (const c of COLUMNS) {
      const r = cmp.columns[c.key] as { n: number; a: number | null; b: number | null; delta: number | null; ci: (number | null)[]; verdict: string | null };
      if (!r.n) continue;
      out.push(`| ${c.label} | ${r.n} | ${fmt(r.a, c.digits)} | ${fmt(r.b, c.digits)} | ${fmt(r.delta, c.digits + 1)} | [${fmt(r.ci[0], c.digits + 1)}, ${fmt(r.ci[1], c.digits + 1)}] | ${r.verdict ?? '–'} |`);
    }
    out.push('');
  }
  out.push('## Scenes', '', `| scene | class | ${cols.map(c => c.label).join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) out.push(`| ${r.scene} | ${r.cls} | ${cols.map(c => fmt(c.get(r.summary), c.digits)).join(' | ')} |`);
  return out.join('\n') + '\n';
}

if (import.meta.main) {
  const { positional: [run], opts } = parseArgs(process.argv.slice(2), { compare: 'string', scenes: 'string', exclude: 'string', name: 'string' });
  if (!run) { console.error('usage: node tools/trackbench/harness/pp-report.ts <run> [--compare <run-b>] [--scenes p1,p2] [--exclude p1,p2] [--name <name>]'); process.exit(2); }
  const include = opts.scenes ? String(opts.scenes).split(',') : [], exclude = opts.exclude ? String(opts.exclude).split(',') : [];
  const rows = collectRows(run, include, exclude);
  const other = opts.compare ? { run: String(opts.compare), rows: collectRows(String(opts.compare), include, exclude) } : undefined;
  const name = String(opts.name ?? `pp-${run}${other ? `-vs-${other.run}` : ''}`);
  const md = markdown(run, rows, other);
  const dir = path.join(DATA, 'reports');
  writeFileSync(path.join(dir, `${name}.md`), md);
  writeJson(path.join(dir, `${name}.json`), { run, rows, classes: Object.fromEntries([...new Set(rows.map(r => r.cls))].map(c => [c, aggregate(rows.filter(r => r.cls === c))])), all: aggregate(rows),
    ...(other ? { compare: { run: other.run, ...compare(rows, other.rows) } } : {}) });
  console.log(md);
  console.log(`wrote ${path.join(dir, `${name}.md`)}`);
}

