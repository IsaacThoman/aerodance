// The game's own pose pipeline over a scene: the built pose worker (dist/) in Chromium on the GPU,
// set up exactly as WebcamPoseSource sets it up for the scene's player count, with the game's
// tracker and setup (gameloop.ts) in the loop.
//   node tools/trackbench/harness/run-game.ts <scene-id> [--model lite|full|heavy] [--realtime]
//        [--id <estimator-id>] [--busy-scale k | --busy-ms N] [--strip-width W | --no-strips] [--no-search] [--no-zoom] [--no-session] [--allow-cpu] [--running-mode IMAGE]
// Writes $TRACKBENCH_DATA/runs/<id>/<scene>/{detections.jsonl,tracked.jsonl,run.json}; the id is
// mp-<model>-game, with -rt for --realtime.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { ASSET_PATH, MEDIAPIPE_VERSION, MODELS } from '../../../packages/pose/browser/models.ts';
import { evenTiles } from '../../../packages/pose/browser/tiles.ts';
import { detectedConfidence } from '../../../packages/pose/browser/slots.ts';
import { DATA, REPO, danceWindow, frameFiles, loadScene, parseArgs, runDir, writeJson, writeJsonl } from './common.ts';
import type { DetFrame, TrackedFrame } from './common.ts';
import { GameLoop } from './gameloop.ts';
import { RENDERER_PROBE, launchGpu, serve } from './browser.ts';

/** The MediaPipe pose models (the game ships Lite; Full and Heavy are the same family, bigger). */
export const POSE_MODELS: Record<string, { sha256: string; url: string }> = {
  lite: { sha256: MODELS[0].sha256, url: MODELS[0].url },
  full: { sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1', url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task' },
  heavy: { sha256: '64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b', url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task' },
};
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The model file in $TRACKBENCH_DATA/models, downloaded if missing, its SHA-256 checked. */
export async function ensureModel(id: string): Promise<string> {
  const model = POSE_MODELS[id];
  if (!model) throw Error(`Unknown model ${id}`);
  const file = path.join(DATA, 'models', `pose_landmarker_${id}.task`);
  if (!existsSync(file)) {
    console.log(`downloading ${model.url}`);
    const res = await fetch(model.url);
    if (!res.ok) throw Error(`Model download failed: HTTP ${res.status}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${file}.part`, file);
  }
  const hash = sha256(file);
  if (hash !== model.sha256) throw Error(`${file}: SHA-256 ${hash}, expected ${model.sha256}`);
  return file;
}

/**
 * A copy of dist/ that rebuilds can't change under a running eval: dist-snapshot-<git short sha>
 * (with the worker's content hash added when dist was rebuilt from uncommitted changes).
 */
export function snapshotDist(): { dir: string; worker: string; commit: string } {
  const dist = path.join(REPO, 'dist');
  const workerOf = (dir: string) => existsSync(path.join(dir, 'assets')) ? readdirSync(path.join(dir, 'assets')).find(n => /^pose\.worker-.*\.js$/.test(n)) : undefined;
  const worker = workerOf(dist);
  if (!worker) throw Error('dist/ has no pose worker: run npm run build');
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'apps'], { cwd: REPO, encoding: 'utf8' }).trim() !== '';
  let dir = path.join(DATA, `dist-snapshot-${commit}`);
  if (existsSync(dir) && workerOf(dir) !== worker) dir = `${dir}-${worker.replace(/^pose\.worker-|\.js$/g, '')}`;
  if (!existsSync(dir)) {
    cpSync(dist, `${dir}.part`, { recursive: true });
    renameSync(`${dir}.part`, dir);
    writeJson(path.join(dir, 'SNAPSHOT.json'), { commit, worker, dirtySources: dirty, at: new Date().toISOString() });
  }
  return { dir, worker, commit: dirty ? `${commit}+dirty` : commit };
}

/**
 * The next frame WebcamPoseSource sends once the worker is free at freeAt, from frames[next] on:
 * the newest that arrived meanwhile (the older ones were replaced while waiting), sent at freeAt;
 * if none came, the next one, when it comes.
 */
