// A runtime-neutral benchmark of the Aero world (the game's menu background, plain three.js),
// used to compare ways of running the game on Apple TV. It needs only what three.js and the
// Aero world need: a canvas with WebGL2 and 2D contexts, requestAnimationFrame and
// performance.now. See README.md in this folder for the host contract and the report format.
import * as THREE from 'three';
import { createAeroWorld, type AeroPart } from '../../client/src/aero/aeroBackground.ts';

type Quality = 'high' | 'low' | 'tv';
// A scenario is a quality, optionally with parts of the world left out, a render scale and a
// start on the loop: 'high', 'low', 'tv', 'high:clouds+birds' (no clouds or birds), 'high@0.5'
// (320x240), 'high#0.2' (from 0.2 round the loop: downtown and the lake instead of the meadow).
type Scenario = string;
type Config = {
  scenarios: Scenario[]; warmupS: number; measureS: number; start: number; width: number; height: number; label: string;
  /** Diagnostics: wait for the GPU after each frame (a 1-pixel readPixels) and report how long that took. */
  sync: boolean;
  /** The renderer's MSAA (default on, as in the game). */
  antialias: boolean;
};
type Host = typeof globalThis & {
  __benchConfig?: Partial<Config>;
  __benchCanvas?: HTMLCanvasElement;
  __benchReport?: (json: string) => void;
  __benchReportUrl?: string;
  __benchDone?: boolean;
};
const host = globalThis as Host;

function readConfig(): Config {
  const config: Config = { scenarios: ['high', 'low'], warmupS: 5, measureS: 30, start: 0.08, width: 640, height: 480, label: 'unknown', sync: false, antialias: true };
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const scenarios = q.get('scenarios');
  if (scenarios) config.scenarios = scenarios.split(',');
  if (q.get('sync')) config.sync = q.get('sync') === '1';
  if (q.get('antialias')) config.antialias = q.get('antialias') !== '0';
  for (const key of ['warmupS', 'measureS', 'start'] as const) if (q.get(key)) config[key] = Number(q.get(key));
  if (q.get('label')) config.label = q.get('label') ?? config.label;
  if (q.get('report')) host.__benchReportUrl = q.get('report') ?? undefined;
  return { ...config, ...host.__benchConfig };
}

function report(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload);
  console.log(`BENCH ${json}`);
  if (host.__benchReport) host.__benchReport(json);
  else if (host.__benchReportUrl && typeof fetch === 'function') {
    fetch(host.__benchReportUrl, { method: 'POST', mode: 'no-cors', body: json }).catch(() => {});
  }
}

const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

// A tight numeric loop: about 285 ms with a JIT and 565 ms without on an M5 Pro. Only the
// ratio between hosts on the same device means anything.
function loopBenchmark() {
  const t = performance.now();
  let s = 0;
  for (let i = 0; i < 2e7; i++) s += (i * 1.0000001) % 7;
  return { ms: round(performance.now() - t, 1), sink: s > 0 };
}

function parseScenario(spec: Scenario) {
  const [main, start] = spec.split('#');
  const [rest, scale = '1'] = main.split('@');
  const [quality, hide = ''] = rest.split(':');
  // (An unescaped + in a query string arrives as a space.)
  return { quality: quality as Quality, hide: hide ? hide.split(/[+ ]/) as AeroPart[] : [], scale: Number(scale) || 1, start: start === undefined ? undefined : Number(start) };
}

async function runScenario(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer, config: Config, spec: Scenario) {
  const { quality, hide, scale, start = config.start } = parseScenario(spec);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(66, config.width / config.height, 0.3, 6500);
  renderer.setSize(Math.round(config.width * scale), Math.round(config.height * scale), false);
  const pixel = new Uint8Array(4);
  const gl = renderer.getContext();
  const buildStart = performance.now();
  const world = createAeroWorld({ renderer, scene, camera, quality, start, hide });
  const buildMs = performance.now() - buildStart;

  // The first frames compile shaders; time them separately.
  const firstStart = performance.now();
  world.update(1 / 60); world.render();
  await nextFrame();
  const firstFrameMs = performance.now() - firstStart;

  const intervals: number[] = [], cpu: number[] = [], sync: number[] = [], series: number[] = [];
  let draws = 0, triangles = 0, measured = 0;
  let last = await nextFrame();
  const warmupEnd = last + config.warmupS * 1000, end = warmupEnd + config.measureS * 1000;
  for (;;) {
    const now = await nextFrame();
    const dt = now - last; last = now;
    const t0 = performance.now();
    renderer.info.reset();
    world.update(Math.min(dt, 100) / 1000);
    world.render();
    const spent = performance.now() - t0;
    let waited = 0;
    if (config.sync) {
      const t1 = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      waited = performance.now() - t1;
    }
    if (now < warmupEnd) continue;
    if (now > end) break;
    intervals.push(dt); cpu.push(spent); sync.push(waited);
    const bucket = Math.floor((now - warmupEnd) / 2000);
    series[bucket] = (series[bucket] ?? 0) + 1;
    draws += renderer.info.render.calls; triangles += renderer.info.render.triangles; measured++;
  }
  world.dispose();
  renderer.setSize(config.width, config.height, false);
  const sortedIntervals = [...intervals].sort((a, b) => a - b), sortedCpu = [...cpu].sort((a, b) => a - b);
  const total = intervals.reduce((a, b) => a + b, 0);
  void canvas;
  return {
    scenario: `aero-${spec}`, quality, frames: measured,
    fps: round(measured / (total / 1000), 1),
    frameMs: { p50: round(percentile(sortedIntervals, 0.5)), p95: round(percentile(sortedIntervals, 0.95)), p99: round(percentile(sortedIntervals, 0.99)), max: round(sortedIntervals.at(-1) ?? 0) },
    cpuMs: { mean: round(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)), p95: round(percentile(sortedCpu, 0.95)) },
    drawsPerFrame: Math.round(draws / Math.max(1, measured)),
    trianglesPerFrame: Math.round(triangles / Math.max(1, measured)),
    buildMs: round(buildMs, 0), firstFrameMs: round(firstFrameMs, 0),
    /** Frames a second in each 2 s of the measurement. */
    fpsSeries: Array.from(series, (n) => (n ?? 0) / 2),
    ...(config.sync ? { syncMs: { mean: round(sync.reduce((a, b) => a + b, 0) / Math.max(1, sync.length)), p95: round(percentile([...sync].sort((a, b) => a - b), 0.95)) } } : {}),
  };
}

async function main() {
  const config = readConfig();
  const canvas = host.__benchCanvas ?? document.querySelector('canvas') ?? document.createElement('canvas');
  canvas.width = config.width; canvas.height = config.height;
  const loop = loopBenchmark();
  report({ type: 'start', label: config.label, loopMs: loop.ms, config, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'none' });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: config.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(config.width, config.height, false);
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const results = [];
  for (const spec of config.scenarios) {
    const result = { type: 'scenario', label: config.label, gpu, loopMs: loop.ms, ...(await runScenario(canvas, renderer, config, spec)) };
    results.push(result);
    report(result);
  }
  report({ type: 'done', label: config.label, gpu, loopMs: loop.ms, results });
  host.__benchDone = true;
}

main().catch((error: unknown) => report({ type: 'error', message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }));
