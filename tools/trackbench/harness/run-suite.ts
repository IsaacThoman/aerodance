// Runs independent scenes at once, each in a fresh page and pose worker; frames within a scene
// stay serial. Each job slot has a browser of its own: pages of one browser share its GPU process,
// which serialised their work (four pages in one browser ran 17 scenes in 191 s; four browsers in
// 58 s, eight in 42 s, against 236 s one at a time on an M5 Pro). Results are identical whatever
// the jobs; --realtime runs alone, as it measures timing.
//   node tools/trackbench/harness/run-suite.ts --id <estimator> [--jobs N] [--browsers N] [--force] [prefix...] [-- run-game flags]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DATA, frameFiles, parseArgs, runDir, sceneDir } from './common.ts';
import { launchGpu, serve } from './browser.ts';
import { prepareRun, RUN_GAME_FLAGS, runScene } from './run-game.ts';
import type { RunOptions } from './run-game.ts';

export interface SuiteScene { id: string; frames: number; }

/**
 * A scene's run is done when its tracking exists, isn't empty, and is no older than the scene's
 * render (its READY marker), as matrix.py has it: a re-rendered scene runs again.
 */
export function runDone(output: string, ready: string): boolean {
  if (!existsSync(output)) return false;
  const run = statSync(output);
  return run.size > 0 && (!existsSync(ready) || run.mtimeMs >= statSync(ready).mtimeMs);
}

/** Eight browsers was fastest on an M5 Pro (18 cores); smaller machines get half their cores. */
export const DEFAULT_JOBS = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));

/** Longest scenes first, with a stable tie-break so a suite's launch order is reproducible. */
export function orderScenes(scenes: readonly SuiteScene[]): SuiteScene[] {
  return [...scenes].sort((a, b) => b.frames - a.frames || a.id.localeCompare(b.id));
}

export function parseSuiteArgs(argv: string[]) {
  const separator = argv.indexOf('--');
  const { positional: prefixes, opts } = parseArgs(separator < 0 ? argv : argv.slice(0, separator), { id: 'string', jobs: 'string', browsers: 'string', force: 'bool', 'no-metrics': 'bool' });
  if (typeof opts.id !== 'string' || !opts.id || opts.id.startsWith('--')) throw Error('--id <estimator-id> is required');
  const requestedJobs = Number(opts.jobs ?? DEFAULT_JOBS);
  if (!Number.isSafeInteger(requestedJobs) || requestedJobs < 1) throw Error('--jobs must be a positive integer');
  const { positional, opts: game } = parseArgs(separator < 0 ? [] : argv.slice(separator + 1), RUN_GAME_FLAGS);
  if (positional.length || game.id !== undefined) throw Error('Put scene prefixes and --id before --; only run-game flags go after it');
  const jobs = game.realtime ? 1 : requestedJobs;
  const browsers = Number(opts.browsers ?? jobs);
  if (!Number.isSafeInteger(browsers) || browsers < 1) throw Error('--browsers must be a positive integer');
  return { id: opts.id, prefixes, jobs, browsers: Math.min(browsers, jobs), requestedJobs, force: !!opts.force, metrics: !opts['no-metrics'], game: { ...game, id: opts.id } as RunOptions };
}

/** A failure belongs to its scene: every other scene still gets a turn. */
export async function runJobs<T>(items: readonly T[], jobs: number, run: (item: T, slot: number) => Promise<void>, failed: (item: T, error: unknown) => void): Promise<number> {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw Error('jobs must be a positive integer');
  let next = 0, failures = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async (_, slot) => {
    while (next < items.length) {
      const item = items[next++];
      try { await run(item, slot); }
      catch (error) { failures++; failed(item, error); }
    }
  }));
  return failures;
}

async function main() {
  const { id, prefixes, jobs, browsers: browserCount, requestedJobs, force, metrics, game } = parseSuiteArgs(process.argv.slice(2));
  if (game.realtime) console.log(`--realtime: using --jobs 1 (requested ${requestedJobs}); timing runs must run alone`);
  const scenes = orderScenes(readdirSync(path.join(DATA, 'scenes'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('real-'))
    .map(entry => entry.name)
    .filter(name => existsSync(path.join(sceneDir(name), 'READY')) && (!prefixes.length || prefixes.some(prefix => name.startsWith(prefix))))
    .filter(name => force || !runDone(path.join(runDir(id, name), 'tracked.jsonl'), path.join(sceneDir(name), 'READY')))
    .map(name => ({ id: name, frames: frameFiles(sceneDir(name)).length })));
  console.log(`${id}: ${scenes.length} scenes, ${jobs} jobs, ${browserCount} browser(s)`);
  const started = performance.now();
  let failures = 0;
  if (scenes.length) {
    const prepared = await prepareRun(game);
    const server = await serve({ '/app': prepared.snapshot.dir, '/scenes': path.join(DATA, 'scenes'), '/models': path.dirname(prepared.modelFile) });
    // Each browser has its own GPU process; job slots share them round-robin.
    const browsers: Awaited<ReturnType<typeof launchGpu>>[] = [];
    try {
      for (let i = 0; i < browserCount; i++) browsers.push(await launchGpu());
      failures = await runJobs(scenes, jobs, async (scene, slot) => {
        const start = performance.now();
        try {
          await runScene(scene.id, game, { browser: browsers[slot % browsers.length], server, prepared, framePrefix: `/scenes/${encodeURIComponent(scene.id)}/frames`, quiet: true });
          console.log(`${id}/${scene.id}: done in ${((performance.now() - start) / 1000).toFixed(2)} s`);
        } catch (error) {
          console.error(`${id}/${scene.id}: FAILED in ${((performance.now() - start) / 1000).toFixed(2)} s: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      }, () => {});
    } finally {
      try { await Promise.all(browsers.map(browser => browser.close())); }
      finally { await server.close(); }
    }
  }
  console.log(`${id}: ${scenes.length} scenes, ${failures} failures, wall ${((performance.now() - started) / 1000).toFixed(2)} s`);
  if (metrics) {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./metrics.ts', import.meta.url)), id], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', resolve);
    });
    if (code !== 0) throw Error(`metrics.ts failed (exit ${code})`);
  }
  if (failures) process.exitCode = 1;
}

if (import.meta.main) await main();
