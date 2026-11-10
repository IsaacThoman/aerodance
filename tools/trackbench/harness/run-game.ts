// The game's own pose pipeline over a scene: the built pose worker (dist/) in Chromium on the GPU,
// set up exactly as WebcamPoseSource sets it up for the scene's player count, with the game's
// tracker and setup (gameloop.ts) in the loop.
//   node tools/trackbench/harness/run-game.ts <scene-id> [--model lite|full|heavy] [--realtime]
//        [--id <estimator-id>] [--busy-scale k | --busy-ms N] [--strip-width W | --no-strips] [--no-search] [--no-zoom] [--no-session] [--allow-cpu] [--running-mode IMAGE]
//        [--detail none|world|hands|hands:<side>/<side>|minigame:<id>] [--input-size WxH]
// --detail asks the worker for what a minigame asks for (MinigameDefinition.tracking: Table Tennis
// is 'hands' with one player, 'hands:right/right' with two; minigame:table-tennis asks it), as
// WebcamPoseSource.setDetail does;
// --input-size feeds the worker each frame scaled to that size (a 1280x960 render as the game's
// 640x480 webcam).
// Writes $TRACKBENCH_DATA/runs/<id>/<scene>/{detections.jsonl,tracked.jsonl,run.json}; the id is
// mp-<model>-game, with -rt for --realtime.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { ASSET_PATH, HAND_MODEL, MEDIAPIPE_VERSION, MODELS } from '../../../packages/pose/browser/models.ts';
import { detailRequest, workerSettings } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { Tile } from '../../../packages/pose/browser/tiles.ts';
import { isPoseDetail } from '../../../packages/pose/webcamRecord.ts';
import type { PoseDetail, TrackedHand } from '../../../packages/pose/webcamRecord.ts';
import { detectedConfidence } from '../../../packages/pose/browser/slots.ts';
import { DATA, REPO, danceWindow, frameFiles, loadScene, parseArgs, runDir, writeJson, writeJsonl } from './common.ts';
import type { DetFrame, Point3, TrackedFrame } from './common.ts';
import { GameLoop, toDetHand } from './gameloop.ts';
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
interface WorkerResult {
  landmarks: NormalizedLandmark[][]; inferenceMs: number; looks?: (number[] | null)[]; searched?: boolean; roundtripMs: number; width: number; height: number;
  world?: { x: number; y: number; z: number }[][]; hands?: TrackedHand[][];
}

export const RUN_GAME_FLAGS = { model: 'string', realtime: 'bool', id: 'string', 'busy-scale': 'string', 'no-session': 'bool', 'allow-cpu': 'bool', 'running-mode': 'string', 'strip-width': 'string', 'no-strips': 'bool', 'busy-ms': 'string', 'no-search': 'bool', 'no-zoom': 'bool', detail: 'string', 'input-size': 'string' } as const;
export type RunOptions = Record<string, string | boolean>;

/**
 * The worker's settings for this many players: WebcamPoseSource.connect's (workerSettings), less
 * what the experiment flags take away. --strip-width W: a strip of that width per player even
 * with one or two; --no-strips: the whole picture whatever the count (as the iPhone/iPad app
 * does); --no-search, --no-zoom.
 */
export function gameInit(players: number, opts: RunOptions = {}) {
  const game = workerSettings(players);
  const stripWidth = opts['strip-width'] ? Number(opts['strip-width']) : null;
  const tiles: Tile[] | null = opts['no-strips'] ? null : stripWidth
    ? Array.from({ length: players }, (_, i) => ({ x: Math.min(1 - stripWidth, Math.max(0, (i + 0.5) / players - stripWidth / 2)), width: stripWidth }))
    : game.tiles ?? null;
  const search = !!game.search && !tiles && !opts['no-strips'] && !opts['no-search'];
  const zoom = !!game.zoom && !opts['no-strips'] && !opts['no-zoom'];
  return { playerCount: game.playerCount, looks: game.looks, ...(tiles ? { tiles } : {}), ...(search ? { search } : {}), ...(zoom ? { zoom } : {}) };
}

/** --detail: none (the songs' default) or a PoseDetail. */
export function parseDetail(value: unknown): PoseDetail | null {
  if (value === undefined || value === 'none') return null;
  if (!isPoseDetail(value)) throw Error(`--detail is none, world, hands, hands:<left|right|both>/... or minigame:<id> (got ${String(value)})`);
  return value;
}

/**
 * --detail minigame:<id>: what that minigame's `tracking` asks for with this many players and
 * its default options (Table Tennis: 'hands' alone, 'hands:right/right' for two); else parseDetail.
 */