export function nextFrame(frames: readonly { t: number }[], next: number, freeAt: number): { k: number; sentAt: number; skipped: number } {
  if (frames[next].t > freeAt) return { k: next, sentAt: frames[next].t, skipped: 0 };
  let last = next;
  while (last + 1 < frames.length && frames[last + 1].t <= freeAt) last++;
  return { k: last, sentAt: freeAt, skipped: last - next };
}

/** Worker timestamps are the frame's t_ms plus this, after the warm-up's (0-400 ms). */
const TIMESTAMP_OFFSET_MS = 1000;
interface WorkerResult { landmarks: NormalizedLandmark[][]; inferenceMs: number; looks?: (number[] | null)[]; searched?: boolean; roundtripMs: number; width: number; height: number; }

async function main() {
  const { positional: [sceneId], opts } = parseArgs(process.argv.slice(2), { model: 'string', realtime: 'bool', id: 'string', 'busy-scale': 'string', 'no-session': 'bool', 'allow-cpu': 'bool', 'running-mode': 'string', 'strip-width': 'string', 'no-strips': 'bool', 'busy-ms': 'string', 'no-search': 'bool', 'no-zoom': 'bool' });
  if (!sceneId) { console.error('usage: node tools/trackbench/harness/run-game.ts <scene-id> [--model lite|full|heavy] [--realtime] [--id <estimator-id>] [--busy-scale k | --busy-ms N] [--strip-width W | --no-strips] [--no-search] [--no-zoom] [--no-session] [--allow-cpu] [--running-mode IMAGE]'); process.exit(2); }
  const modelId = String(opts.model ?? 'lite'), realtime = !!opts.realtime, busyScale = Number(opts['busy-scale'] ?? 1);
  // IMAGE (a diagnostic, not what the game does): a fresh detection every frame, no strips.
  const runningMode = String(opts['running-mode'] ?? 'VIDEO');
  if (!['VIDEO', 'IMAGE'].includes(runningMode)) throw Error('--running-mode is VIDEO or IMAGE');
  const estimator = String(opts.id ?? `mp-${modelId}-game${runningMode === 'IMAGE' ? '-image' : ''}${realtime ? '-rt' : ''}`);
  const scene = loadScene(sceneId);
  const files = frameFiles(scene.dir);
  if (!files.length) throw Error(`${sceneId}: no frames`);
  const snapshot = snapshotDist();
  const modelFile = modelId === 'lite' ? path.join(snapshot.dir, ASSET_PATH, 'pose_landmarker_lite.task') : await ensureModel(modelId);
  if (sha256(modelFile) !== POSE_MODELS[modelId].sha256) throw Error(`${modelFile}: wrong SHA-256`);

  // As WebcamPoseSource.connect: one or two players ask for that many people in the whole
  // picture; three or four get a strip each (and room for one more in the fallback). Looks
  // with two or more; search with two, zoom with one.
  const players = scene.players;
  // --strip-width W (an experiment, not what the game does): a strip of that width per player
  // even with one or two players.
  const stripWidth = opts['strip-width'] ? Number(opts['strip-width']) : null;
  // --no-strips: the whole picture whatever the player count (as the iPhone/iPad app does).
  const tiles = opts['no-strips'] ? null : stripWidth ? Array.from({ length: players }, (_, i) => ({ x: Math.min(1 - stripWidth, Math.max(0, (i + 0.5) / players - stripWidth / 2)), width: stripWidth })) : evenTiles(players);
  const init = {
    type: 'initialize', sessionId: 'trackbench', playerCount: players <= 2 ? players : players + 1, looks: players > 1,
    ...(tiles ? { tiles } : {}), ...(players === 2 && !tiles && !opts['no-strips'] && !opts['no-search'] ? { search: true } : {}), ...(players === 1 && !opts['no-strips'] && !opts['no-zoom'] ? { zoom: true } : {}), modelHash: POSE_MODELS[modelId].sha256, ...(runningMode === 'IMAGE' ? { runningMode } : {}),
  };
  const server = await serve({ '/app': snapshot.dir, '/frames': path.join(scene.dir, 'frames'), '/models': path.dirname(modelFile) });
  const browser = await launchGpu();
  const out = runDir(estimator, sceneId);
  try {
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', m => { logs.push(m.text()); if (m.type() === 'warning' || m.type() === 'error') console.log('page:', m.text()); });
    page.on('pageerror', e => console.log('page error:', e.message));
    await page.goto(server.origin);
    const renderer = await page.evaluate(RENDERER_PROBE);
    const ready = await page.evaluate(async ({ worker, init, modelUrl, wasmUrl }) => {
      const w = new Worker(worker, { type: 'module' });
      const waiting = new Map<number, (r: unknown) => void>();
      let onReady: ((r: never) => void) | null = null, onError: ((e: Error) => void) | null = null;
      w.onmessage = ({ data }) => {
        if (data.type === 'error') { onError?.(Error(data.message)); for (const r of waiting.values()) r({ error: data.message }); waiting.clear(); }
        else if (data.type === 'ready') onReady?.(data as never);
        else if (data.type === 'result') { waiting.get(data.seq)?.(data); waiting.delete(data.seq); }
      };
      w.onerror = e => onError?.(Error(e.message));
      const grey = async (width: number, height: number) => {
        const c = new OffscreenCanvas(width, height), g = c.getContext('2d')!;
        g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
        return createImageBitmap(c);
      };
      const send = (bitmap: ImageBitmap, seq: number, timestampMs: number, players: number) => new Promise<Record<string, unknown>>(resolve => {
        waiting.set(seq, resolve as (r: unknown) => void); w.postMessage({ type: 'frame', bitmap, seq, timestampMs, players }, [bitmap]);
      });
      (globalThis as unknown as Record<string, unknown>).tb = {
        /** Warms the model up on a frame, then shows it nothing so it starts the scene following nobody. */
        async warm(url: string) {
          const start = performance.now();
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          const { width, height } = bitmap;
          await send(bitmap, -1, 0, 0);
          for (let i = 0; i < 4; i++) await send(await grey(width, height), -2 - i, 100 * (i + 1), 0);
          return performance.now() - start;
        },
        async frame(url: string, seq: number, timestampMs: number, players: number) {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          const { width, height } = bitmap;
          const start = performance.now();
          const result = await send(bitmap, seq, timestampMs, players);
          if (result.error) throw Error(String(result.error));
          return { landmarks: result.landmarks, inferenceMs: result.inferenceMs, looks: result.looks, searched: result.searched, roundtripMs: performance.now() - start, width, height };
        },
      };
      return new Promise((resolve, reject) => { onReady = resolve; onError = reject; w.postMessage({ ...init, modelUrl, wasmUrl }); });
    }, { worker: `/app/assets/${snapshot.worker}`, init, modelUrl: `${server.origin}/models/${path.basename(modelFile)}`, wasmUrl: `${server.origin}/app/${ASSET_PATH}/wasm` }) as { delegate: string; fallback: string; tiled?: boolean };
    console.log(`${estimator}/${sceneId}: renderer ${renderer}; delegate ${ready.delegate}${ready.fallback ? ` (${ready.fallback})` : ''}${tiles ? `; strips ${ready.tiled}` : ''}`);
    if (/swiftshader|llvmpipe|software/i.test(renderer) || ready.delegate !== 'GPU') {
      if (!opts['allow-cpu']) throw Error(`Not on the GPU (renderer ${renderer}, delegate ${ready.delegate}); --allow-cpu to run anyway`);
    }
    if (tiles && !ready.tiled && runningMode === 'VIDEO') throw Error('The worker could not set up its strips');

    // (The first results compile the GPU programs, hundreds of ms the game spends before anybody
    // steps in; VIDEO timestamps are the frames' t_ms after the warm-up's.)
    const warmupMs = await page.evaluate(url => (globalThis as unknown as { tb: { warm: (u: string) => Promise<number> } }).tb.warm(url), `/frames/${files[0]}`);
    const frames = files.map(name => { const n = Number(name.slice(0, -4)); return { n, name, t: scene.byFrame.get(n)?.t_ms ?? (n - 1) * 1000 / scene.fps }; });
    const loop = new GameLoop(players, { width: scene.width, height: scene.height }, { session: !opts['no-session'], danceStartMs: danceWindow(scene)?.[0] ?? Infinity });
    const detections: DetFrame[] = [], tracked: TrackedFrame[] = [];
    let seq = 0, freeAt = -Infinity, next = 0, cameraDropped = 0;
    const t0 = Date.now();
    while (next < frames.length) {
      // Which frame goes next, and when. Offline: every frame, the moment it's taken. Realtime:
      // as WebcamPoseSource, one in flight; the newest frame that came meanwhile waits for the
      // result (replacing older ones) and goes as soon as it's in, else the next one when it comes.
      const { k, sentAt, skipped } = realtime ? nextFrame(frames, next, freeAt) : { k: next, sentAt: frames[next].t, skipped: 0 };
      cameraDropped += skipped;
      const f = frames[k];
      const r = await page.evaluate(({ url, seq, t, players }) => (globalThis as unknown as { tb: { frame: (...a: unknown[]) => Promise<unknown> } }).tb.frame(url, seq, t, players),
        { url: `/frames/${f.name}`, seq: ++seq, t: f.t + TIMESTAMP_OFFSET_MS, players: loop.players }) as WorkerResult;
      if (r.width !== scene.width || r.height !== scene.height) throw Error(`Frame ${f.name} is ${r.width}x${r.height}, expected ${scene.width}x${scene.height}`);
      // --busy-ms: a fixed time per result (a slower device), instead of the measured one scaled.
      const busy = opts['busy-ms'] ? Number(opts['busy-ms']) : r.roundtripMs * busyScale;
      const received = realtime ? sentAt + busy : f.t;
      freeAt = received;
      const record = loop.result(f.n, r.landmarks, r.looks, f.t, received);
      detections.push({
        frame: f.n, t_ms: f.t, inference_ms: Number(r.inferenceMs.toFixed(3)), roundtrip_ms: Number(r.roundtripMs.toFixed(3)), ...(r.searched ? { searched: true } : {}),
        ...(realtime ? { sent_ms: sentAt, received_ms: received, ...(record.dropped ? { dropped: true } : {}) } : {}),
        people: r.landmarks.map(points => ({ kp: points.map(p => [p.x, p.y, p.z, detectedConfidence(p) ?? 0] as [number, number, number, number]), score: null })),
        ...(r.looks ? { looks: r.looks } : {}),
      } as DetFrame);
      tracked.push(record);
      next = k + 1;
      if (detections.length % 100 === 0) console.log(`  ${detections.length} results, frame ${f.n}/${frames.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    writeJsonl(path.join(out, 'detections.jsonl'), detections);
    writeJsonl(path.join(out, 'tracked.jsonl'), tracked);
    const inf = detections.map(d => d.inference_ms!);
    writeJson(path.join(out, 'run.json'), {
      estimator, scene: sceneId, model: { id: modelId, file: path.basename(modelFile), sha256: POSE_MODELS[modelId].sha256, mediapipe: MEDIAPIPE_VERSION },
      runtime: `Chromium ${browser.version()} (${renderer}), MediaPipe ${MEDIAPIPE_VERSION} tasks-vision, ${ready.delegate} delegate${tiles ? `, ${tiles.length} strips` : ''}`,
      renderer, delegate: ready.delegate, fallback: ready.fallback, tiled: !!ready.tiled,
      dist: { snapshot: snapshot.dir, worker: snapshot.worker, commit: snapshot.commit },
      settings: { players, init: { ...init, tiles: tiles ?? null }, runningMode, timestamps: `frame t_ms + ${TIMESTAMP_OFFSET_MS}`, warmup_ms: Number(warmupMs.toFixed(1)), realtime, busyScale, session: !opts['no-session'] },
      machine: { host: os.hostname(), cpu: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}` },
      frames: frames.length, results: detections.length, camera_frames_dropped: cameraDropped, results_dropped: tracked.filter(t => t.dropped).length,
      inference_ms_mean: Number((inf.reduce((a, b) => a + b, 0) / inf.length).toFixed(2)),
      wall_s: (Date.now() - t0) / 1000, at: new Date().toISOString(),
    });
    console.log(`${estimator}/${sceneId}: ${detections.length} results (${cameraDropped} camera frames dropped, ${tracked.filter(t => t.dropped).length} results too old) in ${((Date.now() - t0) / 1000).toFixed(0)} s, inference ${(inf.reduce((a, b) => a + b, 0) / inf.length).toFixed(1)} ms`);
  } finally {
    await browser.close();
    await server.close();
  }
}

if (import.meta.main) await main();
