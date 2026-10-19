// The game's host hooks: tells the app when the main menu is showing (the Menu button then
// leaves the app), and, with a report URL in the launch config, posts frame stats every two
// seconds like client-tvos/src/inject.js does for the WebKit app. A launch config can also
// drive the game with remote key presses, waiting on the canvas's data-* state between them
// (the same state scripts/play.ts and the browser tests read), for unattended runs:
//   "drive": [["wait", {"menuScreen": "main", "menuReady": "true"}], ["key", "Enter"], ...]
import { Q, native } from './native.ts';
import { screenCanvas } from './dom.ts';
import { commands } from './webgl.ts';
import { setIntervalShim } from './web.ts';

type Step = ['wait', Record<string, string>, number?] | ['key', string] | ['sleep', number] | ['report', string];
type Config = { report?: string; label?: string; bench?: unknown; drive?: Step[] };
type Host = { key(type: string, key: string, code: string, repeat: boolean): void };

const dataset = () => (screenCanvas.current?.dataset ?? {}) as Record<string, string>;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function post(url: string, body: Record<string, unknown>) {
  fetch(url, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}

function loopBenchmark() {
  const t = performance.now();
  let s = 0;
  for (let i = 0; i < 2e7; i++) s += (i * 1.0000001) % 7;
  return { ms: round(performance.now() - t, 1), sink: s > 0 };
}

export function installGameHooks(config: Config, host: Host) {
  let atRoot: boolean | null = null;
  setIntervalShim(() => {
    const d = dataset();
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
    setIntervalShim(() => {
      const stats = JSON.parse(native.query(Q.frameStats, 2000) as string) as { frames: number; jsMs: { mean: number; p95: number }; execMs: { mean: number }; intervalMs: { mean: number; p50: number; p95: number } };
      const draws = commands();
      const frames = Math.max(1, stats.frames);
      post(url, {
        type: 'game', label, mark, t: Math.round(performance.now()),
        fps: stats.intervalMs.mean ? round(1000 / stats.intervalMs.mean, 1) : 0,
        frameMs: { p50: stats.intervalMs.p50, p95: stats.intervalMs.p95 }, jsMs: stats.jsMs, execMs: stats.execMs,
        drawsPerFrame: Math.round((draws - lastDraws) / frames), frames: stats.frames, dataset: { ...dataset() },
      });
      lastDraws = draws;
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
