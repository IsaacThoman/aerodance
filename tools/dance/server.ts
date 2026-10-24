// The bridge between a dance project on disk and the browser: the Studio's API and assets, and
// a headless Chromium that renders previews (contact sheets, clips) and runs pose tracking for
// the CLI. `dance studio` keeps one running (and writes .dance/server.json so CLI commands use
// it); otherwise frames/render/track start one for the command and stop it after.
//
//   GET  /api/dance                 { dance }
//   GET  /api/events                server-sent events: {"revision": n} whenever dance.json changes
//   POST /api/apply                 { ops, expectRevision?, opId?, label? } → ApplyResult (409 on a stale revision)
//   POST /api/undo, /api/redo       { expectRevision? }
//   GET  /api/history               the undo and redo stacks
//   GET  /api/media/video|proxy|audio   the source files (with range requests)
//   GET  /api/frame?t=&w=           the video frame at song time t (ms) as JPEG, w pixels wide
//   GET  /api/tracking/:id          a tracking .adpose
//   GET  /api/check, /api/score     review findings, and the scorer against the tracked video
//   POST /api/export                { install? } → the song bundle (ZIP under .dance/exports)
//   POST /api/render                a RenderSpec (studio/renderSpec.ts) → PNG, for CLI previews
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { existsSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { checkDance } from './check.ts';
import { createEvaluator } from './evaluate.ts';
import { aspectOf, findDancer } from './format.ts';
import type { Dance } from './format.ts';
import { decodeFrames, grabFrame, encodeClip } from './media.ts';
import { DanceProject, RevisionConflict } from './project.ts';
import { scoreAgainstTracking } from './score.ts';
import { formatTime, parseRange, parseTime, songToVideo } from './time.ts';
import { assignSlots, encodeTracking } from './tracking.ts';
import type { TrackedFrame } from './tracking.ts';
import type { Landmark } from '../../packages/pose/choreography.ts';
import type { Tile } from '../../packages/pose/browser/tiles.ts';
import type { RenderSpec, View } from './studio/renderSpec.ts';
import { VIEWS } from './studio/renderSpec.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STUDIO = path.join(ROOT, 'studio');
const DIST = path.join(ROOT, 'dist');

type Values = Record<string, string | boolean | string[] | undefined>;
export interface BridgeOptions { port?: number; host?: string; dist?: boolean; quiet?: boolean; }
interface ServerInfo { pid: number; port: number; url: string; }

export class Bridge {
  readonly project: DanceProject;
  readonly url: string;
  private server: http.Server;
  private closers: (() => Promise<void> | void)[] = [];
  private browser: Browser | null = null;
  private page: Promise<Page> | null = null;
  private constructor(project: DanceProject, server: http.Server, url: string) { this.project = project; this.server = server; this.url = url; }

  static async start(project: DanceProject, { port = 0, host = '127.0.0.1', dist = false, quiet = true }: BridgeOptions = {}): Promise<Bridge> {
    const app = express();
    const server = http.createServer(app);
    // Only pages served from this machine's own address may use it: a site that rebinds its
    // name to 127.0.0.1 would otherwise reach the project through the browser.
    app.use((req, res, next) => {
      const name = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (['127.0.0.1', 'localhost', '::1', host].includes(name)) { next(); return; }
      res.status(403).end('Forbidden host');
    });
    const clients = new Set<Response>();
    let revision = (await project.read()).revision;
    const broadcast = (data: unknown) => { for (const c of clients) c.write(`data: ${JSON.stringify(data)}\n\n`); };
    // dance.json is replaced by rename, so watch its folder.
    let timer: NodeJS.Timeout | null = null;
    const watcher: FSWatcher = watch(project.dir, (_, name) => {
      if (name !== 'dance.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const next = (await project.read()).revision;
          if (next !== revision) { revision = next; broadcast({ revision }); }
        } catch { /* mid-write or invalid: the next change reports it */ }
      }, 40);
    });
    const api = express.Router();
    api.use(express.json({ limit: '20mb' }));
    const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).then(body => { if (body !== undefined && !res.headersSent) res.json(body); }).catch((e: unknown) => {
        if (e instanceof RevisionConflict) { res.status(409).json({ error: e.message, currentRevision: e.current }); return; }
        if (!res.headersSent) res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        else next(e);
      });
    };
    api.get('/ping', (_req, res) => { res.json({ ok: true, dir: project.dir, pid: process.pid }); });
    api.get('/dance', handle(async req => {
      if (req.query.revision === undefined) return { dance: await project.read() };
      return { dance: await project.revisionAt(Number(req.query.revision)) };
    }));
    api.get('/events', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ revision })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    });
    api.post('/apply', handle(async req => {
      const result = await project.apply(req.body);
      revision = result.revision; broadcast({ revision });
      return result;
    }));
    for (const step of ['undo', 'redo'] as const) api.post(`/${step}`, handle(async req => {
      const result = await project.step(step, req.body?.expectRevision);
      if (result) { revision = result.revision; broadcast({ revision }); }
      return { result };
    }));
    api.get('/history', handle(() => project.log()));
    api.get('/media/:kind', handle(async (req, res) => {
      const dance = await project.read();
      const kind = req.params.kind;
      const ref = kind === 'audio' ? dance.sources.audio?.path : kind === 'proxy' ? dance.sources.video?.proxy ?? dance.sources.video?.path
        : kind === 'video' ? dance.sources.video?.path : undefined;
      if (!ref) { res.status(404).json({ error: `No ${kind}` }); return; }
      await new Promise<void>((resolve, reject) => res.sendFile(project.resolve(ref), { dotfiles: 'allow' }, e => e ? reject(e) : resolve()));
    }));
    api.get('/frame', handle(async (req, res) => {
      const dance = await project.read(), video = dance.sources.video;
      if (!video) { res.status(404).json({ error: 'No video' }); return; }
      const t = parseTime(String(req.query.t ?? '0'), dance), width = req.query.w ? Math.min(4096, Number(req.query.w)) : undefined;
      const videoMs = Math.max(0, Math.min(video.durationMs - 1, songToVideo(dance, t)));
      const cache = project.meta('cache', 'frames', video.sha256.slice(0, 16), `${Math.round(videoMs * 10)}-${width ?? 'full'}.jpg`);
      let jpeg: Buffer;
      if (existsSync(cache)) jpeg = await readFile(cache);
      else {
        jpeg = await grabFrame(project.resolve(video.path), videoMs, { width });
        await mkdir(path.dirname(cache), { recursive: true });
        await writeFile(cache, jpeg);
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'max-age=3600');
      res.end(jpeg);
    }));
    api.get('/tracking/:id', handle(async (req, res) => {
      const dance = await project.read(), source = dance.sources.tracking.find(t => t.id === req.params.id);
      if (!source) { res.status(404).json({ error: 'No such tracking' }); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(await readFile(project.resolve(source.path)));
    }));
    api.get('/check', handle(async () => {
      const dance = await project.read();
      await project.loadTracking(dance);
      const tracking = new Map(await Promise.all(dance.sources.tracking.map(async t => [t.id, await project.tracking(t.id, dance)] as const)));
      return { revision: dance.revision, findings: checkDance(dance, { tracking: id => tracking.get(id) ?? null }) };
    }));
    api.get('/score', handle(async () => {
      const dance = await project.read();
      const tracking = new Map(await Promise.all(dance.sources.tracking.map(async t => [t.id, await project.tracking(t.id, dance)] as const)));
      return { revision: dance.revision, scores: scoreAgainstTracking(dance, id => tracking.get(id)!) };
    }));
    api.post('/export', handle(async req => {
      const { songBundle, bundleZip, installBundle } = await import('./bundle.ts');
      const dance = await project.read(), bundle = await songBundle(project, dance);
      const zip = project.meta('exports', `${bundle.songId}-r${bundle.song.bundleRevision}.aerodance-song.zip`);
      await mkdir(path.dirname(zip), { recursive: true });
      await writeFile(zip, bundleZip(bundle));
      const installed = req.body?.install ? await installBundle(bundle) : null;
      return { songId: bundle.songId, revision: bundle.song.bundleRevision, zip, installed, stats: bundle.compiled.stats };
    }));
    api.get('/export/:file', handle(async (req, res) => {
      const file = project.meta('exports', path.basename(String(req.params.file)));
      await new Promise<void>((resolve, reject) => res.download(file, path.basename(file), { dotfiles: 'allow' }, e => e ? reject(e) : resolve()));
    }));
    let self: Bridge | null = null;
    api.post('/render', handle(async (req, res) => {
      if (!self) throw Error('The bridge is starting');
      res.type('png').end(await self.render(req.body as RenderSpec));
    }));
    app.use('/api', api);

    let closeAssets: () => Promise<void> = async () => {};
    if (dist) {
      if (!existsSync(path.join(DIST, 'index.html'))) throw Error('No Studio build; run `npm run dance:build` or drop --dist');
      app.use(express.static(DIST, { dotfiles: 'allow' }));
    } else {
      const vite = await import('vite');
      const dev = await vite.createServer({
        configFile: path.join(ROOT, 'vite.config.ts'), logLevel: quiet ? 'error' : 'info',
        server: { middlewareMode: true, ws: { server } }, appType: 'mpa',
      });
      app.use(dev.middlewares);
      closeAssets = () => dev.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    const address = server.address() as AddressInfo;
    const bridge = new Bridge(project, server, `http://${host}:${address.port}/`);
    self = bridge;
    bridge.closers.push(() => watcher.close(), () => { for (const c of clients) c.end(); }, closeAssets);
    return bridge;
  }

  /** The headless page that renders and tracks, opened on first use and kept. */
  private async renderPage(): Promise<Page> {
    this.page ??= (async () => {
      const { chromium } = await import('playwright');
      const { chromiumPath, gpuFlags } = await import('../../scripts/chromium.ts');
      this.browser = await chromium.launch({ headless: true, executablePath: chromiumPath(false), args: gpuFlags() });
      const page = await this.browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(120000);
      page.on('pageerror', e => process.stderr.write(`[render page] ${e.message}\n`));
      // MediaPipe reports its progress through console.error ("INFO: …"); only real errors matter.
      page.on('console', m => { if (m.type() === 'error' && !/^(INFO|I\d{4}|W\d{4}):?\s/.test(m.text())) process.stderr.write(`[render page] ${m.text()}\n`); });
      await page.goto(new URL('render.html', this.url).href);
      await page.waitForFunction(() => 'danceRender' in window, null, { timeout: 120000 });
      return page;
    })();
    return this.page;
  }
  /** A contact sheet or clip frame as PNG bytes. */
  async render(spec: RenderSpec): Promise<Buffer> {
    const page = await this.renderPage();
    const base64 = await page.evaluate(s => (window as unknown as { danceRender: { render(s: RenderSpec): Promise<string> } }).danceRender.render(s), spec);
    return Buffer.from(base64, 'base64');
  }
  /** Detects people in video frames (RGBA, w×h) with MediaPipe Lite, numPoses at most; tiles give each a strip. */
  async detect(frames: { width: number; height: number; rgba: Buffer; timestampMs: number }[], numPoses: number, tiles: Tile[] | null = null): Promise<Landmark[][][]> {
    const page = await this.renderPage();
    return page.evaluate(async ({ frames, numPoses, tiles }) => {
      const r = (window as unknown as { danceRender: { detect(f: unknown, n: number, t: Tile[] | null): Promise<Landmark[][][]> } }).danceRender;
      return r.detect(frames, numPoses, tiles);
    }, { frames: frames.map(f => ({ width: f.width, height: f.height, timestampMs: f.timestampMs, rgba: f.rgba.toString('base64') })), numPoses, tiles });
  }
  async close() {
    await this.browser?.close().catch(() => {});
    for (const close of this.closers.reverse()) await close();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }
}

