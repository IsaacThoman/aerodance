import { test } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../web/recorder.ts";
import type { RecorderTransport } from "../web/recorder.ts";
import type { WebcamRecordEvent } from "../../../packages/pose/browser/WebcamPoseSource.ts";
import type { WebcamRecord } from "../../../packages/pose/webcamRecord.ts";
import { EXTENSION, framesToPoses } from "../../../packages/pose/binary.ts";
import type { CaptureMode } from '../web/captureMode.ts';
import { found, uploadedFrames } from "./helpers.ts";
import type { Call } from "./helpers.ts";

const transport = (fields: Partial<RecorderTransport>): RecorderTransport => ({
  active: false, rate: 1, positionMs: 0, startTime: 0, audioAnchor: null,
  current: () => 0, atBrowserTime: time => time, ...fields,
});
test('solo recording writes the selected logical player into its own slot and rejects mode changes', async t => {
  for (const captureMode of ['p1', 'p2', 'p3', 'p4'] as const satisfies readonly CaptureMode[]) {
    const playerId = Number(captureMode[1]) - 1;
    let listener: ((event: WebcamRecordEvent) => void) | undefined;
    const calls: Call[] = [], failures: string[] = [], input = { width: 640, height: 480, mirrored: false };
    const recorder = new Recorder({ captureMode, dancers: 4, source: {
      view: { sourceKind: 'webcam', model: 'lite', snapshot: { sessionId: 'solo', input } },
      subscribeRecords(callback) { listener = callback; return () => {}; },
    }, transport: transport({}), projectId: 'project', onFailure: message => failures.push(message),
    request: async (url, options) => { calls.push({ url, body: options?.body }); return { takeId: 'solo' }; } });
    await recorder.start(); t.after(() => clearInterval(recorder.timer));
    const emit = found(listener);
    for (let i = 0; i < 2; i++) {
      const record: WebcamRecord = { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'solo', seq: i + 1,
        modelId: 'lite', playerCount: 1, input, mediaTimeMs: i * 100, frameBrowserTimeMs: i * 100,
        resultBrowserTimeMs: i * 100, timingMethod: 'browser-frame-observation',
        poses: [{ playerId: 0, landmarks: Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, confidence: .9 })) }] };
      emit({ record, receivedBrowserTimeMs: performance.now(), captureBrowserTimeMs: record.frameBrowserTimeMs, timing: { method: record.timingMethod } });
      if (i === 1) emit({ record: { ...record, playerCount: 2 }, receivedBrowserTimeMs: performance.now(), captureBrowserTimeMs: record.frameBrowserTimeMs, timing: { method: record.timingMethod } });
    }
    await recorder.stop();
    const batches = uploadedFrames(calls);
    // One slot each up to the solo dancer's own: P3 alone needs three.
    assert.ok(batches.every(b => b.playerSlots === playerId + 1), captureMode);
    const poses = batches.flatMap(b => Array.from(b.times, (_, i) => framesToPoses(b, i).poses).flat());
    assert.equal(poses.length, 2);
    assert.ok(poses.every(p => p.playerId === playerId));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /player mode/);
  }
});

test('recording all of a song\'s dancers keeps each in their own slot', async t => {
  for (const dancers of [3, 4]) {
    let listener: ((event: WebcamRecordEvent) => void) | undefined;
    const calls: Call[] = [], failures: string[] = [], input = { width: 640, height: 480, mirrored: false };
    const recorder = new Recorder({ captureMode: 'all', dancers, source: {
      view: { sourceKind: 'webcam', model: 'lite', snapshot: { sessionId: 'group', input } },
      subscribeRecords(callback) { listener = callback; return () => {}; },
    }, transport: transport({}), projectId: 'project', onFailure: message => failures.push(message),
    request: async (url, options) => { calls.push({ url, body: options?.body }); return { takeId: 'group' }; } });
    await recorder.start(); t.after(() => clearInterval(recorder.timer));
    assert.equal((found(calls[0]).body as { header: { playerCount: number } }).header.playerCount, dancers);
    const emit = found(listener);
    const ids = Array.from({ length: dancers }, (_, id) => id);
    for (let i = 0; i < 2; i++) {
      const record: WebcamRecord = { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'group', seq: i + 1,
        modelId: 'lite', playerCount: dancers as 3 | 4, input, mediaTimeMs: i * 100, frameBrowserTimeMs: i * 100,
        resultBrowserTimeMs: i * 100, timingMethod: 'browser-frame-observation',
        poses: ids.map(playerId => ({ playerId, landmarks: Array.from({ length: 33 }, () => ({ x: (playerId + .5) / dancers, y: .5, z: 0, confidence: .9 })) })) };
      emit({ record, receivedBrowserTimeMs: performance.now(), captureBrowserTimeMs: record.frameBrowserTimeMs, timing: { method: record.timingMethod } });
    }
    await recorder.stop();
    const batches = uploadedFrames(calls);
    assert.ok(batches.every(b => b.playerSlots === dancers));
    assert.deepEqual(batches.flatMap(b => Array.from(b.times, (_, i) => framesToPoses(b, i).poses.map(p => p.playerId))), [ids, ids]);
    assert.deepEqual(failures, []);
  }
});