export async function resolveDetail(value: unknown, players: number): Promise<PoseDetail | null> {
  const m = typeof value === 'string' ? /^minigame:([a-z0-9-]+)$/.exec(value) : null;
  if (!m) return parseDetail(value);
  const file = path.join(REPO, 'apps/web/src/minigames', m[1], 'index.ts');
  if (!existsSync(file)) throw Error(`No minigame ${m[1]}`);
  const game = (await import(file)).default as { tracking?: PoseDetail | ((round: { playerCount: number; options: Record<string, string> }) => PoseDetail | null) };
  const tracking = typeof game.tracking === 'function' ? game.tracking({ playerCount: players, options: {} }) : game.tracking ?? null;
  return parseDetail(tracking ?? undefined);
}

/** --input-size WxH, or null for the frames' own size. */
export function parseInputSize(value: unknown): { width: number; height: number } | null {
  if (value === undefined) return null;
  const m = /^(\d+)x(\d+)$/.exec(String(value));
  if (!m || !Number(m[1]) || !Number(m[2])) throw Error(`--input-size is WxH, e.g. 640x480 (got ${String(value)})`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

const p3 = (p: { x: number; y: number; z: number }): Point3 => [p.x, p.y, p.z];
type PreparedRun = { snapshot: ReturnType<typeof snapshotDist>; modelFile: string };
type SceneResources = {
  browser?: Browser;
  server?: Awaited<ReturnType<typeof serve>>;
  /** Shared servers mount all scenes here; a standalone run still uses /frames. */
  framePrefix?: string;
  prepared?: PreparedRun;
  quiet?: boolean;
};

/** Prepare the immutable worker snapshot and checked model once for a suite. */
export async function prepareRun(opts: RunOptions): Promise<PreparedRun> {
  const modelId = String(opts.model ?? 'lite');
  if (!POSE_MODELS[modelId]) throw Error(`Unknown model ${modelId}`);
  const snapshot = snapshotDist();
  const modelFile = modelId === 'lite' ? path.join(snapshot.dir, ASSET_PATH, 'pose_landmarker_lite.task') : await ensureModel(modelId);
  if (sha256(modelFile) !== POSE_MODELS[modelId].sha256) throw Error(`${modelFile}: wrong SHA-256`);
  return { snapshot, modelFile };
}

/** One scene, always with a fresh page and worker; callers retain ownership of shared resources. */
export async function runScene(sceneId: string, opts: RunOptions = {}, resources: SceneResources = {}): Promise<void> {
  const log = resources.quiet ? (..._args: unknown[]) => {} : console.log;
  const modelId = String(opts.model ?? 'lite'), realtime = !!opts.realtime, busyScale = Number(opts['busy-scale'] ?? 1);
  // IMAGE (a diagnostic, not what the game does): a fresh detection every frame, no strips.
  const runningMode = String(opts['running-mode'] ?? 'VIDEO');
  if (!['VIDEO', 'IMAGE'].includes(runningMode)) throw Error('--running-mode is VIDEO or IMAGE');
  const estimator = String(opts.id ?? `mp-${modelId}-game${runningMode === 'IMAGE' ? '-image' : ''}${realtime ? '-rt' : ''}`);
  const scene = loadScene(sceneId);
  const files = frameFiles(scene.dir);
  if (!files.length) throw Error(`${sceneId}: no frames`);
  const { snapshot, modelFile } = resources.prepared ?? await prepareRun(opts);

  // As WebcamPoseSource.connect (gameInit), less what the experiment flags take away.
  const players = scene.players;
  const settings = gameInit(players, opts);
  const tiles = settings.tiles ?? null;
  const init = { type: 'initialize', sessionId: 'trackbench', ...settings, modelHash: POSE_MODELS[modelId].sha256, ...(runningMode === 'IMAGE' ? { runningMode } : {}) };
  const detail = await resolveDetail(opts.detail, players);
  const resize = parseInputSize(opts['input-size']);
  const input = resize ?? { width: scene.width, height: scene.height };
  if (resize && Math.abs(resize.width / resize.height - scene.aspect) > 0.01) log(`warning: --input-size ${resize.width}x${resize.height} changes the picture's shape (${scene.width}x${scene.height})`);
  let server = resources.server, browser = resources.browser, page: Page | undefined;
  const framePrefix = resources.framePrefix ?? '/frames';
  const out = runDir(estimator, sceneId);
  try {
    server ??= await serve({ '/app': snapshot.dir, '/frames': path.join(scene.dir, 'frames'), '/models': path.dirname(modelFile) });
    browser ??= await launchGpu();
    page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', m => { logs.push(m.text()); if (m.type() === 'warning' || m.type() === 'error') log('page:', m.text()); });
    page.on('pageerror', e => log('page error:', e.message));
    await page.goto(server.origin);
    const renderer = await page.evaluate(RENDERER_PROBE);
    const ready = await page.evaluate(async ({ worker, init, modelUrl, wasmUrl, resize }) => {
      const w = new Worker(worker, { type: 'module' });
      const waiting = new Map<number, (r: unknown) => void>();
      let onReady: ((r: never) => void) | null = null, onError: ((e: Error) => void) | null = null;
      // The hand model's answers (on, or unavailable and why), with when they came.
      const handsEvents: { state: string; message?: string; at: number }[] = [];
      let onHands: ((state: string) => void) | null = null;
      w.onmessage = ({ data }) => {
        if (data.type === 'error') { onError?.(Error(data.message)); for (const r of waiting.values()) r({ error: data.message }); waiting.clear(); }
        else if (data.type === 'ready') onReady?.(data as never);
        else if (data.type === 'hands') { handsEvents.push({ state: data.state, ...(data.message ? { message: data.message } : {}), at: performance.now() }); onHands?.(data.state); }
        else if (data.type === 'result') { waiting.get(data.seq)?.(data); waiting.delete(data.seq); }
      };
      w.onerror = e => onError?.(Error(e.message));
      const grey = async (width: number, height: number) => {
        const c = new OffscreenCanvas(width, height), g = c.getContext('2d')!;
        g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
        return createImageBitmap(c);
      };
      const send = (bitmap: ImageBitmap, seq: number, timestampMs: number, players: number, lined?: boolean) => new Promise<Record<string, unknown>>(resolve => {
        waiting.set(seq, resolve as (r: unknown) => void); w.postMessage({ type: 'frame', bitmap, seq, timestampMs, players, ...(lined === undefined ? {} : { lined }) }, [bitmap]);
      });
      // --input-size: each frame scaled as a webcam asked for that size would give it.
      const decode = async (url: string) => {
        const blob = await (await fetch(url)).blob();
        return resize ? createImageBitmap(blob, { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: 'high' }) : createImageBitmap(blob);
      };
      // Keep at most one decoded frame ahead. A failed prefetch is raised when that frame is used.
      let prefetched: { url: string; result: Promise<{ bitmap: ImageBitmap; error?: never } | { error: unknown; bitmap?: never }> } | null = null;
      (globalThis as unknown as Record<string, unknown>).tb = {
        /** Warms the model up on a frame, then shows it nothing so it starts the scene following nobody. */
        /** Sends the detail message (WebcamPoseSource.sendDetail), and waits for the hand model's answer when it asks for hands. */
        async detail(message: { type: 'detail'; hands: unknown }) {
          const answered = message.hands ? new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('The hand model did not answer within 120 s')), 120000);
            onHands = state => { clearTimeout(timer); onHands = null; resolve(state); };
          }) : Promise.resolve('off');
          w.postMessage(message);
          return answered;
        },
        handsEvents: () => handsEvents,
        async warm(url: string) {
          const start = performance.now();
          const bitmap = await decode(url);
          const { width, height } = bitmap;
          await send(bitmap, -1, 0, 0);
          for (let i = 0; i < 4; i++) await send(await grey(width, height), -2 - i, 100 * (i + 1), 0);
          return performance.now() - start;
        },
        async frame(url: string, seq: number, timestampMs: number, players: number, lined: boolean | undefined, nextUrl?: string) {
          const pending = prefetched;
          prefetched = null;
          const decoded = pending?.url === url ? await pending.result : { bitmap: await decode(url) };
          if (decoded.error) throw decoded.error;
          const bitmap = decoded.bitmap!;
          const { width, height } = bitmap;
          const start = performance.now();
          const resultPromise = send(bitmap, seq, timestampMs, players, lined);
          if (nextUrl) prefetched = { url: nextUrl, result: decode(nextUrl).then(bitmap => ({ bitmap }), error => ({ error })) };
          const result = await resultPromise;
          if (result.error) throw Error(String(result.error));
          return { landmarks: result.landmarks, inferenceMs: result.inferenceMs, looks: result.looks, searched: result.searched, world: result.world, hands: result.hands, roundtripMs: performance.now() - start, width, height };
        },
      };
      return new Promise((resolve, reject) => { onReady = resolve; onError = reject; w.postMessage({ ...init, modelUrl, wasmUrl }); });
    }, { worker: `/app/assets/${snapshot.worker}`, init, modelUrl: `${server.origin}/models/${path.basename(modelFile)}`, wasmUrl: `${server.origin}/app/${ASSET_PATH}/wasm`, resize }) as { delegate: string; fallback: string; tiled?: boolean };
    log(`${estimator}/${sceneId}: renderer ${renderer}; delegate ${ready.delegate}${ready.fallback ? ` (${ready.fallback})` : ''}${tiles ? `; strips ${ready.tiled}` : ''}`);
    if (/swiftshader|llvmpipe|software/i.test(renderer) || ready.delegate !== 'GPU') {
      if (!opts['allow-cpu']) throw Error(`Not on the GPU (renderer ${renderer}, delegate ${ready.delegate}); --allow-cpu to run anyway`);
    }
    if (tiles && !ready.tiled && runningMode === 'VIDEO') throw Error('The worker could not set up its strips');
    // The detail, once the worker is ready, as WebcamPoseSource.sendDetail sends it (only when one is asked for).
    const loop = new GameLoop(players, input, { session: !opts['no-session'], danceStartMs: danceWindow(scene)?.[0] ?? Infinity, detail });
    const handModelUrl = `${server.origin}/app/${ASSET_PATH}/${HAND_MODEL.file}`;
    type Tb = { tb: { detail: (m: unknown) => Promise<string>; handsEvents: () => { state: string; message?: string; at: number }[] } };
    const sendDetail = () => page!.evaluate(m => (globalThis as unknown as Tb).tb.detail(m), detailRequest(detail, players, loop.handsWanted, handModelUrl));
    let handsState = detail ? await sendDetail() : 'off';
    if (detail) log(`${estimator}/${sceneId}: detail ${detail}; hands ${handsState}`);
    // (The first results compile the GPU programs, hundreds of ms the game spends before anybody
    // steps in; VIDEO timestamps are the frames' t_ms after the warm-up's.)
    const warmupMs = await page.evaluate(url => (globalThis as unknown as { tb: { warm: (u: string) => Promise<number> } }).tb.warm(url), `${framePrefix}/${files[0]}`);
    const frames = files.map(name => { const n = Number(name.slice(0, -4)); return { n, name, t: scene.byFrame.get(n)?.t_ms ?? (n - 1) * 1000 / scene.fps }; });
    const detections: DetFrame[] = [], tracked: TrackedFrame[] = [];
    let failure: string | null = null;
    let seq = 0, freeAt = -Infinity, next = 0, cameraDropped = 0;
    const t0 = Date.now();
    try { while (next < frames.length) {
      // Which frame goes next, and when. Offline: every frame, the moment it's taken. Realtime:
      // as WebcamPoseSource, one in flight; the newest frame that came meanwhile waits for the
      // result (replacing older ones) and goes as soon as it's in, else the next one when it comes.
      const { k, sentAt, skipped } = realtime ? nextFrame(frames, next, freeAt) : { k: next, sentAt: frames[next].t, skipped: 0 };
      cameraDropped += skipped;
      const f = frames[k];
      // (lined only with a detail: the game always sends it, but a worker without hands ignores it, and old runs had none.)
      const r = await page.evaluate(({ url, seq, t, players, lined, nextUrl }) => (globalThis as unknown as { tb: { frame: (...a: unknown[]) => Promise<unknown> } }).tb.frame(url, seq, t, players, lined, nextUrl),
        { url: `${framePrefix}/${f.name}`, seq: ++seq, t: f.t + TIMESTAMP_OFFSET_MS, players: loop.players, lined: detail ? loop.tracker.lined : undefined, nextUrl: !realtime && k + 1 < frames.length ? `${framePrefix}/${frames[k + 1].name}` : undefined }) as WorkerResult;
      if (r.width !== input.width || r.height !== input.height) throw Error(`Frame ${f.name} is ${r.width}x${r.height}, expected ${input.width}x${input.height}`);
      // --busy-ms: a fixed time per result (a slower device), instead of the measured one scaled.
      const busy = opts['busy-ms'] ? Number(opts['busy-ms']) : r.roundtripMs * busyScale;
      const received = realtime ? sentAt + busy : f.t;
      freeAt = received;
      const wasDropped = loop.handsDropped;
      const record = loop.result(f.n, r.landmarks, r.looks, f.t, received, { world: r.world, hands: r.hands });
      // Too slow for two people's hands: the game tells the worker to stop them (watchHands).
      if (loop.handsDropped && !wasDropped) { handsState = 'dropped'; await sendDetail(); log(`${estimator}/${sceneId}: hands dropped at ${received.toFixed(0)} ms (too slow)`); }
      detections.push({
        frame: f.n, t_ms: f.t, inference_ms: Number(r.inferenceMs.toFixed(3)), roundtrip_ms: Number(r.roundtripMs.toFixed(3)), ...(r.searched ? { searched: true } : {}),
        ...(realtime ? { sent_ms: sentAt, received_ms: received, ...(record.dropped ? { dropped: true } : {}) } : {}),
        people: r.landmarks.map(points => ({ kp: points.map(p => [p.x, p.y, p.z, detectedConfidence(p) ?? 0] as [number, number, number, number]), score: null })),
        ...(r.looks ? { looks: r.looks } : {}),
        ...(r.world ? { world: r.world.map(points => points.length ? points.map(p3) : null) } : {}),
        ...(r.hands ? { hands: r.hands.map(hs => hs.map(toDetHand)) } : {}),
      } as DetFrame);
      tracked.push(record);
      next = k + 1;
      if (detections.length % 100 === 0) log(`  ${detections.length} results, frame ${f.n}/${frames.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } } catch (error) {
      // Kept (with what ran before it) so a worker that dies (WebGL contexts: hands.ts) is measured, not lost.
      failure = error instanceof Error ? error.message : String(error);
    }
    const handsEvents = await page.evaluate(() => (globalThis as unknown as Tb).tb.handsEvents()).catch(() => []);
    writeJsonl(path.join(out, 'detections.jsonl'), detections);
    writeJsonl(path.join(out, 'tracked.jsonl'), tracked);
    const inf = detections.map(d => d.inference_ms!);
    writeJson(path.join(out, 'run.json'), {
      estimator, scene: sceneId, model: { id: modelId, file: path.basename(modelFile), sha256: POSE_MODELS[modelId].sha256, mediapipe: MEDIAPIPE_VERSION },
      runtime: `Chromium ${browser.version()} (${renderer}), MediaPipe ${MEDIAPIPE_VERSION} tasks-vision, ${ready.delegate} delegate${tiles ? `, ${tiles.length} strips` : ''}`,
      renderer, delegate: ready.delegate, fallback: ready.fallback, tiled: !!ready.tiled,
      dist: { snapshot: snapshot.dir, worker: snapshot.worker, commit: snapshot.commit },
      settings: { players, init: { ...init, tiles: tiles ?? null }, runningMode, timestamps: `frame t_ms + ${TIMESTAMP_OFFSET_MS}`, warmup_ms: Number(warmupMs.toFixed(1)), realtime, busyScale, session: !opts['no-session'],
        detail, detail_asked: opts.detail ?? null, input, frame_size: { width: scene.width, height: scene.height }, hands_wanted: detail ? loop.handsWanted || loop.handsDropped : false },
      hands: { state: handsState, events: handsEvents, dropped_at_ms: loop.handsDroppedAt },
      ...(failure ? { error: failure, completed: false } : { completed: true }),
      machine: { host: os.hostname(), cpu: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}` },
      frames: frames.length, results: detections.length, camera_frames_dropped: cameraDropped, results_dropped: tracked.filter(t => t.dropped).length,
      inference_ms_mean: inf.length ? Number((inf.reduce((a, b) => a + b, 0) / inf.length).toFixed(2)) : null,
      wall_s: (Date.now() - t0) / 1000, at: new Date().toISOString(),
    });
    log(`${estimator}/${sceneId}: ${detections.length} results (${cameraDropped} camera frames dropped, ${tracked.filter(t => t.dropped).length} results too old) in ${((Date.now() - t0) / 1000).toFixed(0)} s, inference ${(inf.reduce((a, b) => a + b, 0) / inf.length).toFixed(1)} ms`);
    if (failure) throw Error(`${sceneId}: failed after ${detections.length} results: ${failure}`);
  } finally {
    try { await page?.close(); }
    finally {
      try { if (!resources.browser) await browser?.close(); }
      finally { if (!resources.server) await server?.close(); }
    }
  }
}

async function main() {
  const { positional: [sceneId], opts } = parseArgs(process.argv.slice(2), RUN_GAME_FLAGS);
  if (!sceneId) { console.error('usage: node tools/trackbench/harness/run-game.ts <scene-id> [--model lite|full|heavy] [--realtime] [--id <estimator-id>] [--busy-scale k | --busy-ms N] [--strip-width W | --no-strips] [--no-search] [--no-zoom] [--no-session] [--allow-cpu] [--running-mode IMAGE] [--detail none|world|hands|hands:<side>/<side>|minigame:<id>] [--input-size WxH]'); process.exit(2); }
  await runScene(sceneId, opts);
}

if (import.meta.main) await main();
