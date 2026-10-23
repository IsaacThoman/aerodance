import { readFileSync } from 'node:fs';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { GameSession } from '../src/game/GameSession.ts';
import type { SessionPlayer } from '../src/game/GameSession.ts';
import { parseRecording, standingPose } from '../src/pose/ReplayPoseSource.ts';
import { PoseSourceController } from '../../../packages/pose/browser/PoseSourceController.ts';
import { sampleSong, validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import type { Landmark } from '../../../packages/pose/choreography.ts';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WebcamPoseSource } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseWorker, WebcamPoseSourceOptions } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from '../../../packages/pose/browser/pose.worker.ts';
import { assignPlayerSlots, laneOf, PlayerSlotMapper } from '../../../packages/pose/browser/slots.ts';
import { validateWebcamRecord } from '../../../packages/pose/webcamRecord.ts';
import { cameraTurn, hostState } from '../src/host.ts';
import type { Orientation } from '../src/host.ts';
import type { WebcamRecord } from '../../../packages/pose/webcamRecord.ts';

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
function fixture(t: TestContext, options: WebcamPoseSourceOptions = {}) {
  let time = 0, stopped = 0, terminated = 0, plays = 0, opened = 0;
  const videoListeners = new Map<string, () => void>();
  // The camera track's events (ended, mute, unmute); muted as WebKit sets it.
  const trackListeners = new Map<string, (() => void)[]>();
  let callback: VideoFrameRequestCallback | null = null;
  const messages: PoseWorkerRequest[] = [];
  const track = { muted: false, stop() { stopped++; }, getSettings: () => ({ deviceId: 'camera' }),
    addEventListener: ((type: string, fn: () => void, options?: { once?: boolean }) => {
      const once = () => { trackListeners.set(type, (trackListeners.get(type) ?? []).filter(f => f !== once)); fn(); };
      trackListeners.set(type, [...trackListeners.get(type) ?? [], options?.once ? once : fn]);
    }) as MediaStreamTrack['addEventListener'] };
  const stream: Partial<MediaStream> = { getTracks: () => [track as MediaStreamTrack], getVideoTracks: () => [track as MediaStreamVideoTrack] };
  const video: Partial<HTMLVideoElement> = { videoWidth: 640, videoHeight: 480, play: async () => { plays++; }, pause() {}, remove() {},
    addEventListener: ((type: string, fn: () => void) => { videoListeners.set(type, fn); }) as HTMLVideoElement['addEventListener'],
    requestVideoFrameCallback(fn) { callback = fn; return 1; }, cancelVideoFrameCallback() { callback = null; } };
  const worker: PoseWorker = { onmessage: null, onerror: null, postMessage: data => { messages.push(data); }, terminate() { terminated++; } };
  const bitmap: Partial<ImageBitmap> = { close() {} };
  const source = new WebcamPoseSource({ now: () => time,
    mediaDevices: { getUserMedia: async () => { opened++; return stream as MediaStream; }, enumerateDevices: async () => [] },
    createVideo: () => video as HTMLVideoElement, createWorker: () => worker,
    bitmap: async () => bitmap as ImageBitmap, assetUrl: () => 'https://test.invalid/pose-assets/', ...options });
  t.after(() => source.disconnect());
  return { source, worker, stream: stream as MediaStream, track: track as Partial<MediaStreamTrack>, messages, video,
    get now() { return time; },
    setTime(value: number) { time = value; }, get stopped() { return stopped; }, get terminated() { return terminated; },
    get plays() { return plays; }, get opened() { return opened; }, videoEvent(type: string) { videoListeners.get(type)?.(); },
    /** WebKit muting or unmuting the camera (track.muted changes first). */
    trackEvent(type: 'mute' | 'unmute' | 'ended') {
      if (type !== 'ended') track.muted = type === 'mute';
      for (const fn of trackListeners.get(type) ?? []) fn();
    },
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
  const bundle = { song, choreography: validateSongChoreography(song, readFileSync(new URL('choreography.adpose', dir))), audio: new Blob([]), cover: null, scoreId: song.songId };
  let songStart = 0;
  // Only play and songTimeAt matter here: the test never updates the session.
  const player: SessionPlayer = { state: 'paused', ended: false, endMs: bundle.song.playableEndMs, play() { this.state = 'playing'; songStart = f.now; },
    songTimeAt: perf => perf - songStart + bundle.song.playableStartMs, timeMs: () => 0, rawTimeMs: () => 0,
    audioRunning: () => true, pause() {}, seek() {}, dispose() {} };
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
test('in the app, the camera picture turns upright the way the device is held, not the way the TV is', () => {
  const tall = { width: 480, height: 640 }, wide = { width: 640, height: 480 };
  // An iPhone on a TV: its remote is upright, so WebKit turns the picture upright for an upright phone.
  const onTV = (held: Orientation) => ({ ...hostState(), screen: 'tv' as const, held, screens: { game: 0 as const, phone: 0 as const } });
  assert.deepEqual([0, 90, -90, 180].map(held => cameraTurn({ ...tall, facing: 'environment' }, onTV(held as Orientation))), [0, 270, 90, 180],
    'the back camera turns back against the phone: counterclockwise when it is turned counterclockwise');
  assert.deepEqual([0, 90, -90, 180].map(held => cameraTurn({ ...tall, facing: 'user' }, onTV(held as Orientation))), [0, 90, 270, 180],
    'the front camera, facing the other way, the other way round');
  assert.equal(cameraTurn({ ...tall }, onTV(90)), 0, 'a camera facing neither way (plugged in) stays as it is');
  // An iPad on a TV, sideways: WebKit may have turned the picture for the TV's screen or the iPad's.
  const iPad = { ...onTV(90), screens: { game: 0 as const, phone: 90 as const } };
  assert.equal(cameraTurn({ ...tall, facing: 'environment' }, iPad), 270, 'upright for the TV');
  assert.equal(cameraTurn({ ...wide, facing: 'environment' }, iPad), 0, 'upright for the iPad, which is held that way');
  // The game on an iPhone, sideways like its screen.
  const phone = { ...hostState(), held: -90 as const, screens: { game: -90 as const, phone: -90 as const } };
  assert.equal(cameraTurn({ ...wide, facing: 'user' }, phone), 0);
});
test('a turned camera tracks and previews its picture turned upright, and a turn of the device carries on at the new size', async t => {
  let turn = 270;
  const asked: unknown[] = [], drawn: unknown[][] = [], tracked: unknown[] = [];
  const g = { setTransform() {}, rotate(angle: number) { drawn.push(['rotate', Math.round(angle * 180 / Math.PI)]); },
    drawImage(...args: unknown[]) { drawn.push(['drawImage', ...args.slice(1)]); } };
  const canvas = { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement;
  const f = fixture(t, { adaptToResize: true, createCanvas: () => canvas,
    turn: frame => { asked.push(frame); return turn; }, bitmap: async picture => { tracked.push(picture); return { close() {} } as ImageBitmap; } });
  f.track.getSettings = () => ({ deviceId: 'camera', facingMode: 'environment' });
  const records: WebcamRecord[] = [];
  f.source.subscribeRecords(e => { if ('record' in e) records.push(e.record); });
  await f.source.connect(); f.deliver({ type: 'ready', delegate: 'GPU', fallback: '' });
  assert.deepEqual(asked[0], { width: 640, height: 480, facing: 'environment' });
  assert.deepEqual(f.source.picture, { image: canvas, width: 480, height: 640 }, 'the preview shows the turned picture');
  assert.deepEqual(drawn.slice(0, 2), [['rotate', 270], ['drawImage', -320, -240, 640, 480]]);
  await f.frame(1); f.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 5 });
  assert.equal(tracked[0], canvas, 'tracking gets the turned picture');
  assert.deepEqual(records[0].input, { width: 480, height: 640, mirrored: false });
  // The device turns upright again: the picture is the video's own, at its own size.
  turn = 0;
  await f.frame(2); f.deliver({ type: 'result', seq: 2, landmarks: [], inferenceMs: 5 });
  assert.equal(f.source.picture, f.video);
  assert.equal(tracked[1], f.video);
  assert.deepEqual(records[1].input, { width: 640, height: 480, mirrored: false });
  assert.equal(f.source.view.status, 'connected');
  f.source.disconnect();
  assert.equal(f.source.picture, null);
  // Without adaptToResize (a browser's webcam), a new size needs a new calibration.
  const h = fixture(t, { createCanvas: () => canvas, turn: () => turn });
  turn = 0;
  await h.source.connect(); h.deliver({ type: 'ready', delegate: 'GPU', fallback: '' });
  turn = 90;
  await h.frame(1);
  assert.equal(h.source.view.status, 'error');
  assert.match(h.source.view.message, /^Camera dimensions changed/);
});
test('a muted camera says it was interrupted instead of looking empty, and tracks again on unmute without restarting', async t => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 150));
  // As in the iPhone/iPad app (apps/web/src/pose/CameraInput.ts), which waits for iOS to give it back.
  const f = fixture(t, { interruptedTimeoutMs: Infinity }); const records: WebcamRecord[] = [];
  f.source.subscribeRecords(e => { if ('record' in e) records.push(e.record); });
  await f.source.connect(); f.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  const session = f.source.sessionId;
  await f.frame(1); f.setTime(1050); f.deliver({ type: 'result', seq: 1, landmarks: [points(0.25)], inferenceMs: 30 });
  assert.equal(f.source.view.status, 'connected');
  // A frame is in flight when iOS takes the camera for a phone call.
  await f.frame(2);
  f.trackEvent('mute');
  assert.equal(f.source.view.interrupted, true);
  assert.equal(f.source.view.status, 'initializing', 'not connected, so nobody reads as out of view');
  assert.equal(f.source.view.snapshot, null);
  assert.match(f.source.view.message, /^The camera was interrupted/);
  f.setTime(2050); f.deliver({ type: 'result', seq: 2, landmarks: [points(0.25)], inferenceMs: 30 });
  assert.equal(f.source.view.status, 'initializing', 'a frame from before the mute does not reconnect it');
  assert.equal(records.length, 1);
  // Muted for longer than the watchdog allows: still waiting, not failed.
  f.setTime(20_000); await tick();
  assert.equal(f.source.view.status, 'initializing');
  assert.equal(f.source.view.interrupted, true);
  f.trackEvent('unmute');
  assert.equal(f.source.view.interrupted, false);
  await f.frame(21, 21_000); f.setTime(21_050); f.deliver({ type: 'result', seq: 3, landmarks: [points(0.25)], inferenceMs: 30 });
  assert.equal(f.source.view.status, 'connected');
  assert.equal(records.length, 2);
  assert.equal(f.source.sessionId, session, 'the same camera and session carry on');
  assert.equal(f.opened, 1); assert.equal(f.stopped, 0);
  // Unplugging still fails as before.
  f.trackEvent('ended');
  assert.equal(f.source.view.status, 'error');
  assert.equal(f.source.view.interrupted, false);
});
test('a camera that starts muted (iOS has it for a call) waits for it before tracking', async t => {
  const f = fixture(t, { interruptedTimeoutMs: Infinity });
  Object.assign(f.track, { muted: true });
  const starting = f.source.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.source.view.interrupted, true);
  assert.equal(f.messages.length, 0, 'no model loads for a camera iOS is holding');
  f.trackEvent('unmute');
  await starting;
  assert.equal(f.source.view.interrupted, false);
  assert.equal(f.messages[0]?.type, 'initialize');
  // Stopping while still waiting releases the camera.
  const g = fixture(t, { interruptedTimeoutMs: Infinity });
  Object.assign(g.track, { muted: true });
  const waiting = g.source.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  g.source.disconnect();
  await waiting;
  assert.equal(g.stopped, 1); assert.equal(g.messages.length, 0);
  assert.equal(g.source.view.status, 'disconnected'); assert.equal(g.source.view.interrupted, false);
});
test('in a browser, a camera muted for longer than the watchdog allows fails like a stalled one (Chrome mutes a stall)', async t => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 150));
  const f = fixture(t);
  await f.source.connect(); f.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  await f.frame(1); f.setTime(1050); f.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 30 });
  f.trackEvent('mute');
  assert.equal(f.source.view.interrupted, true);
  assert.equal(f.source.view.message, 'The camera stopped sending pictures.', 'a browser promises nothing');
  // A short stall comes back and tracks on.
  f.setTime(9_000); await tick();
  assert.equal(f.source.view.status, 'initializing');
  f.trackEvent('unmute');
  await f.frame(9, 9_000); f.setTime(9_050); f.deliver({ type: 'result', seq: 2, landmarks: [], inferenceMs: 30 });
  assert.equal(f.source.view.status, 'connected');
  // A long one fails to Start camera, as the watchdog did before mutes were watched.
  f.trackEvent('mute');
  f.setTime(19_000); await tick();
  assert.equal(f.source.view.status, 'initializing', 'not before the 10 s are up');
  f.setTime(19_100); await tick();
  assert.equal(f.source.view.status, 'error');
  assert.equal(f.source.view.interrupted, false);
  assert.equal(f.source.view.message, 'The camera stopped sending pictures. Start camera to retry.');
  assert.equal(f.stopped, 1, 'the camera is released');
  // So does one that starts muted and stays so.
  const g = fixture(t);
  Object.assign(g.track, { muted: true });
  const starting = g.source.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(g.source.view.interrupted, true);
  g.setTime(10_100); await tick();
  await starting;
  assert.equal(g.source.view.status, 'error');
  assert.match(g.source.view.message, /^The camera stopped sending pictures/);
});
test('a camera that unmutes but sends nothing fails instead of waiting forever, even after it had tracked', async t => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 150));
  for (const interruptedTimeoutMs of [Infinity, undefined]) {
    const f = fixture(t, { interruptedTimeoutMs });
    await f.source.connect(); f.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
    await f.frame(1); f.setTime(1050); f.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 30 });
    f.trackEvent('mute'); f.setTime(5_000); f.trackEvent('unmute');
    assert.equal(f.source.view.status, 'initializing');
    // The silence counts from the unmute.
    f.setTime(14_900); await tick();
    assert.equal(f.source.view.status, 'initializing');
    f.setTime(15_100); await tick();
    assert.equal(f.source.view.status, 'error', `interruptedTimeoutMs ${interruptedTimeoutMs}`);
    assert.match(f.source.view.message, /^The camera stopped sending pictures/);
  }
  // Pictures that come but are never tracked say the model stopped instead.
  const g = fixture(t, { interruptedTimeoutMs: Infinity });
  await g.source.connect(); g.deliver({ type: 'ready', delegate: 'CPU', fallback: '' });
  await g.frame(1); g.setTime(1050); g.deliver({ type: 'result', seq: 1, landmarks: [], inferenceMs: 30 });
  await g.frame(2); g.trackEvent('mute'); g.setTime(5_000); g.trackEvent('unmute');
  for (let s = 6; s <= 15; s++) await g.frame(s);
  g.setTime(15_100); await tick();
  assert.equal(g.source.view.status, 'error');
  assert.match(g.source.view.message, /^Camera tracking stopped responding/);
});