test('webcam recorder preserves its session across startup snapshot expiry and uses the frame audio anchor', async t => {
  let listener: ((event: WebcamRecordEvent) => void) | undefined;
  const calls: Call[] = [], input = { width: 640, height: 480, mirrored: false };
  const recorder = new Recorder({ source: {
    view: { sourceKind: 'webcam', model: 'lite', modelConfig: { modelId: 'lite' }, snapshot: { sessionId: 'webcam', input } },
    subscribeRecords(callback) { listener = callback; return () => {}; },
  }, transport: transport({ active: true, current: () => 2500, atBrowserTime: time => time - 1000 }),
  request: async (url, options) => {
    if (url.endsWith('/takes')) recorder.source.view = { ...recorder.source.view, snapshot: null };
    calls.push({ url, body: options?.body });
    return { takeId: 'webcam' };
  },
  projectId: 'project', onFailure: message => assert.fail(message) });
  await recorder.start(); t.after(() => clearInterval(recorder.timer));
  assert.ok(listener);
  const emit = listener;
  const record: WebcamRecord = { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'webcam', seq: 1, modelId: 'lite', playerCount: 2, input,
    mediaTimeMs: 0, frameBrowserTimeMs: 950, resultBrowserTimeMs: 950, timingMethod: 'browser-frame-observation', poses: [] };
  const event = (record: WebcamRecord): WebcamRecordEvent =>
    ({ record, receivedBrowserTimeMs: performance.now(), captureBrowserTimeMs: record.frameBrowserTimeMs, timing: { method: record.timingMethod } });
  emit(event(record));
  assert.equal(recorder.poseCount, 0);
  for (const [i, frameBrowserTimeMs] of [1000, 1100].entries())
    emit(event({ ...record, seq: i + 2, frameBrowserTimeMs, resultBrowserTimeMs: frameBrowserTimeMs, mediaTimeMs: frameBrowserTimeMs - 950 }));
  await recorder.stop();
  const batches = uploadedFrames(calls);
  const frameTimes = batches.flatMap(f => Array.from(found(f.extensions.get(EXTENSION.audioPositionAtFrameMs))));
  assert.deepEqual(frameTimes, [0, 100]);
  assert.deepEqual(batches.flatMap(f => f.events.map(e => e.type)), ['audio-start-scheduled', 'audio-stop']);
  assert.equal(found(calls.at(-1)).url.endsWith('/finalize'), true);
  assert.deepEqual(found(calls.at(-1)).body, { batchCount: 1, recordCount: 4, interruptionReason: null });
});

test("cancelling a countdown unsubscribes and does not finalize an empty take", async (t) => {
  let unsubscribed = false;
  const requests: string[] = [];
  const recorder = new Recorder({
    source: {
      view: { sourceKind: "webcam", model: "lite", snapshot: { sessionId: "webcam", input: { width: 640, height: 480 } } },
      subscribeRecords: () => () => { unsubscribed = true; },
    },
    transport: transport({ current: () => -3000 }),
    projectId: "project",
    request: async (url) => {
      requests.push(url);
      return { takeId: "cancelled" };
    },
    onFailure: (message) => assert.fail(message),
  });
  await recorder.start();
  t.after(() => clearInterval(recorder.timer));
  assert.equal(await recorder.stop(), null);
  assert.equal(recorder.running, false);
  assert.equal(unsubscribed, true);
  assert.equal(requests.some((url) => url.endsWith("/finalize")), false);
});
test("recording needs a camera session", async () => {
  const recorder = new Recorder({
    source: { view: { snapshot: null }, subscribeRecords: () => () => {} },
    transport: transport({}), projectId: "project", request: async () => ({ takeId: "never" }),
    onFailure: (message) => assert.fail(message),
  });
  await assert.rejects(recorder.start(), /Start the camera/);
});
