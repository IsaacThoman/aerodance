import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { VideoImporter, sampleTimes, seekVideoFrame, videoCalibrationPreview, videoRegionCrop, restoreVideoLandmarks } from '../web/videoImport.ts';
import type { BitmapFn, Crop, DecodedFrame, DecodeOptions, ErrorListener, ImportWorker, ImportWorkerRequest, MessageListener } from '../web/videoImport.ts';
import { createStudio } from '../server/index.ts';
import { readZip } from '../server/zip.ts';
import { MEDIAPIPE_VERSION, poseModel } from '../../../packages/pose/browser/models.ts';
import type { PoseRunningMode, PoseWorkerResponse } from '../../../packages/pose/browser/pose.worker.ts';
import type { Landmark } from '../../../packages/pose/choreography.ts';
import { PoseFileWriter, SEEK_TIME, framesToPoses } from '../../../packages/pose/binary.ts';
import { CLEANUP_SETTINGS } from '../poseCleanup.ts';
import type { PoseFrames } from '../../../packages/pose/binary.ts';
import { captureHead, captureHeader } from '../poseFiles.ts';
import type { CaptureStart } from '../poseFiles.ts';
import { newProject, addTake, takeFromRecords, takeCalibration, overwriteTracks, appendOperation,
  offsetTrack, historyStep, compileProject, validateTake, validateTrackData, trackDataIds, isTrackData } from '../core.ts';
import type { StudioAssets } from '../core.ts';
import { takeIdOf } from '../web/api.ts';
import { baseUrl, captureOf, fake, found, projectOf, read, songFolder, storedCalibration, storedPose, takeOf, uploadedFrames, zipPose } from './helpers.ts';
import type { Call } from './helpers.ts';

const pose = (playerId: number, hipY = .6): { playerId: number; landmarks: Landmark[] } => ({ playerId, landmarks: Array.from({ length: 33 }, (_, i) => ({
  x: playerId ? .25 : .75, y: i < 11 ? .15 : i < 23 ? .4 : i < 27 ? hipY : .9,
  z: 0, confidence: .95,
})) });
/** What the pose worker reports for a stored pose. */
const detected = ({ landmarks }: { landmarks: Landmark[] }): NormalizedLandmark[] =>
  landmarks.map(({ confidence, ...p }) => ({ ...p, visibility: confidence ?? 0, presence: confidence ?? 0 }));