// ---- CLI commands that need the browser ----

async function runningBridge(project: DanceProject): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(project.meta('server.json'), 'utf8')) as ServerInfo;
    const response = await fetch(new URL('api/ping', info.url), { signal: AbortSignal.timeout(1500) });
    const body = await response.json() as { dir?: string };
    return body.dir === project.dir ? info.url : null;
  } catch { return null; }
}
/** Renders through a running `dance studio`, or a temporary bridge. */
async function withRenderer<T>(project: DanceProject, fn: (r: { render(spec: RenderSpec): Promise<Buffer>; bridge: Bridge | null }) => Promise<T>): Promise<T> {
  const url = await runningBridge(project);
  if (url) {
    return fn({
      bridge: null,
      async render(spec) {
        const response = await fetch(new URL('api/render', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
        if (!response.ok) throw Error(((await response.json()) as { error: string }).error);
        return Buffer.from(await response.arrayBuffer());
      },
    });
  }
  const bridge = await Bridge.start(project);
  try { return await fn({ bridge, render: spec => bridge.render(spec) }); }
  finally { await bridge.close(); }
}
/** The crop a --zoom names, in frame coordinates. */
export function zoomRect(dance: Dance, zoom: string | undefined, times: number[]): RenderSpec['zoom'] {
  if (!zoom || zoom === 'body' || zoom === 'frame') return null;
  const numbers = zoom.split(',').map(Number);
  if (numbers.length === 4 && numbers.every(Number.isFinite)) return { x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3] };
  const [who, part = 'body'] = zoom.split(':');
  const dancer = findDancer(dance, who);
  const e = createEvaluator(dance, dancer);
  const parts: Record<string, string[]> = { body: ['head', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle', 'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee'],
    hands: ['leftWrist', 'rightWrist', 'leftElbow', 'rightElbow'], feet: ['leftAnkle', 'rightAnkle', 'leftKnee', 'rightKnee'], head: ['head', 'leftShoulder', 'rightShoulder'],
    arms: ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist'], legs: ['leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'] };
  const names = parts[part] ?? (() => { throw Error(`--zoom ${who}:${part}: use body, hands, feet, head, arms or legs`); })();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of times) {
    const rig = e.rig(t);
    for (const n of names) {
      const p = rig.points[n as keyof typeof rig.points];
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
  }
  const aspect = aspectOf(dance), pad = part === 'body' ? 0.08 : 0.06;
  // Square-ish in pixels, with room around the joints.
  let h = Math.max(y1 - y0 + pad * 2, (x1 - x0) * aspect + pad * 2, 0.15), w = h / aspect;
  if (part === 'body') { h = Math.min(1, h * 1.1); w = Math.min(1, h / aspect * 1.2); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x: Math.min(Math.max(0, cx - w / 2), 1 - Math.min(1, w)), y: Math.min(Math.max(0, cy - h / 2), 1 - Math.min(1, h)), w: Math.min(1, w), h: Math.min(1, h) };
}

function viewsOf(values: Values): View[] {
  const list = (typeof values.views === 'string' ? values.views : 'overlay,character').split(',').map(v => v.trim());
  for (const v of list) if (!(VIEWS as readonly string[]).includes(v)) throw Error(`--views: ${v} isn't one of ${VIEWS.join(', ')}`);
  return list as View[];
}
const str = (values: Values, name: string) => typeof values[name] === 'string' ? values[name] as string : undefined;

export async function runBrowserCommand(command: string, project: DanceProject, dance: Dance, values: Values, json: boolean): Promise<number> {
  const out = (v: unknown) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');
  if (command === 'studio') return studio(project, values, json);
  if (command === 'track') return track(project, dance, values, json, out);
  const dancers = str(values, 'dancer') ? str(values, 'dancer')!.split(',').map(d => findDancer(dance, d).id) : null;
  if (command === 'frames') {
    let times: number[];
    if (str(values, 'at')) times = str(values, 'at')!.split(',').map(t => parseTime(t, dance));
    else if (str(values, 'range')) {
      const [a, b] = parseRange(str(values, 'range'), dance), every = str(values, 'every') ? parseTime(str(values, 'every'), dance) : 250;
      times = [];
      for (let t = a; t <= b + 1e-6 && times.length < 48; t += every) times.push(Math.round(t * 10) / 10);
    } else throw Error('frames needs --at t1,t2,… or --range a:b');
    if (times.length > 48) throw Error('At most 48 frames per sheet');
    const spec: RenderSpec = {
      revision: dance.revision, times, views: viewsOf(values), dancers, focus: dancers?.[0] ?? null,
      zoom: zoomRect(dance, str(values, 'zoom'), times), cellWidth: str(values, 'width') ? Number(str(values, 'width')) : 360,
      reference: values.reference === true, ghosts: values.ghosts === true, mirror: values.mirror === true, labels: true, grid: values.grid === true,
      trails: str(values, 'trails') ? parseTime(str(values, 'trails'), dance) : values.trails === true ? 300 : 0,
      before: str(values, 'before') ? Number(str(values, 'before')) : null,
      title: `${dance.song.title || 'dance'} r${dance.revision}  ${formatTime(times[0], dance)}–${formatTime(times[times.length - 1], dance)}`,
    };
    const file = str(values, 'out') ?? project.meta('renders', `frames-r${dance.revision}-${Math.round(times[0])}-${Math.round(times[times.length - 1])}.png`);
    const png = await withRenderer(project, r => r.render(spec));
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, png);
    out(json ? { file: path.resolve(file), times } : path.resolve(file));
    return 0;
  }
  if (command === 'render') {
    const [a, b] = parseRange(str(values, 'range') ?? (() => { throw Error('render needs --range a:b'); })(), dance);
    const fps = str(values, 'fps') ? Number(str(values, 'fps')) : 30;
    const file = path.resolve(str(values, 'out') ?? project.meta('renders', `clip-r${dance.revision}-${Math.round(a)}-${Math.round(b)}.mp4`));
    const views = viewsOf(values), times: number[] = [];
    for (let t = a; t < b; t += 1000 / fps) times.push(t);
    if (times.length > 30 * 120) throw Error('Clips are limited to two minutes');
    const zoom = zoomRect(dance, str(values, 'zoom'), times.filter((_, i) => i % 10 === 0));
    await withRenderer(project, async r => {
      async function* frames() {
        for (const t of times) yield await r.render({ revision: dance.revision, times: [t], views, dancers, focus: dancers?.[0] ?? null, zoom,
          cellWidth: str(values, 'width') ? Number(str(values, 'width')) : 480, reference: values.reference === true, ghosts: false,
          mirror: values.mirror === true, labels: false, title: formatTime(t, dance) });
      }
      const audio = values['no-audio'] || !dance.sources.audio ? null : project.resolve(dance.sources.audio.path);
      await encodeClip(frames(), file, { fps, audio, audioStartMs: a, durationMs: b - a });
    });
    out(json ? { file, frames: times.length } : file);
    return 0;
  }
  throw Error(`Unknown command ${command}`);
}

async function studio(project: DanceProject, values: Values, json: boolean): Promise<number> {
  const existing = await runningBridge(project);
  if (existing) throw Error(`The Studio is already running for this project at ${existing}`);
  const bridge = await Bridge.start(project, { port: str(values, 'port') ? Number(str(values, 'port')) : 5310, dist: values.dist === true, quiet: true })
    .catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE' || str(values, 'port')) throw e;
      return Bridge.start(project, { port: 0, dist: values.dist === true });
    });
  // Renders requested by CLI commands while the Studio runs.
  const info: ServerInfo = { pid: process.pid, port: Number(new URL(bridge.url).port), url: bridge.url };
  await writeFile(project.meta('server.json'), JSON.stringify(info) + '\n');
  process.stdout.write(json ? JSON.stringify(info) + '\n' : `Studio: ${bridge.url}\nCLI previews use this session. Ctrl-C stops it.\n`);
  if (values.open) (await import('node:child_process')).spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [bridge.url], { stdio: 'ignore', detached: true }).unref();
  await new Promise<void>(resolve => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve());
  });
  await rm(project.meta('server.json'), { force: true });
  await bridge.close();
  return 0;
}

