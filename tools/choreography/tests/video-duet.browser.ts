// Real model regression for small dancers in a tall video frame. An optional
// local image argument reproduces a reported frame without committing footage.
import assert from 'node:assert/strict';
import express from 'express';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { MODELS } from '../../../packages/pose/browser/models.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from '../../../packages/pose/browser/pose.worker.ts';
import type * as VideoImport from '../web/videoImport.ts';
import type * as PoseFiles from '../poseFiles.ts';
import type * as Binary from '../../../packages/pose/binary.ts';
import { baseUrl } from './helpers.ts';

interface Probe { crop: VideoImport.Crop | null; regionId: number | null; body: { i: number; x: number; y: number; confidence: number }[][]; }
interface DuetReport {
  model: string; fullFrameCounts: number[]; calibrationPlayers: number[]; hipX: number[]; minBodyConfidence: number[];
  processedPlayers: number[] | undefined; probes?: Probe[];
}

const app = express();
// Vite transpiles the TypeScript sources the page imports, such as /tools/choreography/web/videoImport.ts.
const vite = await createServer({ root: path.resolve('.'), configFile: false, appType: 'custom', logLevel: 'warn',
  server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true } });
app.get('/probe', (_req, res) => res.type('html').send('<html></html>'));
app.get('/frame', (_req, res) => res.sendFile(path.resolve(process.argv[2] || 'apps/web/tests/fixtures/mediapipe-pose.jpg'), { dotfiles: 'allow' }));
// The built worker and model assets come first; the build has no /tools or /packages paths for them to shadow.
app.use(express.static('tools/choreography/dist'));
app.use(vite.middlewares);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const workerFile = (await readdir('tools/choreography/dist/assets')).find(name => name.startsWith('pose.worker-'));
assert.ok(workerFile, 'Build the studio first');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto(`${baseUrl(server)}/probe`);
  const reports = await page.evaluate(async ({ models, workerFile, useReportedFrame }) => {
    // A test double for the <video> element: only the members the importer reads.
    const fakeVideo = (video: Partial<HTMLVideoElement>) => video as HTMLVideoElement;
    const field = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
    let image = await createImageBitmap(await (await fetch('/frame')).blob());
    if (!useReportedFrame) {
      const canvas = new OffscreenCanvas(480, 854), g = canvas.getContext('2d');
      if (!g) throw Error('No 2D canvas');
      g.fillStyle = '#eee'; g.fillRect(0, 0, 480, 854);
      g.drawImage(image, 200, 0, 600, 667, 135, 360, 110, 155);
      g.drawImage(image, 200, 0, 600, 667, 225, 345, 110, 170);
      image.close(); image = await createImageBitmap(canvas);
    }
    const videoImportUrl = '/tools/choreography/web/videoImport.ts', poseFilesUrl = '/tools/choreography/poseFiles.ts', binaryUrl = '/packages/pose/binary.ts';
    const { VideoImporter }: typeof VideoImport = await import(videoImportUrl);
    const { captureHead, decodeCaptureBatch }: typeof PoseFiles = await import(poseFilesUrl);
    const { framesToPoses }: typeof Binary = await import(binaryUrl);
    const reports: DuetReport[] = [];
    for (const model of models) {
      const worker = new Worker(`/assets/${workerFile}`, { type: 'module' });
      const send = (data: PoseWorkerRequest) => new Promise<PoseWorkerResponse>((resolve, reject) => {
        worker.onmessage = ({ data: result }: MessageEvent<PoseWorkerResponse>) => result.type === 'error' ? reject(Error(result.message)) : resolve(result);
        worker.onerror = event => reject(Error(event.message));
        worker.postMessage(data, data.type === 'frame' ? [data.bitmap] : []);
      });
      await send({ type: 'initialize', sessionId: model.id, runningMode: 'VIDEO', playerCount: 2,
        modelUrl: `${location.origin}/pose-assets/mediapipe-1.1.0/${model.file}`, modelHash: model.sha256,
        wasmUrl: `${location.origin}/pose-assets/mediapipe-1.1.0/wasm` });
      const fullFrameCounts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const result = await send({ type: 'frame', seq: i + 1, bitmap: await createImageBitmap(image), timestampMs: i * 33 });
        if (result.type !== 'result') throw Error(`Unexpected ${result.type} response`);
        fullFrameCounts.push(result.landmarks.length);
      }
      worker.terminate();
      // The players in the last uploaded frame, decoded with the header the capture started with.
      let head: Uint8Array | undefined, processedPlayers: number[] | undefined;
      const job = new VideoImporter({ video: fakeVideo({ videoWidth: image.width, videoHeight: image.height, currentTime: 0, duration: .2, pause() {} }),
        modelId: model.id, projectId: 'probe', createWorker: () => new Worker(`/assets/${workerFile}`, { type: 'module' }),
        assetUrl: () => `${location.origin}/pose-assets/mediapipe-1.1.0/`,
        bitmap: (_video, ...crop) => crop.length === 4 ? createImageBitmap(image, ...crop) : createImageBitmap(image),
        seek: async (_video, time) => ({ mediaTimeMs: time * 1000, timingMethod: 'decoded-frame' }),
        request: async (url, options) => {
          const body = options?.body;
          if (url.endsWith('/takes')) head = captureHead(field(body, 'header'));
          if (url.includes('/batches') && head && body instanceof Uint8Array) {
            const frames = decodeCaptureBatch(head, body);
            if (frames.times.length) processedPlayers = framesToPoses(frames, frames.times.length - 1).poses.map(p => p.playerId);
          }
          return { takeId: 'probe' };
        },
      });
      const probes: Probe[] = [], infer = job.infer.bind(job);
      let checkingCalibration = true;
      job.infer = async (time, crop, regionId) => {
        const result = await infer(time, crop, regionId);
        if (checkingCalibration) probes.push({ crop, regionId, body: result.landmarks.map(p =>
          [11, 12, 23, 24, 27, 28].map(i => ({ i, x: p[i].x, y: p[i].y,
            confidence: Math.min(p[i].visibility, p[i].presence ?? NaN) }))) });
        return result;
      };
      const calibration = await job.calibrate();
      checkingCalibration = false;
      await job.process('frame.webm');
      reports.push({ model: model.id, fullFrameCounts, calibrationPlayers: calibration.poses.map(p => p.playerId),
        hipX: calibration.poses.map(p => (p.landmarks[23].x + p.landmarks[24].x) / 2),
        minBodyConfidence: calibration.poses.map(p => Math.min(...[11, 12, 23, 24, 27, 28].map(i => p.landmarks[i].confidence ?? 0))),
        processedPlayers,
        ...(calibration.poses.length < 2 ? { probes } : {}) });
      job.abort();
    }
    image.close();
    return reports;
  }, { models: MODELS, workerFile, useReportedFrame: Boolean(process.argv[2]) });
  console.log(JSON.stringify(reports, null, 2));
  for (const report of reports) {
    assert.deepEqual(report.calibrationPlayers, [0, 1], `${report.model}: both dancers must calibrate`);
    assert.deepEqual(report.processedPlayers, [0, 1], `${report.model}: both dancers must survive video processing`);
    // Unmirrored camera coordinates: player 1 (id 0) is on the right, shown on the left of the mirrored view.
    assert.ok(report.hipX[0] > .5 && report.hipX[1] < .5, 'restored coordinates retain the original regions');
  }
  console.log('Portrait duet regression passed for Lite: both calibration and video processing.');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await vite.close();
}
