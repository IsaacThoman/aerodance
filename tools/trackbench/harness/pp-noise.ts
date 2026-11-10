// The paddle blade's noise profile over a run's scenes (pingpong.json's `noise`), for the play
// simulation's camera models (apps/web/tests/helpers/tableTennisSim.ts TRACKING): per player
// count, per axis in the player's frame (x their right, y up, z back), at rest and in swings,
// the steady error (bias), the slowly varying part (a ±250 ms average less the bias) and the
// frame-to-frame part, raw (what the game's filter is given) and filtered; how often a raw pose
// is wild and by how much; and how often the paddle hand goes without a pose, and for how long.
//   node tools/trackbench/harness/pp-noise.ts <run> [--scenes p1,p2] [--exclude p1,p2]
// Values are n-weighted means over scenes (biases: means of scene biases; their spread is the
// between-scene sd, which a camera model's steady bias should draw from).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DATA, parseArgs, readJson, round } from './common.ts';
import type { PingpongMetrics } from './pingpong.ts';

type Noise = PingpongMetrics['noise'];
type Part = Noise['raw']['rest'];
const AXES = ['x', 'y', 'z'] as const;

const { positional: [run], opts } = parseArgs(process.argv.slice(2), { scenes: 'string', exclude: 'string' });
if (!run) { console.error('usage: node tools/trackbench/harness/pp-noise.ts <run> [--scenes p1,p2] [--exclude p1,p2]'); process.exit(2); }
const include = opts.scenes ? String(opts.scenes).split(',') : [], exclude = opts.exclude ? String(opts.exclude).split(',') : [];
const root = path.join(DATA, 'runs', run);
const metrics = readdirSync(root).filter(s => existsSync(path.join(root, s, 'pingpong.json')))
  .filter(s => (!include.length || include.some(p => s.startsWith(p))) && !exclude.some(p => s.startsWith(p)))
  .map(s => readJson<PingpongMetrics>(path.join(root, s, 'pingpong.json'))).filter(m => m.summary.gt && m.noise);

const weighted = (parts: Part[], pick: (p: Part) => number | null) => {
  let sum = 0, n = 0;
  for (const p of parts) { const v = pick(p); if (v === null || !Number.isFinite(v) || !p.n) continue; sum += v * p.n; n += p.n; }
  return n ? sum / n : null;
};
const sdOf = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : null; };
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));

const out: Record<string, unknown> = {};
const lines: string[] = [`# Blade noise profile: ${run}`, '', `${metrics.length} scenes with GT. cm, the player's frame (x right, y up, z back). bias: mean of scene biases (± their sd between scenes); slow: sd of the ±250 ms average; fast: sd of what's left (frame to frame).`, ''];
for (const players of [...new Set(metrics.map(m => m.players))].sort()) {
  const ms = metrics.filter(m => m.players === players);
  const group: Record<string, unknown> = { scenes: ms.length };
  lines.push(`## ${players} player${players > 1 ? 's' : ''} (${ms.length} scenes)`, '', '| source | state | n | bias x | bias y | bias z | slow x | slow y | slow z | fast x | fast y | fast z |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const source of ['raw', 'filtered'] as const) for (const state of ['rest', 'swing', 'all'] as const) {
    const parts = ms.map(m => m.noise[source][state]).filter(Boolean);
    const row = {
      n: parts.reduce((a, p) => a + p.n, 0),
      bias_cm: Object.fromEntries(AXES.map(a => [a, round(weighted(parts, p => p.bias_cm[a]), 2)])),
      bias_between_sd_cm: Object.fromEntries(AXES.map(a => [a, round(sdOf(parts.map(p => p.bias_cm[a]).filter((v): v is number => v !== null && Number.isFinite(v))), 2)])),
      slow_sd_cm: Object.fromEntries(AXES.map(a => [a, round(weighted(parts, p => p.slow_sd_cm[a]), 2)])),
      fast_sd_cm: Object.fromEntries(AXES.map(a => [a, round(weighted(parts, p => p.fast_sd_cm[a]), 2)])),
    };
    group[`${source}_${state}`] = row;
    const b = row.bias_cm as Record<string, number>, bs = row.bias_between_sd_cm as Record<string, number>, sl = row.slow_sd_cm as Record<string, number>, fa = row.fast_sd_cm as Record<string, number>;
    lines.push(`| ${source} | ${state} | ${row.n} | ${AXES.map(a => `${fmt(b[a])} ± ${fmt(bs[a])}`).join(' | ')} | ${AXES.map(a => fmt(sl[a])).join(' | ')} | ${AXES.map(a => fmt(fa[a])).join(' | ')} |`);
  }
  const wildN = ms.reduce((a, m) => a + (m.noise.wild.n ?? 0), 0);
  const wildRate = wildN ? ms.reduce((a, m) => a + (m.noise.wild.rate ?? 0) * m.noise.wild.n, 0) / wildN : null;
  const wildSize = (() => { let s = 0, n = 0; for (const m of ms) { const k = m.noise.wild.size_cm.n; if (k && m.noise.wild.size_cm.median !== null) { s += m.noise.wild.size_cm.median * k; n += k; } } return n ? s / n : null; })();
  const lostPerMin = ms.map(m => m.noise.lost.per_min).filter((v): v is number => v !== null);
  const lostShare = ms.map(m => m.noise.lost.share).filter((v): v is number => v !== null);
  const lostMs = (() => { let s = 0, n = 0; for (const m of ms) { const k = m.noise.lost.ms.n; if (k && m.noise.lost.ms.median !== null) { s += m.noise.lost.ms.median * k; n += k; } } return n ? s / n : null; })();
  const hz = ms.map(m => m.cost.pose_hz).filter((v): v is number => v !== null);
  const lost = { per_min: round(lostPerMin.reduce((a, b) => a + b, 0) / (lostPerMin.length || 1), 2), share: round(lostShare.reduce((a, b) => a + b, 0) / (lostShare.length || 1), 4), median_ms: round(lostMs, 0) };
  const poseHz = round(hz.reduce((a, b) => a + b, 0) / (hz.length || 1), 1);
  Object.assign(group, { wild: { rate: round(wildRate, 4), size_cm: round(wildSize, 1) }, lost, pose_hz: poseHz });
  lines.push('', `Wild raw poses (more than 15 cm from their ±200 ms median): ${fmt((wildRate ?? NaN) * 100, 2)}% of poses, median ${fmt(wildSize)} cm. Lost stretches (no pose > 100 ms): ${fmt(lost.per_min, 2)} a minute, ${fmt((lost.share ?? NaN) * 100, 2)}% of the time, median ${fmt(lostMs, 0)} ms. Pose rate ${fmt(poseHz)} Hz.`, '');
  out[`${players}p`] = group;
}
console.log(lines.join('\n'));
console.log(JSON.stringify(out));