async function track(project: DanceProject, dance: Dance, values: Values, json: boolean, out: (v: unknown) => void): Promise<number> {
  const video = dance.sources.video;
  if (!video) throw Error('This dance has no video to track');
  const fps = str(values, 'fps') ? Number(str(values, 'fps')) : 15;
  if (!(fps > 0 && fps <= 30)) throw Error('--fps must be 1 to 30');
  const [startMs, endMs] = str(values, 'range') ? parseRange(str(values, 'range'), dance).map(t => songToVideo(dance, t)) : [0, video.durationMs];
  const slots = dance.dancers.length;
  // MediaPipe looks at a 256-pixel square; 640 wide keeps the detail without a heavy transfer.
  // Several dancers each get a strip of the picture centred on where they stand (their home).
  const width = Math.min(1280, video.width), height = Math.round(width * video.height / video.width / 2) * 2;
  const stripWidth = Math.min(0.55, Math.max(0.3, 1.4 / slots));
  const tiles: Tile[] | null = slots > 1 && values['no-strips'] !== true
    ? dance.dancers.map(d => ({ x: Math.min(1 - stripWidth, Math.max(0, d.home[0] - stripWidth / 2)), width: stripWidth })) : null;
  const detections: { videoMs: number; poses: Landmark[][] }[] = [];
  const log = (m: string) => { if (!json) process.stderr.write(m); };
  // Tracking runs in a bridge of its own, even while the Studio runs: it holds the GPU for a while.
  const bridge = await Bridge.start(project);
  try {
    let batch: { width: number; height: number; rgba: Buffer; timestampMs: number }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const results = await bridge.detect(batch, Math.min(4, slots + 1), tiles);
      results.forEach((poses, i) => detections.push({ videoMs: batch[i].timestampMs, poses }));
      log(`\rTracked ${detections.length} frames (${formatTime(batch[batch.length - 1].timestampMs)})`);
      batch = [];
    };
    await decodeFrames(project.resolve(video.path), { startMs, endMs, fps, width, height }, async (index, rgba) => {
      batch.push({ width, height, rgba, timestampMs: Math.round((startMs + index * 1000 / fps) * 10) / 10 });
      if (batch.length >= 8) await flush();
    });
    await flush();
    log('\n');
  } finally { await bridge.close(); }
  const aspect = aspectOf(dance);
  const frames: TrackedFrame[] = assignSlots(detections, slots, aspect, { starts: dance.dancers.map(d => d.home) });
  const found = frames.map(f => f.poses.filter(Boolean).length);
  const id = `t${dance.sources.tracking.length + 1}`;
  const bytes = encodeTracking(frames, { width: video.width, height: video.height, slots,
    provenance: { tool: 'dance track', model: 'lite', fps, videoSha256: video.sha256, rangeMs: [startMs, endMs], createdAt: new Date().toISOString() } });
  const rel = `sources/tracking-${id}.adpose`;
  await writeFile(path.join(project.dir, rel), bytes);
  const { sha256 } = await import('../../packages/pose/song.ts');
  const current = await project.read();
  const next = structuredClone(current);
  next.sources.tracking.push({ id, path: rel, sha256: await sha256(bytes), bytes: bytes.length, mimeType: 'application/octet-stream', model: 'lite',
    createdAt: new Date().toISOString(), fps, dancers: current.dancers.map(d => d.id) });
  const saved = await project.replace(next, `track ${id}`);
  const coverage = current.dancers.map((d, slot) => `${d.id} ${Math.round(100 * frames.filter(f => f.poses[slot]).length / Math.max(1, frames.length))}%`);
  out(json ? { id, path: rel, frames: frames.length, revision: saved.revision, detectionsPerFrame: found }
    : `Tracking ${id}: ${frames.length} frames at ${fps} fps → ${rel} (revision ${saved.revision}); found ${coverage.join(', ')}`);
  return 0;
}
export { STUDIO };
