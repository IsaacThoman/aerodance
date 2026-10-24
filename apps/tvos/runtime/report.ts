// The game's host hooks: tells the app when the game has loaded (the splash covers it until
// then) and when the main menu is showing (the Menu button then leaves the app), and, with a
// report URL in the launch config, posts frame stats every two seconds. A launch config can also
// drive the game with remote key presses, waiting on the canvas's data-* state between them
// (the same state scripts/play.ts and the browser tests read), for unattended runs:
//   "drive": [["wait", {"menuScreen": "main", "menuReady": "true"}], ["key", "Enter"], ...]
import { Q, native } from './native.ts';
import { screenCanvas } from './dom.ts';
import { commands, counters } from './webgl.ts';
import { setIntervalShim } from './web.ts';

type Step = ['wait', Record<string, string>, number?] | ['key', string] | ['sleep', number] | ['report', string];
type Config = { script?: string; report?: string; label?: string; bench?: unknown; drive?: Step[]; profile?: boolean };
type Host = { key(type: string, key: string, code: string, repeat: boolean): void };

const dataset = () => (screenCanvas.current?.dataset ?? {}) as Record<string, string>;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function post(url: string, body: Record<string, unknown>) {
  if (url === 'file') { native.report(JSON.stringify(body)); return; }
  fetch(url, { method: 'POST', body: JSON.stringify(body) }).catch((error: unknown) => console.warn('report failed:', String(error)));
}

function loopBenchmark() {
  const t = performance.now();
  let s = 0;
  for (let i = 0; i < 2e7; i++) s += (i * 1.0000001) % 7;
  return { ms: round(performance.now() - t, 1), sink: s > 0 };
}

/** With "profile" in the launch config: time spent in each WebGL and 2D canvas method. */
const profile = new Map<string, { calls: number; ms: number }>();
function installProfiler() {
  const g = globalThis as unknown as Record<string, { prototype: Record<string, unknown> }>;
  for (const cls of ['WebGL2RenderingContext', 'CanvasRenderingContext2D']) {
    const proto = g[cls].prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || typeof d.value !== 'function' || key === 'constructor' || key.startsWith('_')) continue;
      const fn = d.value as (...a: unknown[]) => unknown;
      const name = `${cls === 'WebGL2RenderingContext' ? 'gl' : '2d'}.${key}`;
      const entry = { calls: 0, ms: 0 };
      profile.set(name, entry);
      proto[key] = function (this: unknown, ...args: unknown[]) {
        const t = native.now();
        try { return fn.apply(this, args); } finally { entry.ms += native.now() - t; entry.calls++; }
      };
    }
  }
}
function takeProfile(frames: number) {
  const top = [...profile.entries()].filter(([, e]) => e.calls).sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)
    .map(([k, e]) => `${k} ${round(e.calls / frames, 1)}x ${round(e.ms / frames)}ms`);
  const total = [...profile.values()].reduce((a, e) => a + e.ms, 0) / frames;
  for (const e of profile.values()) { e.calls = 0; e.ms = 0; }
  return { totalMs: round(total), top };
}

export function installGameHooks(config: Config, host: Host) {
  if (config.profile) installProfiler();
  let atRoot: boolean | null = null;
  // The game is ready once its menu (or a stage) has faded in; other scripts at once.
  let ready = config.script !== 'game.js';
  if (ready) native.ready();
  setIntervalShim(() => {
    const d = dataset();
    if (!ready && (d.menuReady === 'true' || d.stageReady === 'true')) { ready = true; native.ready(); }
    const now = d.menuScreen === 'main' && d.connectOpen !== 'true';
    if (now !== atRoot) { atRoot = now; native.setAtRoot(now); }
  }, 250);
  if (config.bench) return;
  const label = config.label ?? 'jsc-gles';
  const url = config.report;
  let mark = '';
  if (url) {
    const loop = loopBenchmark();
    post(url, { type: 'start', label, loopMs: loop.ms, mode: ['direct', 'batched', 'threaded'][native.mode] });
    let lastDraws = commands();
    let last = { ...counters };
    setIntervalShim(() => {
      const stats = JSON.parse(native.query(Q.frameStats, 2000) as string) as { frames: number; jsMs: { mean: number; p95: number }; execMs: { mean: number }; intervalMs: { mean: number; p50: number; p95: number }; wordsPerFrame: { mean: number }; memMB: number };
      const draws = commands();
      const frames = Math.max(1, stats.frames);
      post(url, {
        type: 'game', label, mark, t: Math.round(performance.now()),
        fps: stats.intervalMs.mean ? round(1000 / stats.intervalMs.mean, 1) : 0,
        frameMs: { p50: stats.intervalMs.p50, p95: stats.intervalMs.p95 }, ...stats, wordsPerFrame: Math.round(stats.wordsPerFrame.mean),
        drawsPerFrame: Math.round((draws - lastDraws) / frames), frames: stats.frames, dataset: { ...dataset() },
        ...(config.profile ? { profile: takeProfile(frames) } : {}),
        perFrame: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, round((v - last[k as keyof typeof counters]) / frames, 1)])),
      });
      lastDraws = draws;
      last = { ...counters };
    }, 2000);
  }
  if (config.drive) void drive(config.drive, host, url, label, (m) => { mark = m; });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drive(steps: Step[], host: Host, url: string | undefined, label: string, setMark: (m: string) => void) {
  const t0 = performance.now();
  for (const step of steps) {
    if (step[0] === 'key') {
      host.key('keydown', step[1], step[1], false);
      host.key('keyup', step[1], step[1], false);
      console.log(`drive: key ${step[1]}`);
    } else if (step[0] === 'sleep') await sleep(step[1]);
    else if (step[0] === 'report') { setMark(step[1]); console.log(`drive: mark ${step[1]}`); } else {
      const want = step[1], timeout = step[2] ?? 60000, start = performance.now();
      const ok = () => Object.entries(want).every(([k, v]) => dataset()[k] === v);
      while (!ok()) {
        if (performance.now() - start > timeout) {
          console.warn(`drive: timed out waiting for ${JSON.stringify(want)}; state ${JSON.stringify(dataset())}`);
          if (url) post(url, { type: 'error', label, message: `drive timed out waiting for ${JSON.stringify(want)}`, dataset: dataset() });
          return;
        }
        await sleep(100);
      }
      console.log(`drive: ${JSON.stringify(want)} after ${Math.round(performance.now() - t0)} ms`);
    }
  }
  if (url) post(url, { type: 'done', label, ms: Math.round(performance.now() - t0) });
}