function fixture() {
  const model = poseModel('lite');
  const metadata = { sourceKind: 'video', takeId: 'video-take', name: 'dance.webm',
    createdAt: new Date().toISOString(), calibrationFrame: { mediaTimeMs: 400, poses: [pose(0), pose(1)] },
    status: { modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU', durationMs: 1000, filename: 'dance.webm' } };
  const records = Array.from({ length: 11 }, (_, i) => ({ ordinal: i, record: {
    schema: 'aerodance.video-record', schemaVersion: 1, type: 'pose', sessionId: 'file', seq: i + 1,
    playerCount: 2, input: { width: 640, height: 480, mirrored: false }, modelId: model.id,
    mediaTimeMs: i * 100, timingMethod: 'decoded-frame', poses: i === 3 ? [] : [pose(0, .8), pose(1, .8)],
  } }));
  const header: CaptureStart = { sourceKind: 'video', sessionId: 'file', input: { width: 640, height: 480 }, playerCount: 2,
    modelId: model.id, audioPlaybackRate: null, extensionBases: [] };
  return { metadata, records, header, take: takeFromRecords(captureOf(records, 'video', metadata.calibrationFrame), metadata) };
}
/** Each batch upload's frames: media time, poses and timing method. */
const uploadedRecords = (calls: readonly Call[]) => uploadedFrames(calls).map((f: PoseFrames) => Array.from(f.times, (mediaTimeMs, i) => ({
  mediaTimeMs, poses: framesToPoses(f, i).poses, timingMethod: f.frameFlags[i] & SEEK_TIME ? 'seek-time' : 'decoded-frame',
})));
const canvas = (fields: object) => fake<HTMLCanvasElement>(fields);
const video = (fields: Partial<HTMLVideoElement>) => fake<HTMLVideoElement>({ pause() {}, ...fields });
/** The bitmap the importer sends the worker, remembering the crop it was cut from. */
class Bitmap implements ImageBitmap {
  width = 0; height = 0;
  crop?: Crop;
  constructor(crop?: Crop) { this.crop = crop; }
  close() {}
}
const bitmap: BitmapFn = async (_source, ...crop) => new Bitmap(crop.length === 4
  ? { x: crop[0], y: crop[1], width: crop[2], height: crop[3] } : undefined);

test('calibration preview keeps the left dancer visible when calibration confidence is insufficient', () => {
  const left = detected(pose(0)), right = detected(pose(1));
  left[27].visibility = .1;
  let preview = videoCalibrationPreview([left, right]);
  assert.deepEqual(preview.poses.map(p => p.playerId), [1]);
  assert.deepEqual(preview.detectedPoses.map(p => [p.playerId, p.ready]), [[0, false], [1, true]]);
  assert.match(preview.detectedPoses[0].reason, /shoulders, hips and feet/);
  left[11].visibility = .1;
  preview = videoCalibrationPreview([left, right]);
  assert.equal(preview.detectedPoses[0].playerId, 0, 'low torso confidence must not hide P1');
  assert.equal(preview.detectedPoses[0].ready, false);
  left[27].visibility = .95; left[11].visibility = .95;
  preview = videoCalibrationPreview([left, right]);
  assert.deepEqual(preview.detectedPoses.map(p => p.ready), [true, true]);
  assert.deepEqual(preview.poses.map(p => p.playerId), [0, 1]);
});

test('region recovery focuses on small dancers and restores full-frame XYZ coordinates', () => {
  const dancer = detected(pose(1)).map(p => ({ ...p, y: .45 + p.y * .2 }));
  const crop = videoRegionCrop([dancer], 1, 481, 854);
  assert.equal(crop.x, 0); assert.equal(crop.width, 240);
  assert.ok(crop.y > 0 && crop.height < 400, 'portrait height must be cropped to enlarge the dancer');
  const restored = restoreVideoLandmarks([{ x: .8, y: .6, z: -.2, visibility: .9, presence: .9 }], crop, 481, 854)[0];
  assert.equal(restored.x, .8 * crop.width / 481);
  assert.equal(restored.y, (crop.y + .6 * crop.height) / 854);
  assert.equal(restored.z, -.2 * crop.width / 481);
  assert.equal(restored.visibility, .9);
  const second = videoRegionCrop([dancer], 0, 481, 854);
  assert.equal(second.x, 240); assert.equal(second.width, 241);
});

test('missing P1 is recovered without changing P2, file timing or primary video tracking', async () => {
  const diagnostics = newDiagnostics(), calls: Call[] = [];
  class MissingLeftWorker extends PoseWorker {
    landmarks(frame: FrameRequest) {
      if (frame.regionId === undefined) return [detected(pose(1))];
      assert.ok(frame.bitmap instanceof Bitmap && frame.bitmap.crop);
      const crop = frame.bitmap.crop;
      return [detected(pose(0)).map(p => ({ ...p, x: (p.x * 640 - crop.x) / crop.width,
        y: (p.y * 480 - crop.y) / crop.height, z: p.z * 640 / crop.width }))];
    }
  }
  const job = new VideoImporter({ video: video({ videoWidth: 640, videoHeight: 480, currentTime: 0, duration: .1 }),
    modelId: 'lite', projectId: 'project', createWorker: () => new MissingLeftWorker(diagnostics), assetUrl: () => 'http://localhost/',
    bitmap,
    seek: async (_video, time) => ({ mediaTimeMs: time * 1000, timingMethod: 'decoded-frame' }),
    request: async (url, options) => { calls.push({ url, body: structuredClone(options?.body) }); return { takeId: 'capture' }; },
  });
  const calibration = await job.calibrate();
  assert.deepEqual(calibration.poses.map(p => p.playerId), [0, 1]);
  assert.deepEqual(calibration.poses[1], pose(1));
  await job.process('duet.webm');
  const records = uploadedRecords(calls)[0];
  assert.deepEqual(found(records.at(-1)).poses.map(p => p.playerId), [0, 1]);
  assert.deepEqual(found(records.at(-1)).poses[1], storedPose(pose(1)));
  assert.deepEqual(records.map(r => r.mediaTimeMs), [...sampleTimes(100)].map(t => t * 1000));
  assert.deepEqual(diagnostics.modes, ['IMAGE', 'IMAGE', 'VIDEO', 'VIDEO', 'VIDEO']);
  assert.equal(diagnostics.terminated, 5);
  assert.equal(diagnostics.maxActive, 1);
});

test('video takes use file timestamps, preserve absences and validate calibration and model provenance', () => {
  const { take, records, metadata } = fixture();
  assert.equal(take.source, 'video'); assert.equal(take.offsetMs, 0); assert.equal(take.timeScale, 1);
  assert.deepEqual(take.samples.map(s => s.takeTimeMs), records.map(e => e.record.mediaTimeMs));
  assert.deepEqual(take.samples[3].poses, []);
  assert.equal(take.provenance?.modelHash, poseModel('lite').sha256);
  assert.equal(take.provenance?.calibrationFrameTimeMs, 400);
  const step = (v: number) => Math.round(v * 16384) / 16384;
  assert.equal(takeCalibration(take, 0).torsoLength, step(.6) - step(.4), 'measured on the stored calibration frame');
  const missing = structuredClone(take); found(missing.calibrationFrame).poses.pop();
  assert.throws(() => validateTake(missing), /every captured dancer/);
  const weak = structuredClone(take); found(weak.calibrationFrame).poses[0].landmarks[27].confidence = .1;
  assert.throws(() => validateTake(weak), /shoulders, hips and feet/);
  const late = structuredClone(take); found(late.calibrationFrame).mediaTimeMs = 1001;
  assert.throws(() => validateTake(late), /calibration frame time/);
  const retired = records.map(e => ({ ...e, record: { ...e.record, modelId: 'full' } }));
  assert.throws(() => takeFromRecords(captureOf(retired, 'video'), metadata), /Invalid video model configuration/);
  const reversed = structuredClone(records); reversed[1].record.mediaTimeMs = 0;
  assert.throws(() => captureOf(reversed, 'video'), /increasing/);
  const skipped = structuredClone(records); skipped[1].record.seq = 3;
  assert.throws(() => takeFromRecords(captureOf(skipped, 'video', metadata.calibrationFrame), metadata), /sequence or timing/);
  const noCalibration = structuredClone(take); delete noCalibration.calibrationFrame;
  assert.throws(() => validateTake(noCalibration), /require a calibration frame/);
});

test('explicit calibration survives independent snapshots, edits, offsets, undo and removing the library take', () => {
  const { take } = fixture(), assets: StudioAssets = new Map([[take.takeId, take]]);
  let p = addTake(newProject('video-project'), take);
  assert.ok(p.tracks.every(t => t.dataId === null), 'import only adds a library take');
  p = overwriteTracks(p, take, [0, 1], assets);
  const expected = takeCalibration(take, 0);
  p = appendOperation(p, { type: 'mirror', playerId: 0, startMs: 0, endMs: 1000 }, assets);
  p = offsetTrack(p, 0, -100);
  assert.deepEqual(compileProject(p, assets).tracks[0].calibration, expected);
  const data = assets.get(found(p.tracks[0].dataId));
  assert.ok(isTrackData(data));
  const bad = structuredClone(data); found(bad.calibration).torsoLength = NaN;
  assert.throws(() => validateTrackData(bad), /Invalid track calibration/);
  p = historyStep(p, -1); p = historyStep(p, 1);
  p.takes = []; assets.delete(take.takeId);
  assert.deepEqual(compileProject(p, assets).tracks[0].calibration, expected);
});

interface Diagnostics { active: number; maxActive: number; terminated: number; modes: (PoseRunningMode | undefined)[]; }
const newDiagnostics = (): Diagnostics => ({ active: 0, maxActive: 0, terminated: 0, modes: [] });
type FrameRequest = Extract<ImportWorkerRequest, { type: 'frame' }>;
type ListenerArgs = ['message', MessageListener] | ['error', ErrorListener];
class PoseWorker implements ImportWorker {
  diagnostics: Diagnostics;
  sessionId?: string;
  listeners = new Set<MessageListener>();
  constructor(diagnostics: Diagnostics) { this.diagnostics = diagnostics; }
  addEventListener(...[type, listener]: ListenerArgs) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(...[type, listener]: ListenerArgs) { if (type === 'message') this.listeners.delete(listener); }
  /** The detections a frame yields. */
  landmarks(_frame: FrameRequest): NormalizedLandmark[][] { return [detected(pose(0)), detected(pose(1))]; }
  respond(data: PoseWorkerResponse) {
    const event = new MessageEvent('message', { data });
    for (const listener of [...this.listeners]) listener(event);
  }
  postMessage(data: ImportWorkerRequest) {
    if (data.type === 'initialize') {
      this.diagnostics.modes.push(data.runningMode);
      queueMicrotask(() => this.respond({ type: 'ready', sessionId: data.sessionId, delegate: 'CPU', fallback: '' }));
      this.sessionId = data.sessionId;
    } else if (data.type === 'frame') {
      this.diagnostics.active++; this.diagnostics.maxActive = Math.max(this.diagnostics.maxActive, this.diagnostics.active);
      const seq = data.seq, landmarks = this.landmarks(data);
      setTimeout(() => {
        this.diagnostics.active--;
        this.respond({ type: 'result', sessionId: this.sessionId, seq, landmarks, inferenceMs: 0 });
      }, seq % 2 ? 8 : 1);
    }
  }
  terminate() { this.diagnostics.terminated++; }
}
test('continuous region workers keep separate VIDEO histories and frozen crops, even when full-frame tracking succeeds', async () => {
  const diagnostics = newDiagnostics(), workers: TrackedWorker[] = [];
  class TrackedWorker extends PoseWorker {
    times: number[] = [];
    regions = new Set<number | undefined>();
    crops: (Crop | undefined)[] = [];
    postMessage(data: ImportWorkerRequest) {
      if (data.type === 'frame') {
        this.times.push(data.timestampMs); this.regions.add(data.regionId);
        this.crops.push(data.bitmap instanceof Bitmap ? data.bitmap.crop : undefined);
      }
      super.postMessage(data);
    }
  }
  const job = new VideoImporter({video:video({duration:.2,videoWidth:640,videoHeight:480}),modelId:'lite',projectId:'project',
    bitmap,decodeFrames:async()=>null,seek:async(_v,time)=>({mediaTimeMs:time*1000,timingMethod:'decoded-frame'}),assetUrl:()=> 'http://localhost/',
    createWorker:()=>{const worker=new TrackedWorker(diagnostics);workers.push(worker);return worker;},request:async()=>({takeId:'continuous'})});
  await job.process('duet.webm');
  assert.equal(workers.length,3);
  assert.deepEqual(diagnostics.modes,['VIDEO','VIDEO','VIDEO']);
  for (const [i,worker] of workers.entries()) {
    assert.deepEqual(worker.times,[...sampleTimes(200)].map(t=>t*1000));
    assert.deepEqual([...worker.regions],[i===0 ? undefined : i-1]);
    assert.ok(worker.crops.every(c=>JSON.stringify(c)===JSON.stringify(worker.crops[0])));
  }
  assert.equal(diagnostics.terminated,3);
});

test('crop worker failure stops the import and releases every initialized worker', async () => {
  const diagnostics = newDiagnostics();
  class FailedCrop extends PoseWorker {
    postMessage(data: ImportWorkerRequest) {
      if (data.type==='frame' && data.regionId===1) {
        queueMicrotask(()=>this.respond({type:'error',sessionId:this.sessionId,message:'Crop inference failed'}));
        return;
      }
      super.postMessage(data);
    }
  }
  const job=new VideoImporter({video:video({duration:.2,videoWidth:640,videoHeight:480}),modelId:'lite',projectId:'project',
    bitmap,decodeFrames:async()=>null,seek:async(_v,time)=>({mediaTimeMs:time*1000,timingMethod:'decoded-frame'}),assetUrl:()=> 'http://localhost/',
    createWorker:()=>new FailedCrop(diagnostics),request:async()=>({takeId:'failure'})});
  await assert.rejects(job.process('duet.webm'),/Crop inference failed/);
  assert.equal(diagnostics.terminated,3);
  assert.equal(job.processed,undefined);
});

test('cancelling a running crop tracker releases all workers and does not finalize', async () => {
  const diagnostics=newDiagnostics();
  class CancelCrop extends PoseWorker {
    postMessage(data: ImportWorkerRequest) {
      if(data.type==='frame' && data.regionId===1) { queueMicrotask(()=>job.abort()); return; }
      super.postMessage(data);
    }
  }
  const job=new VideoImporter({video:video({duration:.2,videoWidth:640,videoHeight:480}),modelId:'lite',projectId:'project',
    bitmap,decodeFrames:async()=>null,seek:async(_v,time)=>({mediaTimeMs:time*1000,timingMethod:'decoded-frame'}),assetUrl:()=> 'http://localhost/',
    createWorker:()=>new CancelCrop(diagnostics),request:async()=>({takeId:'cancel-crop'})});
  await assert.rejects(job.process('duet.webm'),{name:'AbortError'});
  assert.equal(diagnostics.terminated,3);
  assert.equal(job.regionWorkers.size,0);
  assert.equal(job.processed,undefined);
});
test('solo video detection uses one whole-frame model and maps centered or side dancers to P1 or P2', async () => {
  for (const captureMode of ['p1', 'p2'] as const) for (const x of [.2, .5, .8]) {
    const calls: Call[] = [], diagnostics = newDiagnostics();
    const dancer = detected(pose(0)).map(p => ({ ...p, x }));
    class SoloWorker extends PoseWorker {
      landmarks() { return [dancer]; }
      postMessage(data: ImportWorkerRequest) {
        if (data.type === 'initialize') assert.equal(data.playerCount, 1);
        if (data.type === 'frame') assert.equal(data.regionId, undefined);
        super.postMessage(data);
      }
    }
    const job = new VideoImporter({ video: video({ duration: .3, videoWidth: 640, videoHeight: 480, currentTime: .1 }),
      modelId: 'lite', captureMode, projectId: 'project', sampleRate: 10, bitmap,
      assetUrl: () => 'http://localhost/pose-assets/', createWorker: () => new SoloWorker(diagnostics),
      seek: async (_v, time) => ({ mediaTimeMs: time * 1000, timingMethod: 'seek-time' }), decodeFrames: async () => null,
      request: async (url, options) => { calls.push({ url, body: structuredClone(options?.body) }); return { takeId: 'capture' }; } });
    const calibration = await job.calibrate();
    const playerId = captureMode === 'p1' ? 0 : 1;
    assert.deepEqual(calibration.poses.map(p => p.playerId), [playerId]);
    assert.ok(calibration.detectedPoses.every(p => p.ready));
    await job.process('solo.webm'); await job.finalize(calibration);
    const records = uploadedRecords(calls).flat();
    assert.equal(records.length, 3);
    assert.ok(records.every(r => r.poses.length === 1 && r.poses[0].playerId === playerId));
    assert.ok(records.every(r => Math.abs(r.poses[0].landmarks[23].x - x) < .0001));
    assert.deepEqual(diagnostics.modes, ['IMAGE', 'VIDEO']);
  }
});
test('video processing awaits inference, skips duplicate decoded frames and retries bounded uploads', async () => {
  const calls: Call[] = [], diagnostics = newDiagnostics();
  let failed = false;
  const job = new VideoImporter({ video: video({ duration: .5, videoWidth: 640, videoHeight: 480, currentTime: .2 }), modelId: 'lite', projectId: 'project',
    assetUrl: () => 'http://localhost/pose-assets/', bitmap,
    createWorker: () => new PoseWorker(diagnostics),
    seek: async (_v, time) => ({ mediaTimeMs: Math.floor((time + 1e-8) * 10) * 100, timingMethod: 'decoded-frame' }),
    request: async (url, options) => {
      calls.push({ url, body: structuredClone(options?.body) });
      if (url.includes('/batches') && !failed) { failed = true; throw Error('temporary upload failure'); }
      return { takeId: 'capture' };
    },
  });
  const calibration = await job.calibrate();
  await job.process('fixture.webm');
  assert.equal(diagnostics.maxActive, 1); assert.deepEqual(diagnostics.modes, ['IMAGE', 'VIDEO', 'VIDEO', 'VIDEO']);
  const batches = calls.filter(c => c.url.includes('/batches'));
  assert.equal(batches.length, 2); assert.deepEqual(batches[0].body, batches[1].body);
  const records = uploadedRecords(calls)[1];
  assert.deepEqual(records.map(r => r.mediaTimeMs), [0, 100, 200, 300, 400]);
  assert.deepEqual(records[0].poses, [], 'two-player acquisition needs consecutive evidence');
  await assert.rejects(job.finalize({ ...calibration, poses: [calibration.poses[0]] }), /P2/);
  await job.finalize(calibration);
  assert.deepEqual(read(found(calls.at(-1)).body, 'calibrationFrame'), calibration);
  assert.equal(diagnostics.terminated, 4);
});

test('cancelling inference releases the worker and does not finalize a partial take', async () => {
  const diagnostics = newDiagnostics(), calls: string[] = [];
  const job = new VideoImporter({ video: video({ duration: .5, videoWidth: 640, videoHeight: 480 }),
    modelId: 'lite', projectId: 'project', assetUrl: () => 'http://localhost/', bitmap,
    seek: async (_video, time) => ({ mediaTimeMs: time * 1000, timingMethod: 'seek-time' }),
    createWorker: () => new PoseWorker(diagnostics),
    request: async url => { calls.push(url); return { takeId: 'cancelled' }; },
  });
  const processing = job.process('fixture.webm');
  setTimeout(() => job.abort(), 3);
  await assert.rejects(processing, { name: 'AbortError' });
  assert.equal(job.processed, undefined);
  assert.equal(calls.some(url => url.endsWith('/finalize')), false);
  assert.ok(diagnostics.terminated > 0);
});

test('samples are taken mid-window so rounded container timestamps are not skipped', () => {
  const times = [...sampleTimes(200)];
  assert.equal(times.length, 6);
  assert.ok(Math.abs(times[2] - 2.5 / 30) < 1e-12);
  // A 30 fps WebM stores frame 2 at 67 ms; sampling at 66.7 ms would select frame 1.
  assert.ok(times[2] > .067);
});

test('decoded frames are processed in order, prefetched during inference and released', async () => {
  const diagnostics = newDiagnostics(), calls: Call[] = [], bitmaps: { source: DecodedFrame['source']; pulled: number }[] = [];
  const state: { pulled: number; returned: boolean; options: DecodeOptions | null } = { pulled: 0, returned: false, options: null };
  const file = fake<Blob>({ name: 'decoded.webm' });
  // 33 ms appears twice: a source frame shown across two sample windows.
  // 310 ms is a final frame stamped past the reported duration.
  const order = [0, 33, 33, 67, 100, 133, 167, 200, 233, 267, 310];
  const job = new VideoImporter({ video: video({ duration: .3, videoWidth: 640, videoHeight: 480 }), file, modelId: 'lite', projectId: 'project', assetUrl: () => 'http://localhost/',
    createWorker: () => new PoseWorker(diagnostics),
    bitmap: async (source, ..._crop) => { bitmaps.push({ source, pulled: state.pulled }); return new Bitmap(); },
    seek: async () => { throw Error('decoded frames must not seek'); },
    decodeFrames: async (source, options) => {
      assert.equal(source, file); state.options = options;
      return (async function* () {
        try {
          for (const ms of order) {
            state.pulled++; yield { source: canvas({ ms }), mediaTimeMs: ms, timingMethod: 'decoded-frame', method: 'WebCodecs' };
          }
        } finally { state.returned = true; }
      })();
    },
    request: async (url, options) => { calls.push({ url, body: structuredClone(options?.body) }); return { takeId: 'decoded' }; },
  });
  await job.process('decoded.webm');
  assert.deepEqual(state.options, { width: 640, height: 480, durationMs: 300, rate: 30 });
  const records = uploadedRecords(calls).flat();
  assert.deepEqual(records.map(r => r.mediaTimeMs), [0, 33, 67, 100, 133, 167, 200, 233, 267]);
  assert.ok(records.every(r => r.timingMethod === 'decoded-frame'));
  // The following frame is already decoding when each frame's pixels are read.
  assert.deepEqual(bitmaps.filter((_,i) => i%3===0).slice(0, -1).map(b => b.pulled), records.slice(0, -1).map(r => order.indexOf(r.mediaTimeMs) + 2));
  assert.equal(bitmaps.length,records.length*3, 'each source frame feeds all three continuous trackers');
  assert.equal(diagnostics.maxActive, 1);
  assert.equal(state.returned, true);
});

test('cancelling decoded processing releases the decoder and does not finalize', async () => {
  const diagnostics = newDiagnostics(), calls: string[] = [];
  let returned = false;
  const job = new VideoImporter({ video: video({ duration: 10, videoWidth: 640, videoHeight: 480 }), file: fake<Blob>({}),
    modelId: 'lite', projectId: 'project', assetUrl: () => 'http://localhost/', bitmap,
    createWorker: () => new PoseWorker(diagnostics),
    decodeFrames: async () => (async function* () {
      try { for (let i = 0; ; i++) yield { source: canvas({}), mediaTimeMs: i * 33, timingMethod: 'decoded-frame', method: 'WebCodecs' }; }
      finally { returned = true; }
    })(),
    request: async url => { calls.push(url); return { takeId: 'cancelled' }; },
  });
  const processing = job.process('fixture.webm');
  setTimeout(() => job.abort(), 20);
  await assert.rejects(processing, { name: 'AbortError' });
  assert.equal(returned, true);
  assert.equal(calls.some(url => url.endsWith('/finalize')), false);
});

test('undecodable files fall back to seeking the video element', async () => {
  const diagnostics = newDiagnostics(), seeks: number[] = [], calls: Call[] = [];
  const job = new VideoImporter({ video: video({ duration: .2, videoWidth: 640, videoHeight: 480 }), file: fake<Blob>({}),
    modelId: 'lite', projectId: 'project', assetUrl: () => 'http://localhost/', bitmap,
    createWorker: () => new PoseWorker(diagnostics), decodeFrames: async () => null,
    seek: async (_v, time) => { seeks.push(time); return { mediaTimeMs: time * 1000, timingMethod: 'seek-time' }; },
    request: async (url, options) => { calls.push({ url, body: options?.body }); return { takeId: 'fallback' }; },
  });
  await job.process('fixture.webm');
  assert.deepEqual(seeks, [...sampleTimes(200)]);
  const records = uploadedRecords(calls).flat();
  assert.equal(records.length, 6);
  assert.ok(records.every(r => r.timingMethod === 'seek-time'));
});

test('video seeking waits for decoded pixels and supports browsers without frame callbacks', async () => {
  class Video extends EventTarget {
    readyState = 2;
    time = 0;
    pause() {}
    set currentTime(value: number) { this.time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    get currentTime() { return this.time; }
  }
  const controller = new AbortController(), video = fake<HTMLVideoElement>(new Video());
  assert.deepEqual(await seekVideoFrame(video, .5, controller.signal), { mediaTimeMs: 500, timingMethod: 'seek-time' });
  controller.abort();
  await assert.rejects(seekVideoFrame(video, 1, controller.signal), { name: 'AbortError' });
  class DecodedVideo extends Video {
    callback?: VideoFrameRequestCallback;
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.callback = callback; return 7; }
    cancelVideoFrameCallback(id: number) { assert.equal(id, 7); }
    set currentTime(value: number) {
      this.time = value;
      queueMicrotask(() => {
        this.dispatchEvent(new Event('seeked'));
        this.callback?.(0, fake<VideoFrameCallbackMetadata>({ mediaTime: .4 }));
      });
    }
    get currentTime() { return this.time; }
  }
  assert.deepEqual(await seekVideoFrame(fake<HTMLVideoElement>(new DecodedVideo()), .45, new AbortController().signal),
    { mediaTimeMs: 400, timingMethod: 'decoded-frame' });
});

test('video batches finalize with calibration and survive export and backup after source-take deletion', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-video-'));
  const { app } = createStudio({ dataDir: root }), server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = baseUrl(server);
  const api = async (url: string, body: unknown, method = 'POST') => fetch(base + url, { method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const upload = (url: string, bytes: Uint8Array<ArrayBuffer>) => fetch(base + url, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  let p = await projectOf(await api('/api/projects', {}));
  const { metadata, records, header } = fixture();
  const capture: unknown = await (await api(`/api/projects/${p.projectId}/takes`, { ...metadata, header })).json();
  const url = `/api/projects/${p.projectId}/takes/${takeIdOf(capture)}`;
  const batch = new PoseFileWriter(captureHeader(header)).frames(records.map(({ record: r }) => ({ timeMs: r.mediaTimeMs, poses: r.poses, seq: r.seq })));
  assert.equal((await upload(`${url}/batches?batchId=0`, captureHead(header))).status, 400, 'a batch holds only frames and events');
  assert.equal((await upload(`${url}/batches?batchId=0`, batch)).status, 200);
  assert.equal((await upload(`${url}/batches?batchId=0`, batch)).status, 200);
  assert.equal((await upload(`${url}/batches?batchId=0`, batch.slice(0, -8))).status, 400);
  const finish = { batchCount: 1, recordCount: records.length, calibrationFrame: metadata.calibrationFrame };
  assert.equal((await api(`${url}/finalize`, { ...finish, calibrationFrame: { mediaTimeMs: 0, poses: [] } })).status, 400);
  const result = await api(`${url}/finalize`, finish);
  assert.equal(result.status, 200, await result.clone().text());
  const take = await takeOf(result);
  assert.deepEqual((await (await api(`${url}/finalize`, finish)).json()), take);
  p = addTake(p, take);
  const assets: StudioAssets = new Map([[take.takeId, take]]);
  p = overwriteTracks(p, take, [0, 1], assets);
  // Explicitly review the deliberate gap for this publication fixture.
  p = appendOperation(p, { type: 'approve', playerId: null, startMs: 200, endMs: 401, reason: 'Reviewed fixture gap' }, assets);
  for (const dataId of trackDataIds(p)) assert.equal((await api(`/api/projects/${p.projectId}/tracks`, assets.get(dataId))).status, 201);
  p.metadata.artist = 'Fixture'; p.metadata.rights.audio.license = 'CC0'; p.metadata.rights.choreography.license = 'CC0';
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, 'PUT'));
  p = await projectOf(await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('fixture audio'),
  }));
  p.alignmentReviewed = true;
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, 'PUT'));
  const exported = await fetch(`${base}/api/projects/${p.projectId}/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const files = readZip(Buffer.from(await exported.arrayBuffer()));
  const choreography = zipPose(files, `${songFolder(files)}/choreography.adpose`);
  assert.deepEqual(found(choreography.tracks)[0].calibration, storedCalibration(takeCalibration(take, 0)));
  const backup = await fetch(`${base}/api/projects/${p.projectId}/backup`);
  const restored = await fetch(`${base}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await backup.arrayBuffer() });
  assert.equal(restored.status, 201);
  const rp = await projectOf(restored);
  const saved = await takeOf(await fetch(`${base}/api/projects/${rp.projectId}/takes/${take.takeId}`));
  assert.deepEqual(saved.calibrationFrame, take.calibrationFrame);
  p = await projectOf(await api(`/api/projects/${p.projectId}/takes/${take.takeId}`, { revision: p.revision }, 'DELETE'));
  const afterDelete = await fetch(`${base}/api/projects/${p.projectId}/backup`);
  const restoredDeleted = await fetch(`${base}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await afterDelete.arrayBuffer() });
  assert.equal(restoredDeleted.status, 201);
  const dp = await projectOf(restoredDeleted);
  assert.equal(dp.takes.length, 0);
  const snapshot = validateTrackData(await (await fetch(`${base}/api/projects/${dp.projectId}/tracks/${dp.tracks[0].dataId}`)).json());
  assert.deepEqual(snapshot.calibration, storedCalibration(takeCalibration(take, 0)));
});

test('video audio and library attachment commit with revision checks and idempotent retry', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-video-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { store } = createStudio({ dataDir: root });
  let project = await store.save(newProject('video-audio-project'), null);
  project = await store.uploadAudio(project.projectId, new Uint8Array([1, 2]), 'audio/wav', 1000, project.revision, 'old.wav');
  const { metadata, records, header } = fixture();
  const capture = await store.startCapture(project.projectId, { ...metadata, header });
  await store.appendBatch(project.projectId, capture.takeId, 0,
    new PoseFileWriter(captureHeader(header)).frames(records.map(({ record }) => ({ timeMs: record.mediaTimeMs, poses: record.poses, seq: record.seq }))));
  await store.finalize(project.projectId, capture.takeId, { batchCount: 1, recordCount: records.length, calibrationFrame: metadata.calibrationFrame });
  const bytes = new Uint8Array([3, 4]);
  await assert.rejects(store.uploadAudio(project.projectId, bytes, 'audio/wav', 1000, project.revision - 1, 'video.wav', capture.takeId), /Project changed/);
  assert.deepEqual(await store.project(project.projectId), project);
  const completed = await store.uploadAudio(project.projectId, bytes, 'audio/wav', 1000, project.revision, 'video.wav', capture.takeId);
  assert.equal(completed.takes.length, 1);
  assert.equal(completed.takes[0].takeId, capture.takeId);
  assert.equal(completed.audio?.name, 'video.wav');
  assert.equal(completed.revision, project.revision + 1);
  assert.equal(completed.alignmentReviewed, false);
  const retry = await store.uploadAudio(project.projectId, bytes, 'audio/wav', 1000, project.revision, 'video.wav', capture.takeId);
  assert.deepEqual(retry, completed);
  assert.deepEqual(new Uint8Array(await (await store.audio(project.projectId)).arrayBuffer()), bytes);
});

test('cleaned video takes preserve original capture bytes and quality through backup restore', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'studio-cleanup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const {store}=createStudio({dataDir:root});
  let project=await store.save(newProject('cleanup-project'),null);
  const {metadata,records,header}=fixture();
  records[5].record.poses[0].landmarks[15].x=1.7;
  const capture=await store.startCapture(project.projectId,{...metadata,status:{...metadata.status,cleanup:{...CLEANUP_SETTINGS}},header});
  const batch=new PoseFileWriter(captureHeader(header)).frames(records.map(({record:r})=>({timeMs:r.mediaTimeMs,poses:r.poses,seq:r.seq})));
  await store.appendBatch(project.projectId,capture.takeId,0,batch);
  const take=await store.finalize(project.projectId,capture.takeId,{batchCount:1,recordCount:records.length,calibrationFrame:metadata.calibrationFrame});
  assert.equal(take.samples[5].quality![0].landmarkOrigins[15],'gap-repaired');
  assert.equal(take.samples[5].quality![0].scoreEligible[15],false);
  assert.ok(take.samples[5].poses[0].landmarks[15].x<1);
  project=await store.save(addTake(project,take),project.revision);
  const backup=await store.download(project.projectId,'backup'),files=readZip(Buffer.from(backup));
  const raw=zipPose(files,`raw/${take.takeId}.adpose`);
  assert.ok(framesToPoses(raw,5).poses[0].landmarks[15].x>1.6);
  assert.equal(raw.jointFlags,null);
  const rawBytes=files.get(`raw/${take.takeId}.adpose`)!;
  assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(rawBytes))).toString('hex'),take.provenance?.rawSha256);
  const restored=await store.restore(backup),saved=await store.takeById(restored.projectId,take.takeId);
  assert.deepEqual(saved.samples,take.samples);
  assert.deepEqual(saved.provenance,take.provenance);
});

test('video import can sample at 15 fps', async () => {
  assert.deepEqual([...sampleTimes(200, 0, 15)], [.5 / 15, 1.5 / 15, 2.5 / 15]);
  const diagnostics = newDiagnostics(), seeks: number[] = [], calls: Call[] = [];
  const job = new VideoImporter({ video: video({ duration: .2, videoWidth: 640, videoHeight: 480 }), file: fake<Blob>({}),
    modelId: 'lite', projectId: 'project', assetUrl: () => 'http://localhost/', bitmap,
    createWorker: () => new PoseWorker(diagnostics), decodeFrames: async () => null, sampleRate: 15,
    seek: async (_v, time) => { seeks.push(time); return { mediaTimeMs: time * 1000, timingMethod: 'seek-time' }; },
    request: async (url, options) => { calls.push({ url, body: options?.body }); return { takeId: 'half-rate' }; },
  });
  await job.process('fixture.webm');
  assert.deepEqual(seeks, [...sampleTimes(200, 0, 15)]);
  assert.equal(read(found(calls.find(c => c.url.endsWith('/takes'))).body, 'status', 'targetRateHz'), 15);
  const records = uploadedRecords(calls).flat();
  assert.equal(records.length, 3);
});
