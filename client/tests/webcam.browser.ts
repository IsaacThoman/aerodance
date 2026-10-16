// Real bundled MediaPipe in a worker, with a local synthetic camera stream.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { createStudio } from '../../tools/choreography/server/index.ts';
import { PILL, PRIMARY, MODEL_RECTS } from '../src/connect/layout.ts';
import { BACK as MENU_BACK, SETTINGS, START, TWO_PLAYERS } from '../src/menu/layout.ts';
import { BACK, rowRect } from '../src/game/layout.ts';
import type { Rect } from '../src/ui/draw.ts';
import { appendOperation, trackDataIds, validateProject, validateTake, validateTrackData } from '../../tools/choreography/core.ts';
import type { ProjectSummary, ProjectV2, StudioAssets, Take } from '../../tools/choreography/core.ts';
import { readZip } from '../../tools/choreography/server/zip.ts';
import { validateSong, validateSongChoreography } from '../../packages/pose/song.ts';
import type { Page } from 'playwright';

/** What the page script adds to window: the synthetic camera's controls and counters. */
type TestWindow = typeof window & {
  cameraRequests: number; cameraStops: number; cameraMode: 'normal' | 'denied'; cameraViewScale: number;
  poseDiagnostics?: unknown;
};

const dataDir = await mkdtemp(path.join(tmpdir(), 'webcam-studio-'));
const apps = [express(), express()];
for (const app of apps) app.get('/pose-fixture.jpg', (_req, res) => res.sendFile(path.resolve('client/tests/fixtures/mediapipe-pose.jpg')));
apps[0].use(express.static('dist'));
apps[1].use(createStudio({ dataDir }).app);
const servers = apps.map((app, i) => app.listen(4180 + i, '127.0.0.1'));
await Promise.all(servers.map(server => new Promise(resolve => server.once('listening', resolve))));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
async function pageFor(port: number) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(60000); page.on('pageerror', error => {
    if (errors.length < 2) console.error('Browser error:', error.stack);
    errors.push(error.message);
  });
  await page.addInitScript(() => {
    // Keep the main app responsive in software-only CI. MediaPipe's worker has
    // separate WebGL prototypes and still performs real model inference.
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'])
        if (Reflect.get(Type.prototype, name)) Reflect.set(Type.prototype, name, () => {});
    }
    const w = window as TestWindow;
    w.cameraRequests = 0; w.cameraStops = 0; w.cameraMode = 'normal'; w.cameraViewScale=1;
    const NativeWorker = Worker;
    w.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', ({ data }: MessageEvent<{ type: string; landmarks?: unknown[][] }>) => {
          if (data.type === 'result') w.poseDiagnostics = data.landmarks?.map(points => [11, 12, 23, 24].map(i => points[i]));
        });
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fixture-camera', label: 'Fixture camera' }],
      getUserMedia: async () => {
        w.cameraRequests++;
        if (w.cameraMode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
        const image = new Image(); image.src = '/pose-fixture.jpg'; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const g = canvas.getContext('2d'); let count = 0;
        if (!g) throw Error('2D canvas unavailable');
        const draw = () => {
          g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480);
          const offset = Math.sin(count++ / 20) * 2;
          g.save(); g.translate(320,240); g.scale(w.cameraViewScale,w.cameraViewScale); g.translate(-320,-240);
          g.drawImage(image, 200, 0, 600, 667, offset, 40, 320, 356);
          g.drawImage(image, 200, 0, 600, 667, 320 + offset, 40, 320, 356);
          g.restore();
        };
        draw(); const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { clearInterval(timer); w.cameraStops++; stop(); };
        }
        return stream;
      },
    } });
  });
  await page.goto(`http://127.0.0.1:${port}`); return page;
}
let game: Page | undefined, studio: Page | undefined;
try {
  const gamePage = game = await pageFor(4180);
  // A layout rect, or a circle (clicked at its centre).
  const click = async (rect: Rect | { x: number; y: number }) => {
    const frame = await gamePage.locator('.canvas-frame').boundingBox();
    assert.ok(frame, 'the canvas frame is laid out');
    const [w, h] = 'w' in rect ? [rect.w, rect.h] : [0, 0];
    await gamePage.mouse.click(frame.x + (rect.x + w / 2) / 1600 * frame.width,
      frame.y + (rect.y + h / 2) / 900 * frame.height);
  };
  const until = (key: string, value: string) => gamePage.waitForFunction(([key, value]) => document.querySelector('canvas')?.dataset[key] === value, [key, value]);
  await until('menuReady', 'true'); await click(SETTINGS); await until('menuScreen', 'settings'); await until('menuReady', 'true'); await click(PILL); await until('connectReady', 'true');
  assert.equal(await game.evaluate(() => (window as TestWindow).cameraRequests), 0, 'opening Connect Client does not request permission');
  await game.evaluate(() => { (window as TestWindow).cameraMode = 'denied'; }); await click(PRIMARY); await until('connectStatus', 'error');
  assert.match(await game.locator('canvas').getAttribute('data-connect-message') ?? '', /permission was denied/);
  await game.evaluate(() => { (window as TestWindow).cameraMode = 'normal'; }); await click(PRIMARY);
  await until('connectStatus', 'connected');
  for (const [index, model] of ['lite', 'full', 'heavy'].entries()) {
    await click(MODEL_RECTS[index]); await until('connectModel', model); await until('connectStatus', 'connected');
    console.log(`Game actual MediaPipe ${model}:`, await game.locator('canvas').getAttribute('data-connect-message'));
  }
  await click(MODEL_RECTS[0]); await until('connectStatus', 'connected');
  await game.keyboard.press('Escape'); await until('connectOpen', 'false');
  await click(MENU_BACK); await until('menuScreen', 'main'); await until('menuReady', 'true');
  await click(START); await until('menuScreen', 'players'); await until('menuReady', 'true');
  await click(TWO_PLAYERS); await until('playerSlots', 'Detected|Detected');
  await click(BACK); await until('menuScreen', 'players'); await until('menuReady', 'true');
  await click(MENU_BACK); await until('menuScreen', 'main'); await until('menuReady', 'true');
  await click(SETTINGS); await until('menuScreen', 'settings'); await until('menuReady', 'true');
  await click(PILL); await until('connectReady', 'true'); await click(PRIMARY); await until('connectStatus', 'disconnected');
  assert.ok(await game.evaluate(() => (window as TestWindow).cameraStops >= 4), 'switches and Stop release camera tracks');

  studio = await pageFor(4181);
  await studio.getByRole('heading', { name: 'Make every move yours.' }).waitFor();
  assert.equal(await studio.evaluate(() => (window as TestWindow).cameraRequests), 0);
  // Keep Studio capture responsive in software rendering; all three models were exercised above.
  await studio.getByLabel('Webcam pose model').selectOption('lite');
  await studio.getByRole('button', { name: 'Start camera', exact: true }).click();
  await studio.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await studio.getByText('P1 detected', { exact: false }).waitFor();
  await studio.getByText('P2 detected', { exact: false }).waitFor();
  // Calibration needs a run of tracked frames, which arrive slowly with CPU-only inference.
  await studio.getByText('Body calibration ready', { exact: false }).waitFor({ timeout: 180_000 });
  await studio.evaluate(() => { (window as TestWindow).cameraViewScale=.65; });
  await studio.waitForTimeout(700);
  await studio.getByText('P1 detected', { exact: false }).waitFor();
  await studio.getByText('P2 detected', { exact: false }).waitFor();
  await studio.getByRole('button', { name: 'Recalibrate body', exact: true }).click();
  await studio.getByText('Body calibration ready', { exact: false }).waitFor({ timeout: 180_000 });
  await studio.getByRole('button', { name: 'Live view', exact: true }).click();
  assert.equal(await studio.getByRole('button', { name: 'Live view', exact: true }).getAttribute('aria-pressed'), 'true');
  // Real decoded audio, then pose capture through the production batch/finalize API.
  const wav = Buffer.alloc(44 + 16000 * 2 * 5);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await studio.getByLabel('Import song audio').setInputFiles({ name: 'webcam.wav', mimeType: 'audio/wav', buffer: wav });
  await studio.getByText(/Audio imported/).waitFor();
  await studio.getByLabel('Recording delay (seconds)').fill('0');
  await studio.getByRole('button', { name: 'Record new take', exact: false }).click();
  await studio.getByRole('button', { name: 'Stop recording', exact: false }).waitFor();
  assert.equal(await studio.getByLabel('Webcam pose model').isDisabled(), true);
  assert.equal(await studio.getByRole('button', { name: 'Recalibrate body', exact: true }).isDisabled(), true);
  await studio.getByText(/records captured/).waitFor();
  await studio.waitForTimeout(1700);
  await studio.getByRole('button', { name: 'Stop recording', exact: false }).click();
  let persisted = false;
  for (let attempt = 0; attempt < 100 && !persisted; attempt++) {
    persisted = await studio.evaluate(async () => {
      const projects: ProjectSummary[] = await (await fetch('/api/projects')).json();
      const project: ProjectV2 = await (await fetch(`/api/projects/${projects[0].projectId}`)).json();
      return project.takes.some(take => take.source === 'webcam');
    });
    if (!persisted) await studio.waitForTimeout(100);
  }
  assert.ok(persisted, 'recorded webcam take was finalized and saved');
  const take: Take = validateTake(await studio.evaluate(async (): Promise<unknown> => {
    const projects: ProjectSummary[] = await (await fetch('/api/projects')).json();
    const project: ProjectV2 = await (await fetch(`/api/projects/${projects[0].projectId}`)).json();
    return (await fetch(`/api/projects/${project.projectId}/takes/${project.takes[project.takes.length - 1].takeId}`)).json();
  }));
  assert.equal(take.source, 'webcam'); assert.equal(take.provenance?.modelId, 'lite');
  assert.equal(take.provenance?.alignmentMethod, 'browser-frame-audio-anchor');
  assert.ok(take.samples.length > 5); assert.ok(take.samples.some(s => s.poses.length === 2));
  const lastSample = take.samples[take.samples.length - 1];
  // A recorded take stays in the library until explicitly assigned to the dance tracks.
  await studio.getByLabel('Take actions:', { exact: false }).last().click();
  await studio.getByRole('menuitem', { name: 'Overwrite both tracks', exact: true }).last().click();
  await studio.getByRole('button', { name: 'Save', exact: true }).click();
  await studio.locator('.save-state').filter({ hasText: /^Saved$/ }).waitFor();
  await studio.waitForFunction(async () => {
    const projects: ProjectSummary[] = await (await fetch('/api/projects')).json();
    const p: ProjectV2 = await (await fetch(`/api/projects/${projects[0].projectId}`)).json();
    return p.tracks.every(track => track.dataId);
  });
  const exported = await (async () => {
    const json = async (url: string, options?: RequestInit): Promise<unknown> => {
      const response = await fetch(`http://127.0.0.1:4181${url}`, options);
      if (!response.ok) throw Error(await response.text());
      return response.json();
    };
    const write = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // Saved projects are always the current format.
    const project = (data: unknown): ProjectV2 => {
      const loaded = validateProject(data);
      assert.equal(loaded.schemaVersion, 2);
      return loaded;
    };
    const projects = await json('/api/projects');
    assert.ok(Array.isArray(projects) && projects.length);
    const summary: ProjectSummary = projects[0];
    let p = project(await json(`/api/projects/${summary.projectId}`));
    const projectId = p.projectId;
    const assets: StudioAssets = new Map(await Promise.all(trackDataIds(p).map(async (id) => [id, validateTrackData(await json(`/api/projects/${projectId}/tracks/${id}`))] as const)));
    const existing = new Set(assets.keys());
    p.metadata.artist = 'Browser fixture'; p.metadata.title = 'Webcam fixture';
    p.metadata.rights.audio.license = 'test-fixture'; p.metadata.rights.choreography.license = 'test-fixture';
    p.playableStartMs = take.offsetMs;
    p.playableEndMs = take.offsetMs + lastSample.takeTimeMs * take.timeScale;
    p.alignmentReviewed = true;
    p = project(await json(`/api/projects/${p.projectId}`, write(p)));
    // Software CI can miss >200 ms intervals. Apply the production track review
    // operation, which records v2 track snapshots and history alongside exclusions.
    for (let i = 0; i < take.samples.length - 1; i++) {
      const sample = take.samples[i], next = take.samples[i + 1];
      const gap = next.takeTimeMs - sample.takeTimeMs;
      for (const playerId of [0, 1]) if (gap > 200 ||
        !sample.poses.some(pose => pose.playerId === playerId) ||
        !next.poses.some(pose => pose.playerId === playerId)) {
        // Review the entire capture gap, including its observed endpoints, so
        // exclusion coverage is independent of the compiler's resampling grid.
        p = appendOperation(p, { type: 'exclude', playerId,
          startMs: take.offsetMs + sample.takeTimeMs * take.timeScale,
          endMs: take.offsetMs + next.takeTimeMs * take.timeScale,
          reason: 'Reviewed gap in software browser fixture' }, assets);
      }
    }
    // The known static fixture's observed poses are explicitly reviewed; missing
    // spans remain excluded and approval never creates poses in those gaps.
    p = appendOperation(p, { type: 'approve', playerId: null,
      startMs: p.playableStartMs, endMs: p.playableEndMs, reason: 'Reviewed observed poses in the static browser fixture' }, assets);
    for (const id of trackDataIds(p)) if (!existing.has(id)) {
      await json(`/api/projects/${p.projectId}/tracks`, { ...write(assets.get(id)), method: 'POST' });
    }
    p = project(await json(`/api/projects/${p.projectId}`, write(p)));
    const response = await fetch(`http://127.0.0.1:4181/api/projects/${p.projectId}/export`);
    if (!response.ok) throw Error(await response.text());
    return { songId: p.songId, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  })();
  const bundle = readZip(Buffer.from(exported.bytes));
  const zipJson = (name: string): unknown => {
    const file = bundle.get(`${exported.songId}/${name}`);
    assert.ok(file, `exported ${name}`);
    return JSON.parse(file.toString('utf8'));
  };
  const song = validateSong(zipJson('song.json'));
  const exportedMotion=validateSongChoreography(song, zipJson('choreography.json'));
  assert.equal(exportedMotion.tracks[0].calibration.cameraScaleMode,'body-relative');
  assert.equal(exportedMotion.tracks[0].calibration.profileVersion,2);
  apps[0].use('/songs/webcam-capture', (req, res) => {
    const file = bundle.get(`${exported.songId}${req.path}`);
    if (!file) return res.sendStatus(404);
    res.type(path.extname(req.path)).send(file);
  });
  await game.route('**/songs/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 1, songs: [{
    id: song.songId, title: song.title, artist: song.artist, durationMs: song.durationMs, difficulty: song.difficulty,
    supportedPlayerCounts: [1, 2], bundleRevision: song.bundleRevision, bundle: 'webcam-capture/song.json',
  }] }) }));
  await game.keyboard.press('Escape'); await until('connectOpen', 'false');
  await click(MENU_BACK); await until('menuScreen', 'main'); await until('menuReady', 'true');
  await click(START); await until('menuScreen', 'players'); await until('menuReady', 'true');
  await click(TWO_PLAYERS); await until('songReady', 'true'); await click(rowRect(0));
  await until('previewState', 'playing'); await until('stageReady', 'true');
  await studio.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await studio.reload(); await studio.getByText(/webcam ·/).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('Webcam integration passed: all game models, real two-player inference, permissions, cleanup, Studio live view, frame-timed recording, export, game bundle playback, persistence.');
} catch (error) {
  if (game) console.error('Game state:', await game.locator('canvas').evaluate(c => JSON.stringify(c.dataset)).catch(() => ''));
  if (studio) console.error('Studio capture:', await studio.locator('.body-calibration, .connection-status, [role=status]').allInnerTexts().catch(() => []));
  if (game) console.error('Pose diagnostics:', await game.evaluate(() => JSON.stringify((window as TestWindow).poseDiagnostics)).catch(() => ''));
  if (studio) {
    console.error('Studio state:', await studio.locator('.connection-status').textContent().catch(() => ''));
    console.error('Studio message:', await studio.locator('.message').textContent().catch(() => ''));
  }
  throw error;
} finally {
  await browser.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await rm(dataDir, { recursive: true, force: true });
}
