import { test } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../web/recorder.ts";
import type { RecorderTransport } from "../web/recorder.ts";
import type { WebcamRecordEvent } from "../../../packages/pose/browser/WebcamPoseSource.ts";
import type { WebcamRecord } from "../../../packages/pose/webcamRecord.ts";
import { EXTENSION } from "../../../packages/pose/binary.ts";
import { found, uploadedFrames } from "./helpers.ts";
import type { Call } from "./helpers.ts";

const transport = (fields: Partial<RecorderTransport>): RecorderTransport => ({
  active: false, rate: 1, positionMs: 0, startTime: 0, audioAnchor: null,
  current: () => 0, atBrowserTime: time => time, ...fields,
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
