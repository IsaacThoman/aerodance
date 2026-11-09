// Replays one run's detections through the current tracker into a new id, then scores it.
//   node tools/trackbench/studies/retrack.ts <from-estimator> <to-id> [scene-prefix...] [--jobs n]
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, parseArgs, runDir, writeJson } from '../harness/common.ts';
import { jobsOption, scenePool } from '../harness/pool.ts';
import { trackScene } from '../harness/track.ts';

/** Serialise in the worker to avoid transferring the much larger tree of joint objects. */
export async function retrackScene(item: { estimator: string; sceneId: string }) {
  try {
    const { tracked, metadata } = await trackScene(item);
    return { tracked: tracked.map(r => JSON.stringify(r)).join('\n') + (tracked.length ? '\n' : ''), metadata };
  } catch (error) {
    return { error: error instanceof Error ? error.stack : String(error) };
  }
}

if (import.meta.main) {
  const { positional: [from, to, ...prefixes], opts } = parseArgs(process.argv.slice(2), { jobs: 'string' });
  if (!from || !to) { console.error('usage: node tools/trackbench/studies/retrack.ts <from-estimator> <to-id> [scene-prefix...] [--jobs n]'); process.exit(2); }
  const jobs = jobsOption(opts.jobs);
  const scenes = readdirSync(path.join(DATA, 'runs', from)).sort().filter(s =>
    !s.startsWith('.') && existsSync(path.join(runDir(from, s), 'detections.jsonl')) && (!prefixes.length || prefixes.some(p => s.startsWith(p))));
  for (const sid of scenes) {
    const dir = runDir(to, sid), link = path.join(dir, 'detections.jsonl');
    mkdirSync(dir, { recursive: true });
    // ln -sf, as in retrack.sh: replace the destination link on a repeated replay.
    try { unlinkSync(link); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    symlinkSync(path.resolve(runDir(from, sid), 'detections.jsonl'), link);
  }
  const results = await scenePool<Parameters<typeof retrackScene>[0], Awaited<ReturnType<typeof retrackScene>>>(
    new URL(import.meta.url), retrackScene, scenes.map(sceneId => ({ estimator: to, sceneId })), jobs);
  for (const [i, result] of results.entries()) {
    const sid = scenes[i];
    if ('error' in result) { console.error(result.error); console.log(`FAIL track ${sid}`); continue; }
    writeFileSync(path.join(runDir(to, sid), 'tracked.jsonl'), result.tracked);
    writeJson(path.join(runDir(to, sid), 'track.json'), { ...result.metadata, at: new Date().toISOString() });
  }
  const logFile = path.join(DATA, 'logs', `metrics-${to}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  // Keep the shell command's metrics log and failure behaviour.
  const log = openSync(logFile, 'w');
  try {
    const metrics = spawn(process.execPath, [fileURLToPath(new URL('../harness/metrics.ts', import.meta.url)), to, '--jobs', String(jobs)], { stdio: ['ignore', log, log] });
    const code = await new Promise<number | null>((resolve, reject) => { metrics.on('error', reject); metrics.on('exit', resolve); });
    if (code !== 0) console.log('FAIL metrics');
  } finally { closeSync(log); }
}
