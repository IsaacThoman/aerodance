import { readFileSync } from 'node:fs';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { GameSession } from '../src/game/GameSession.ts';
import type { SessionPlayer } from '../src/game/GameSession.ts';
import { parseRecording, standingPose } from '../src/pose/ReplayPoseSource.ts';
import { PoseSourceController } from '../../packages/pose/browser/PoseSourceController.ts';
import { sampleSong, validateSong, validateSongChoreography } from '../../packages/pose/song.ts';
import type { Landmark } from '../../packages/pose/choreography.ts';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WebcamPoseSource } from '../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseWorker } from '../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from '../../packages/pose/browser/pose.worker.ts';
import { assignPlayerSlots, laneOf, PlayerSlotMapper } from '../../packages/pose/browser/slots.ts';
import { validateWebcamRecord } from '../../packages/pose/webcamRecord.ts';
import type { WebcamRecord } from '../../packages/pose/webcamRecord.ts';

/** A worker response as the test writes it; deliver() adds the session. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type WorkerReply = DistributiveOmit<PoseWorkerResponse, 'sessionId'>;
// What MediaPipe would report for a pose.
const detected = (landmarks: readonly Landmark[]): NormalizedLandmark[] =>
  landmarks.map(({ x, y, z, confidence }) => ({ x, y, z, visibility: confidence ?? 0, presence: confidence ?? undefined }));

const points = (x: number) => Array.from({ length: 33 }, () => ({ x, y: 0.5, z: 0, visibility: 0.95, presence: 0.95 }));
test('two-player slots require consecutive evidence and clear immediately on ambiguity', () => {
  const slots = new PlayerSlotMapper();
  assert.deepEqual(slots.map([points(0.25)], 2), []);
  assert.deepEqual(slots.map([points(0.25)], 2).map(p => p.playerId), [1]);
  assert.deepEqual(slots.map([points(0.25), points(0.3)], 2), []);
  assert.deepEqual(slots.map([points(0.25)], 2), []);
  assert.deepEqual(slots.map([points(0.75)], 2), []);
  assert.deepEqual(slots.map([points(0.75)], 2).map(p => p.playerId), [0]);
});
test('three and four players get one camera lane each, P1 on the left of the mirrored preview', () => {
  // Unmirrored camera x: P1's lane is on the camera's right.
  assert.deepEqual([0.875, 0.625, 0.375, 0.125].map(x => laneOf(x, 4)), [0, 1, 2, 3]);
  assert.deepEqual([0.85, 0.5, 0.15].map(x => laneOf(x, 3)), [0, 1, 2]);
  assert.deepEqual([0.5, 0.26, 0.74].map(x => laneOf(x, 4)), [null, null, null]);
  assert.deepEqual([1 / 3, 2 / 3].map(x => laneOf(x, 3)), [null, null]);
  assert.deepEqual(assignPlayerSlots([points(0.1), points(0.9), points(0.4)], 4).map(p => p.playerId), [0, 2, 3]);
  assert.deepEqual(assignPlayerSlots([points(0.6), points(0.7)], 4), []);
  const slots = new PlayerSlotMapper();
  const all = [points(0.875), points(0.625), points(0.375), points(0.125)];
  assert.deepEqual(slots.map(all, 4), []);
  assert.deepEqual(slots.map(all, 4).map(p => p.playerId), [0, 1, 2, 3]);
  assert.deepEqual(slots.map(all.slice(0, 3), 4).map(p => p.playerId), [0, 1, 2]);
});
test('webcam slots use camera regions, preserve missing dancers and reject ambiguity', () => {
  assert.deepEqual(assignPlayerSlots([points(0.75), points(0.25)], 2).map(p => [p.playerId, p.landmarks[0].x]), [[0, 0.75], [1, 0.25]]);
  assert.deepEqual(assignPlayerSlots([points(0.75)], 2).map(p => p.playerId), [0]);
  assert.deepEqual(assignPlayerSlots([points(0.5)], 2), []);
  assert.deepEqual(assignPlayerSlots([points(0.2), points(0.3)], 2), []);
  assert.deepEqual(assignPlayerSlots([points(0.75)], 1).map(p => p.playerId), [0]);
  const unreliable = points(0.2); unreliable[23].visibility = 0.1;
  assert.deepEqual(assignPlayerSlots([unreliable], 2), []);
  const invalid = points(0.2); invalid[1].x = NaN;
  assert.deepEqual(assignPlayerSlots([invalid], 2), []);
});

// The camera, video and bitmap fakes implement only what WebcamPoseSource uses.
function fixture(t: TestContext) {
  let time = 0, stopped = 0, terminated = 0, plays = 0;
  const videoListeners = new Map<string, () => void>();
  let callback: VideoFrameRequestCallback | null = null;
  const messages: PoseWorkerRequest[] = [];
  const track: Partial<MediaStreamTrack> = { stop() { stopped++; }, addEventListener() {}, getSettings: () => ({ deviceId: 'camera' }) };
  const stream: Partial<MediaStream> = { getTracks: () => [track as MediaStreamTrack], getVideoTracks: () => [track as MediaStreamVideoTrack] };
  const video: Partial<HTMLVideoElement> = { videoWidth: 640, videoHeight: 480, play: async () => { plays++; }, pause() {}, remove() {},
    addEventListener: ((type: string, fn: () => void) => { videoListeners.set(type, fn); }) as HTMLVideoElement['addEventListener'],
    requestVideoFrameCallback(fn) { callback = fn; return 1; }, cancelVideoFrameCallback() { callback = null; } };
  const worker: PoseWorker = { onmessage: null, onerror: null, postMessage: data => { messages.push(data); }, terminate() { terminated++; } };
  const bitmap: Partial<ImageBitmap> = { close() {} };
  const source = new WebcamPoseSource({ now: () => time,
    mediaDevices: { getUserMedia: async () => stream as MediaStream, enumerateDevices: async () => [] },
    createVideo: () => video as HTMLVideoElement, createWorker: () => worker,
    bitmap: async () => bitmap as ImageBitmap, assetUrl: () => 'https://test.invalid/pose-assets/' });
  t.after(() => source.disconnect());
  return { source, worker, stream: stream as MediaStream, track, messages, video,
    get now() { return time; },
    setTime(value: number) { time = value; }, get stopped() { return stopped; }, get terminated() { return terminated; },
    get plays() { return plays; }, videoEvent(type: string) { videoListeners.get(type)?.(); },
    async frame(mediaTime: number, now = mediaTime * 1000) {
      time = now;
      assert.ok(callback, 'a video frame callback is registered');
      callback(now, { mediaTime } as VideoFrameCallbackMetadata);
      await Promise.resolve();
    },
    deliver(data: WorkerReply) {
      assert.ok(worker.onmessage, 'the source listens to its worker');
      worker.onmessage(new MessageEvent('message', { data: { sessionId: source.sessionId, ...data } as PoseWorkerResponse }));
    } };
}
test('webcam backpressure, empty detections, freshness and cleanup', async t => {
  const f = fixture(t); const records: WebcamRecord[] = [];
  f.source.subscribeRecords(e => { if ('record' in e) records.push(e.record); });
  await f.source.connect(); f.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  await f.frame(1); await f.frame(1.03); await f.frame(1.03);
  assert.equal(f.messages.filter(m => m.type === 'frame').length, 1, 'one frame in flight, duplicate callbacks ignored');
  f.setTime(1050); f.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 30 });
  assert.equal(f.source.view.status, 'connected', 'empty result makes pipeline ready');
  assert.deepEqual(f.source.view.snapshot?.poses, []);
  assert.equal(records.length, 1); validateWebcamRecord(records[0]);
  await f.frame(2); f.setTime(2600); f.deliver({ type: 'result', seq: 2, landmarks: [points(0.25)], inferenceMs: 600 });
  assert.equal(f.source.view.snapshot, null); assert.equal(records.length, 1, 'expired results cannot revive tracking');
  const oldHandler = f.worker.onmessage;
  assert.ok(oldHandler);
  f.source.disconnect();
  oldHandler(new MessageEvent('message', { data: { type: 'result', sessionId: f.source.sessionId, seq: 2, landmarks: [points(0.25)], inferenceMs: 30 } }));
  assert.equal(f.source.view.status, 'disconnected');
  assert.equal(f.stopped, 1); assert.equal(f.terminated, 1);
});
test('a permission grant after cancellation releases its camera without starting a worker', async t => {
  const f = fixture(t); let grant: ((stream: MediaStream) => void) | undefined;
  assert.ok(f.source.mediaDevices);
  f.source.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const starting = f.source.connect();
  f.source.disconnect();
  assert.ok(grant);
  grant(f.stream); await starting;
  assert.equal(f.stopped, 1); assert.equal(f.messages.length, 0);
  assert.equal(f.source.view.status, 'disconnected');
});
test('changing a running model resets the session and records the explicit selection', async t => {
  const f = fixture(t);
  await f.source.connect(); const firstSession = f.source.sessionId;
  await f.source.configure({ modelId: 'full' });
  assert.notEqual(f.source.sessionId, firstSession);
  assert.equal(f.source.view.model, 'full');
  assert.equal(f.source.view.snapshot, null);
  assert.equal(f.messages.filter(m => m.type === 'initialize').at(-1)?.modelUrl, 'https://test.invalid/pose-assets/pose_landmarker_full.task');
  assert.equal(f.stopped, 1);
});


test('webcam capture times drive scored gameplay and recordings through the controller, and shutdown is safe', async t => {
  const f = fixture(t);
  const source = new PoseSourceController({ webcam: f.source });
  await source.connect(); f.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  const dir = new URL('./fixtures/song-70c63c8e/', import.meta.url);
  const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  const song = validateSong(read('song.json'));
  const bundle = { song, choreography: validateSongChoreography(song, readFileSync(new URL('choreography.adpose', dir))), audio: new Blob([]), cover: null };
  let songStart = 0;
  // Only play and songTimeAt matter here: the test never updates the session.
  const player: SessionPlayer = { state: 'paused', ended: false, play() { this.state = 'playing'; songStart = f.now; },
    songTimeAt: perf => perf - songStart + bundle.song.playableStartMs, timeMs: () => 0, rawTimeMs: () => 0,
    pause() {}, seek() {}, dispose() {} };
  const session = new GameSession({ bundle, playerCount: 1, source,
    createPlayer: async () => player, now: () => f.now, record: true, autoStart: false });
  t.after(() => session.dispose());
  await session.load();
  assert.equal(session.phase, 'calibrating');
  let seq = 0;
  for (let ms = 0; ms <= 2500; ms += 100) {
    await f.frame(ms / 1000, ms);
    f.setTime(ms + 100);
    f.deliver({ type: 'result', seq: ++seq, landmarks: [detected(standingPose(0.5))], inferenceMs: 100 });
  }
  assert.equal(session.phase, 'ready');
  // Read through a function: start() replaces the recording.
  const recording = () => session.recording;
  assert.equal(recording(), null, 'calibration poses are excluded from song recordings');
  session.start();
  const calibrationFrames = seq;
  for (let ms = bundle.song.playableStartMs; ms < bundle.song.playableEndMs; ms += 100) {
    const capture = songStart + ms - bundle.song.playableStartMs;
    await f.frame(capture / 1000, capture);
    f.setTime(capture + 300);
    f.deliver({ type: 'result', seq: ++seq,
      landmarks: sampleSong(bundle, ms, 1).poses.map(p => detected(p.landmarks)), inferenceMs: 300 });
  }
  session.scorer.finish();
  assert.ok(session.scorer.result(0).score > 950000, `webcam score ${session.scorer.result(0).score}`);
  assert.doesNotThrow(() => source.disconnect(), 'camera shutdown reaches game and recorder safely');
  const recorder = recording();
  assert.ok(recorder);
  const { header, entries } = parseRecording(recorder.stop());
  session.recording = null;
  assert.equal(entries.length, seq - calibrationFrames);
  assert.equal(entries[0].songTimeMs, bundle.song.playableStartMs, 'recorded at capture, not arrival');
  assert.equal(header.timing, 'browser-frame-observation');
});
test('a stalled camera says whether its pictures or the model stopped, and a paused video plays again', async t => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 150));
  const f = fixture(t);
  await f.source.connect(); f.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  await f.frame(1); f.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 30 });
  assert.equal(f.source.view.status, 'connected');
  // The browser pausing the hidden video (Safari does) plays it again.
  const plays = f.plays;
  f.videoEvent('pause');
  assert.equal(f.plays, plays + 1);
  // Pictures keep coming but the model never answers.
  await f.frame(2); for (let s = 3; s <= 12; s++) await f.frame(s);
  await tick();
  assert.equal(f.source.view.status, 'error');
  assert.match(f.source.view.message, /^Camera tracking stopped responding/);
  // No pictures at all.
  const g = fixture(t);
  await g.source.connect(); g.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  await g.frame(1); g.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 30 });
  g.setTime(12_000); await tick();
  assert.equal(g.source.view.status, 'error');
  assert.match(g.source.view.message, /^The camera stopped sending pictures/);
  // A pause after stopping is left alone.
  const after = g.plays;
  g.videoEvent('pause');
  assert.equal(g.plays, after);
});
test('frames from a camera whose frame metadata never advances (Safari) are still tracked by the video clock', async t => {
  const f = fixture(t);
  await f.source.connect(); f.deliver({ type: 'ready', delegate: 'GPU', fallback: '' });
  const sent = () => f.messages.filter(m => m.type === 'frame') as Extract<PoseWorkerRequest, { type: 'frame' }>[];
  for (let i = 1; i <= 3; i++) {
    Object.assign(f.video, { currentTime: i / 30 });
    await f.frame(0, i * 33);
    f.deliver({ type: 'result', seq: i, landmarks: [], inferenceMs: 5 });
  }
  assert.deepEqual(sent().map(m => Math.round(m.timestampMs)), [0, 67, 100], 'each new frame goes to the model, timed by currentTime once mediaTime stops advancing');
  // A repeat of the same picture is still skipped.
  await f.frame(0, 120);
  assert.equal(sent().length, 3);
});
