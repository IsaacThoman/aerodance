import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhonePoseSource } from '../src/pose/PhonePoseSource.ts';
import { CameraInput, NO_CAMERA, PHONE_CAMERA } from '../src/pose/CameraInput.ts';
import { isPoseRecordEvent } from '../src/pose/PoseSource.ts';
import type { PoseSourceEvent } from '../src/pose/PoseSource.ts';
import { standingPose } from '../src/pose/ReplayPoseSource.ts';
import { PhoneLink, deviceName, linkCode } from '../src/phone/PhoneLink.ts';
import { PoseSourceController } from '../../packages/pose/browser/PoseSourceController.ts';
import type { WebcamConfigureOptions, WebcamPoseSource, WebcamRecordEvent, WebcamView } from '../../packages/pose/browser/WebcamPoseSource.ts';
import type { WebcamRecord } from '../../packages/pose/webcamRecord.ts';
import type { PlayerCount } from '../../packages/pose/choreography.ts';
import { FakeConnection, createFakeConnection, fetchEventStream, pairingServer, relayProxy, until } from './fixtures/fakePairing.ts';
import { SignalChannel } from '../../packages/pairing/browser/signalChannel.ts';
import type { EventStream } from '../../packages/pairing/browser/signalChannel.ts';
import type { PairingEvent } from '../../packages/pairing/signals.ts';
import type { PreviewFrame } from '../../packages/pose/browser/preview.ts';

/** The phone's camera, driven by the test: it emits whatever records the test gives it. */
class FakeCamera {
  view: WebcamView = { status: 'disconnected', sourceKind: 'webcam', snapshot: null, configuring: false, message: 'Camera off',
    model: 'lite', cameraId: '', cameras: [], stats: null };
  video = null;
  playerCount: PlayerCount = 1;
  configured: WebcamConfigureOptions[] = [];
  listeners = new Set<(view: WebcamView) => void>();
  recordListeners = new Set<(event: WebcamRecordEvent) => void>();
  subscribe(fn: (view: WebcamView) => void) { this.listeners.add(fn); fn(this.view); return () => this.listeners.delete(fn); }
  subscribeRecords(fn: (event: WebcamRecordEvent) => void) { this.recordListeners.add(fn); return () => this.recordListeners.delete(fn); }
  publish(patch: Partial<WebcamView>) { this.view = { ...this.view, ...patch }; for (const fn of this.listeners) fn(this.view); }
  async connect() { this.publish({ status: 'connected', message: 'Lite · GPU · 30.0 poses/s · Step into view.', delegate: 'GPU' }); }
  disconnect(message = 'Camera stopped.') { this.publish({ status: 'disconnected', message }); }
  async configure(options: WebcamConfigureOptions) {
    this.configured.push(options);
    this.publish({ ...(options.modelId ? { model: options.modelId as WebcamView['model'] } : {}), ...(options.facing ? { facing: options.facing } : {}),
      ...(options.cameraId !== undefined ? { cameraId: options.cameraId } : {}) });
  }
  async setPlayerCount(count: PlayerCount) { this.playerCount = count; }
  emit(record: WebcamRecord) {
    for (const fn of this.recordListeners) fn({ record, receivedBrowserTimeMs: record.resultBrowserTimeMs, captureBrowserTimeMs: record.frameBrowserTimeMs, timing: { method: record.timingMethod } });
  }
}

const noDecode = async () => ({ image: {} as CanvasImageSource, width: 1, height: 1 });
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });

// The phone's clock started 50 seconds before the game's.
const PHONE_AHEAD_MS = 50_000;
const phoneNow = () => performance.now() + PHONE_AHEAD_MS;
let seq = 0;
const phoneRecord = (ageMs: number, playerCount: PlayerCount = 2, sessionId = 'phone-session'): WebcamRecord => {
  const at = phoneNow();
  return { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId, seq: ++seq, playerCount,
    input: { width: 480, height: 640, mirrored: false }, modelId: 'lite', mediaTimeMs: seq * 33,
    frameBrowserTimeMs: at - ageMs, resultBrowserTimeMs: at - 2, timingMethod: 'browser-frame-observation',
    poses: [{ playerId: 0, landmarks: standingPose(0.7) }] };
};

test('a phone pairs with the game, tracks for it on the game’s clock, reconnects and is told when pairing ends', async (t) => {
  const base = await pairingServer(t);
  const options = { base, createStream: fetchEventStream, createConnection: createFakeConnection };
  const host = new PhonePoseSource({ ...options, origin: () => 'https://game.test' });
  const events: PoseSourceEvent[] = [];
  host.subscribeRecords((event) => events.push(event));
  const camera = new FakeCamera();
  const phone = new PhoneLink({ ...options, camera: camera as unknown as WebcamPoseSource, now: phoneNow, device: 'Test phone' });
  t.after(() => { host.disconnect(); phone.stop(); });

  await host.connect();
  const pairing = await until(() => host.view.pairing, 'a pairing code');
  assert.equal(host.view.status, 'connecting');
  assert.equal(pairing.url, `https://game.test/pair/#${pairing.code}`);
  assert.equal(linkCode(new URL(pairing.url)), pairing.code);

  await phone.join(pairing.code);
  await until(() => phone.view.stage === 'linked', 'the phone to link');
  // The back camera by default, started once linked; its status reaches the game.
  assert.equal(camera.view.facing, 'environment');
  await until(() => host.view.message.startsWith('Test phone: Lite'), 'the phone’s status');
  assert.equal(host.view.status, 'initializing');
  assert.equal(host.view.device, 'Test phone');

  await host.setPlayerCount(2);
  await until(() => camera.playerCount === 2 && phone.view.playerCount === 2, 'the player count');
  // The phone only tracks with Lite, and tells the game so.
  await host.configure({ modelId: 'full' });
  await until(() => host.view.model === 'lite', 'the phone to report its model');
  assert.ok(!camera.configured.some((c) => c.modelId === 'full'));

  // Poses wait for the clocks to line up, then arrive on the game's clock.
  await until(() => host.clock.ready, 'clock sync', 4000);
  const sent = phoneRecord(30);
  camera.emit(sent);
  const event = await until(() => events.find(isPoseRecordEvent), 'a pose');
  assert.equal('timingMethod' in event.record && event.record.timingMethod, 'remote-clock-sync');
  assert.equal(event.timing.method, 'remote-clock-sync');
  assert.ok(Math.abs(event.captureBrowserTimeMs - (sent.frameBrowserTimeMs - PHONE_AHEAD_MS)) < 15, 'capture time on the game’s clock');
  assert.ok(event.captureBrowserTimeMs <= event.receivedBrowserTimeMs);
  assert.equal(host.view.status, 'connected');
  assert.deepEqual(host.view.frame, { width: 480, height: 640 });

  // Stale, out-of-order and wrong-player-count records are dropped.
  camera.emit(phoneRecord(900));
  camera.emit({ ...phoneRecord(10), seq: 1 });
  camera.emit(phoneRecord(10, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.filter(isPoseRecordEvent).length, 1);

  host.setPlaying(true);
  await until(() => phone.view.playing, 'the song to start on the phone');

  // The network drops: the phone asks again and the game reconnects with a new attempt.
  const epoch = host.epoch;
  const connection = FakeConnection.all.find((c) => c.localDescription?.sdp?.startsWith('fake-answer') && c.connectionState === 'connected');
  assert.ok(connection);
  connection.fail();
  await until(() => host.epoch > epoch && phone.view.stage === 'linked' && host.control?.readyState === 'open', 'reconnection');
  await until(() => host.clock.ready, 'clock sync again', 4000);
  camera.emit(phoneRecord(20));
  await until(() => events.filter(isPoseRecordEvent).length === 2, 'poses after reconnecting');

  host.disconnect();
  await until(() => phone.view.stage === 'ended', 'the phone to hear pairing ended');
  assert.match(phone.view.message, /closed the pairing/);
  assert.equal(camera.view.status, 'disconnected');
});

test('a wrong code is refused on the phone, and a second phone cannot take over a paired game', async (t) => {
  const base = await pairingServer(t);
  const options = { base, createStream: fetchEventStream, createConnection: createFakeConnection };
  const host = new PhonePoseSource({ ...options, origin: () => 'https://game.test' });
  const first = new PhoneLink({ ...options, camera: new FakeCamera() as unknown as WebcamPoseSource });
  const second = new PhoneLink({ ...options, camera: new FakeCamera() as unknown as WebcamPoseSource });
  t.after(() => { host.disconnect(); first.stop(); second.stop(); });
  await first.join('000000');
  assert.equal(first.view.stage, 'code');
  assert.match(first.view.error, /No game is waiting/);

  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await first.join(code);
  await until(() => first.view.stage === 'linked', 'the first phone');
  // Each phone keeps its token in its own tab's session storage; Node shares one.
  globalThis.sessionStorage?.clear();
  await second.join(code);
  assert.equal(second.view.stage, 'code');
  assert.match(second.view.error, /Another phone/);

  // Leaving frees the code for another phone.
  first.leave();
  await until(() => host.view.status === 'connecting', 'the game to notice');
  await second.join(code);
  await until(() => second.view.stage === 'linked', 'the second phone');
});

test('a linked phone and game carry on when the pairing server goes away, and end together', async (t) => {
  const base = await pairingServer(t);
  const options = { base, createStream: fetchEventStream, createConnection: createFakeConnection };
  const host = new PhonePoseSource({ ...options, origin: () => 'https://game.test' });
  const camera = new FakeCamera();
  const phone = new PhoneLink({ ...options, camera: camera as unknown as WebcamPoseSource, now: phoneNow });
  t.after(() => { host.disconnect(); phone.stop(); });
  const events: PoseSourceEvent[] = [];
  host.subscribeRecords((event) => events.push(event));
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await phone.join(code);
  await until(() => phone.view.stage === 'linked' && host.clock.ready, 'the link', 4000);

  // A redeploy restarts the pairing service: its rooms are gone.
  pairingServer.last?.close();
  await until(() => host.view.pairing === null, 'the game to drop its code');
  assert.equal(phone.view.stage, 'linked');
  camera.emit(phoneRecord(10, 1));
  await until(() => events.some(isPoseRecordEvent), 'poses without the pairing server');
  assert.notEqual(host.view.status, 'error');

  // The game stopping now reaches the phone through the link itself.
  host.disconnect();
  await until(() => phone.view.stage === 'ended', 'the phone to end');
  assert.match(phone.view.message, /pairing server stopped/);
});

test('ICE candidates that overtake their offer wait for it', async () => {
  const phone = new PhoneLink({ camera: new FakeCamera() as unknown as WebcamPoseSource, createConnection: createFakeConnection });
  phone.channel = { send: async () => {}, close: () => {} } as unknown as SignalChannel;
  phone.onSignal({ type: 'ice', epoch: 3, candidate: { candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 } });
  phone.onSignal({ type: 'ice', epoch: 2, candidate: { candidate: 'stale', sdpMid: '0', sdpMLineIndex: 0 } });
  phone.onSignal({ type: 'ice', epoch: 3, candidate: { candidate: 'early 2', sdpMid: '0', sdpMLineIndex: 0 } });
  phone.onSignal({ type: 'offer', epoch: 3, sdp: 'fake-offer none' });
  const connection = phone.peer?.pc as unknown as FakeConnection;
  await until(() => connection.candidates.length === 2, 'the early candidates');
  assert.deepEqual(connection.candidates.map((c) => c.candidate), ['early', 'early 2']);
  phone.stop();
});

test('the events stream comes back after a failed response, unless the room is gone', async () => {
  const opened: EventStream[] = [];
  const createStream = (): EventStream => {
    const stream: EventStream = { readyState: 0, onmessage: null, onerror: null, close: () => { stream.readyState = 2; } };
    opened.push(stream);
    return stream;
  };
  const fail = (stream: EventStream) => { stream.readyState = 2; stream.onerror?.(new Event('error')); };
  let status = 502;
  const heard: PairingEvent[] = [];
  const channel = new SignalChannel({ code: '123456', token: 't', base: 'http://pairing.test/pair', createStream, onEvent: (e) => heard.push(e),
    fetch: async () => new Response(null, { status }) });
  channel.open();
  fail(opened[0]);
  await until(() => opened.length === 2, 'listening again', 4000);
  assert.deepEqual(heard, []);
  status = 404;
  fail(opened[1]);
  await until(() => heard.length === 1, 'the end');
  assert.deepEqual(heard, [{ type: 'closed', reason: 'The pairing ended. Pair again.' }]);
  assert.equal(channel.gone, true);
});

test('a game that cannot reach the pairing server says so', async () => {
  const host = new PhonePoseSource({ base: 'http://127.0.0.1:9/pair' });
  await host.connect();
  assert.equal(host.view.status, 'error');
  assert.match(host.view.message, /pairing server/);
});

test('the phone comes after the webcams; choosing it switches the game’s input and only its poses reach the game', async () => {
  store.clear();
  const phone = new PhonePoseSource({ base: 'http://127.0.0.1:9/pair' });
  const input = new CameraInput({ webcam: new PoseSourceController(), phone, webcamSupported: true });
  // Without a webcam (the Apple TV app), the phone is the camera from the start.
  assert.equal(new CameraInput({ webcam: new PoseSourceController(), phone: new PhonePoseSource(), webcamSupported: false }).mode, 'phone');
  const heard: PoseSourceEvent[] = [];
  input.subscribeRecords((event) => heard.push(event));
  assert.equal(input.view.sourceKind, 'webcam');
  assert.deepEqual(input.view.cameras.slice(-2), [PHONE_CAMERA, NO_CAMERA]);
  await input.configure({ cameraId: PHONE_CAMERA.deviceId });
  assert.equal(input.view.sourceKind, 'phone');
  assert.equal(input.view.cameraId, PHONE_CAMERA.deviceId);
  assert.equal(input.video, null);
  assert.equal(store.get('aerodance-camera'), 'phone');
  assert.equal(new CameraInput({ webcam: new PoseSourceController(), phone: new PhonePoseSource(), webcamSupported: true }).mode, 'phone');

  const record = { ...phoneRecord(0, 1), timingMethod: 'remote-clock-sync' as const };
  const event = { record, receivedBrowserTimeMs: 1, captureBrowserTimeMs: 1, timing: { method: 'remote-clock-sync' } };
  phone.emit(event);
  input.webcam.source.emit({ record, receivedBrowserTimeMs: 1, captureBrowserTimeMs: 1, timing: { method: 'browser-frame-observation' } });
  assert.deepEqual(heard.filter(isPoseRecordEvent).map((e) => e.timing.method), ['remote-clock-sync']);
  // The phone's model is its own.
  await input.configure({ modelId: 'heavy' });
  assert.equal(phone.view.model, 'heavy');
  assert.equal(input.webcam.view.model, 'lite');

  await input.configure({ cameraId: '' });
  assert.equal(input.view.sourceKind, 'webcam');
  assert.equal(store.get('aerodance-camera'), 'webcam');
});

test('No camera is the last camera: nothing runs, no poses reach the game, and it is remembered', async () => {
  store.clear();
  const phone = new PhonePoseSource({ base: 'http://127.0.0.1:9/pair' });
  const input = new CameraInput({ webcam: new PoseSourceController(), phone, webcamSupported: true });
  const heard: PoseSourceEvent[] = [];
  input.subscribeRecords((event) => heard.push(event));
  assert.deepEqual(input.view.cameras.at(-1), NO_CAMERA);
  await input.configure({ cameraId: PHONE_CAMERA.deviceId });
  await input.configure({ cameraId: NO_CAMERA.deviceId });
  assert.equal(input.mode, 'none');
  assert.equal(input.view.cameraId, NO_CAMERA.deviceId);
  assert.equal(input.view.status, 'disconnected');
  assert.equal(input.video, null);
  assert.equal(store.get('aerodance-camera'), 'none');
  // Remembered, even where the phone would otherwise be the camera.
  assert.equal(new CameraInput({ webcam: new PoseSourceController(), phone: new PhonePoseSource(), webcamSupported: false }).mode, 'none');

  await input.connect();
  assert.equal(input.view.status, 'disconnected');
  assert.equal(phone.view.status, 'disconnected');
  const record = { ...phoneRecord(0, 1), timingMethod: 'remote-clock-sync' as const };
  phone.emit({ record, receivedBrowserTimeMs: 1, captureBrowserTimeMs: 1, timing: { method: 'remote-clock-sync' } });
  input.webcam.source.emit({ record, receivedBrowserTimeMs: 1, captureBrowserTimeMs: 1, timing: { method: 'browser-frame-observation' } });
  assert.deepEqual(heard.filter(isPoseRecordEvent), []);
  // A model chosen meanwhile is the webcam's.
  await input.configure({ modelId: 'heavy' });
  assert.equal(input.webcam.view.model, 'heavy');
  assert.equal(input.view.model, 'heavy');

  await input.configure({ cameraId: '' });
  assert.equal(input.mode, 'webcam');
  assert.equal(store.get('aerodance-camera'), 'webcam');
});

test('the phone names itself and reads its code from the link', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari'), 'Android phone');
  assert.equal(deviceName('Mozilla/5.0 (X11; Linux x86_64)'), 'Phone');
  assert.equal(linkCode(new URL('https://a.test/pair/#123456')), '123456');
  assert.equal(linkCode(new URL('https://a.test/pair/?code=654321')), '654321');
  assert.equal(linkCode(new URL('https://a.test/pair/#12345')), '');
});

test('the phone lists its cameras by name and switches between them', async (t) => {
  const camera = new FakeCamera();
  const phone = new PhoneLink({ camera: camera as unknown as WebcamPoseSource });
  t.after(() => phone.stop());
  const labels = () => phone.cameras().map((c) => c.label);
  // Front and back until the browser lists the cameras; the back one to start with.
  assert.deepEqual(labels(), ['Back camera', 'Front camera']);
  assert.equal(phone.chosenCamera(), 'facing:environment');
  await phone.chooseCamera('facing:user');
  assert.equal(camera.view.facing, 'user');
  assert.equal(phone.chosenCamera(), 'facing:user');

  // iOS names its cameras itself.
  camera.publish({ cameras: [{ deviceId: 'front', label: 'Front Camera' }, { deviceId: 'back', label: 'Back Camera' },
    { deviceId: 'ultra', label: 'Back Ultra Wide Camera' }, { deviceId: 'tele', label: 'Back Telephoto Camera' }] });
  // The front one is running, but which it is goes unsaid: the side's default stays on the list.
  assert.deepEqual(labels(), ['Front camera (default)', 'Front camera', 'Back camera', 'Back ultra wide camera', 'Back telephoto camera']);
  await phone.chooseCamera('device:ultra');
  assert.equal(camera.view.cameraId, 'ultra');
  assert.equal(camera.view.facing, 'environment');
  assert.equal(phone.chosenCamera(), 'device:ultra');
  await phone.chooseCamera('device:front');
  assert.equal(camera.view.facing, 'user');
  // Back to a side: no particular camera, so the side stays on the list.
  await phone.chooseCamera('facing:environment');
  assert.equal(camera.view.cameraId, '');
  assert.equal(phone.chosenCamera(), 'facing:environment');
  assert.equal(labels()[0], 'Back camera (default)');
  await phone.chooseCamera('device:back');

  // Android numbers each side's cameras; anything else keeps its own name.
  camera.publish({ cameras: [{ deviceId: 'a', label: 'camera2 0, facing back' }, { deviceId: 'b', label: 'camera2 1, facing front' },
    { deviceId: 'c', label: 'camera2 2, facing back' }, { deviceId: 'd', label: 'USB Camera' }] });
  assert.deepEqual(labels(), ['Back camera', 'Front camera', 'Back camera 2', 'USB Camera']);
});

test('a phone answers only the newest offer, and the game gives up on a phone that left mid-connection', async (t) => {
  const base = await pairingServer(t);
  const options = { base, createStream: fetchEventStream, createConnection: createFakeConnection };
  const phone = new PhoneLink({ camera: new FakeCamera() as unknown as WebcamPoseSource, createConnection: createFakeConnection });
  phone.channel = { send: async () => {}, close: () => {} } as unknown as SignalChannel;
  phone.onSignal({ type: 'offer', epoch: 5, sdp: 'fake-offer none' });
  const answering = phone.peer;
  phone.onSignal({ type: 'offer', epoch: 4, sdp: 'fake-offer none' });
  assert.equal(phone.peer, answering, 'an older offer that arrived late is ignored');
  phone.stop();

  // The phone says hello, then leaves before the connection opens.
  const host = new PhonePoseSource({ ...options, origin: () => 'https://game.test' });
  t.after(() => host.disconnect());
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  const joined = await (await fetch(`${base}/rooms/${code}/join`, { method: 'POST', body: '{}' })).json();
  await fetch(`${base}/rooms/${code}/messages`, { method: 'POST', body: JSON.stringify({ token: joined.token, message: { type: 'hello', device: 'Gone phone' } }) });
  await until(() => host.view.status === 'initializing', 'the game to offer');
  await fetch(`${base}/rooms/${code}/close`, { method: 'POST', body: JSON.stringify({ token: joined.token }) });
  await until(() => host.view.status === 'connecting' && host.peer === null, 'the code to show again');
});

test('a phone starts its camera again when it fails after tracking, but not one that never worked', async (t) => {
  const camera = new FakeCamera();
  const phone = new PhoneLink({ camera: camera as unknown as WebcamPoseSource, createConnection: createFakeConnection, cameraRetryMs: 10 });
  t.after(() => phone.stop());
  phone.publish({ stage: 'linked' });
  // Permission denied: starting again would only fail again, so it waits for the player.
  camera.publish({ status: 'error', message: 'Camera permission was denied. Allow camera access for this site, then start again.' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(camera.view.status, 'error');
  phone.resume();
  assert.equal(camera.view.status, 'connected');
  // Tracking stalls on a phone on a stand: it says so and starts again by itself.
  camera.publish({ status: 'error', message: 'Camera tracking stopped responding. Start camera to retry.' });
  assert.equal(camera.view.message, 'Camera tracking stopped responding. Starting it again…');
  await until(() => camera.view.status === 'connected', 'the camera to start again');
  assert.equal(phone.cameraRetries, 0, 'tracking again resets the wait');
  // Failing again and again waits longer each time.
  camera.connect = async () => { camera.publish({ status: 'error', message: 'The camera stopped sending pictures. Start camera to retry.' }); };
  camera.publish({ status: 'error', message: 'The camera stopped sending pictures. Start camera to retry.' });
  await until(() => phone.cameraRetries >= 3, 'repeated retries');
  // Leaving stops retrying.
  phone.stop();
  const retries = phone.cameraRetries;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(phone.cameraRetries, retries);
});

test('the game asks for the phone’s picture only while it previews, and the phone sends a small one', async (t) => {
  const base = await pairingServer(t);
  const options = { base, createStream: fetchEventStream, createConnection: createFakeConnection };
  const host = new PhonePoseSource({ ...options, origin: () => 'https://game.test' });
  const camera = new FakeCamera();
  const phone = new PhoneLink({ ...options, camera: camera as unknown as WebcamPoseSource, now: phoneNow });
  t.after(() => { host.disconnect(); phone.stop(); });
  host.setPreview(true);
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await phone.join(code);
  // Asked for as soon as the link opens, and dropped when the preview goes.
  await until(() => phone.previewWanted, 'the preview request');
  host.setPreview(false);
  await until(() => !phone.previewWanted, 'the preview to stop');
  assert.equal(host.video, null, 'no picture without a preview');

  // The phone's end of the video track (the loopback connection has none of its own).
  const calls: unknown[] = [];
  const params: RTCRtpSendParameters = { encodings: [{}], transactionId: '', codecs: [], headerExtensions: [], rtcp: {} };
  phone.videoSender = { replaceTrack: async (track: MediaStreamTrack | null) => { calls.push(track); },
    getParameters: () => params, setParameters: async (p: RTCRtpSendParameters) => { calls.push(p.encodings[0]); } } as unknown as RTCRtpSender;
  const track = { kind: 'video', getSettings: () => ({ width: 480, height: 640 }) } as unknown as MediaStreamTrack;
  Object.assign(camera, { stream: { getVideoTracks: () => [track] } });
  phone.previewWanted = true; phone.updateVideo(); phone.updateVideo();
  await until(() => calls.length === 2, 'the track and its limits');
  assert.equal(calls[0], track, 'the camera goes on the track once');
  assert.deepEqual(calls[1], { maxBitrate: 250_000, maxFramerate: 12, scaleResolutionDownBy: 2 }, 'scaled to 320 on its long side');
  phone.previewWanted = false; phone.updateVideo();
  await until(() => calls.length === 3, 'the track to come off');
  assert.equal(calls[2], null);
});

test('without WebRTC, a phone links through the pairing server’s relay: poses on the game’s clock, previews as pictures, reconnecting', async (t) => {
  const base = await pairingServer(t);
  const pictures: number[] = [];
  // The game decodes pictures to their size; the phone sends a "JPEG" naming its own (240 × 180).
  const host = new PhonePoseSource({ base, createStream: fetchEventStream, transport: 'relay', origin: () => 'https://game.test',
    decodeFrame: async (jpeg) => { const [w, h] = new Uint16Array(jpeg); pictures.push(w); return { image: {} as CanvasImageSource, width: w, height: h }; } });
  const events: PoseSourceEvent[] = [];
  host.subscribeRecords((event) => events.push(event));
  const camera = new FakeCamera();
  // A camera with a picture to send.
  Object.assign(camera, { stream: {}, video: {} });
  const captured: number[] = [];
  const phone = new PhoneLink({ base, createStream: fetchEventStream, camera: camera as unknown as WebcamPoseSource, now: phoneNow, device: 'Relay phone',
    captureFrame: async (_video, longSide) => { captured.push(longSide); return new Uint16Array([240, 180]).buffer; } });
  t.after(() => { host.disconnect(); phone.stop(); });
  assert.equal(host.relayed, true);

  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a pairing code');
  await phone.join(code);
  await until(() => phone.view.stage === 'linked', 'the phone to link through the relay');
  assert.ok(phone.link && !phone.peer, 'relayed, not WebRTC');
  await until(() => host.view.message.startsWith('Relay phone: Lite'), 'the phone’s status');
  await host.setPlayerCount(2);
  await until(() => camera.playerCount === 2, 'the player count');

  await until(() => host.clock.ready, 'clock sync over the relay', 4000);
  const sent = phoneRecord(30);
  camera.emit(sent);
  const event = await until(() => events.find(isPoseRecordEvent), 'a relayed pose');
  assert.ok(Math.abs(event.captureBrowserTimeMs - (sent.frameBrowserTimeMs - PHONE_AHEAD_MS)) < 15, 'capture time on the game’s clock');
  assert.equal(host.view.status, 'connected');

  // The preview: small pictures while it's on, none after.
  assert.equal(host.video, null);
  host.setPreview(true);
  await until(() => host.video, 'a preview picture');
  assert.deepEqual([(host.video as PreviewFrame | null)?.width, captured[0]], [240, 240]);
  assert.ok(phone.sendingVideo);
  host.setPreview(false);
  await until(() => !phone.sendingVideo, 'the pictures to stop');
  const count = pictures.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(pictures.length <= count + 1, 'no more pictures after the preview');

  // The phone's socket drops: both ends notice, the phone says hello and they link again.
  const epoch = host.epoch;
  phone.link?.socket.close();
  await until(() => host.epoch > epoch && phone.view.stage === 'linked' && host.control?.readyState === 'open', 'relinking');
  await until(() => host.clock.ready, 'clock sync again', 4000);
  camera.emit(phoneRecord(20));
  await until(() => events.filter(isPoseRecordEvent).length === 2, 'poses after relinking');

  host.disconnect();
  await until(() => phone.view.stage === 'ended', 'the phone to hear pairing ended');
});

test('the game relays where there is no WebRTC, unless told otherwise', () => {
  assert.equal(typeof RTCPeerConnection, 'undefined');
  assert.equal(new PhonePoseSource().relayed, true);
  assert.equal(new PhonePoseSource({ transport: 'webrtc' }).relayed, false);
  assert.equal(new PhonePoseSource({ createConnection: createFakeConnection }).relayed, false);
});

test('through the relay, a hello that overlaps a reconnection doesn’t keep the two from relinking', async (t) => {
  const base = await pairingServer(t);
  // A network with some latency, so a hello can cross the attempt it overlaps.
  const slow: typeof fetch = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 60)); return fetch(...args); };
  const host = new PhonePoseSource({ base, fetch: slow, createStream: fetchEventStream, transport: 'relay', origin: () => 'https://game.test', decodeFrame: async () => ({ image: {} as CanvasImageSource, width: 1, height: 1 }) });
  const camera = new FakeCamera();
  const phone = new PhoneLink({ base, fetch: slow, createStream: fetchEventStream, camera: camera as unknown as WebcamPoseSource, now: phoneNow });
  t.after(() => { host.disconnect(); phone.stop(); });
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await phone.join(code);
  await until(() => phone.view.stage === 'linked' && host.control?.readyState === 'open', 'the first link');
  for (const gap of [40, 120, 250]) {
    const epoch = host.epoch;
    phone.link?.socket.close();
    // The phone's hello timer ticks while it's reconnecting.
    await new Promise((resolve) => setTimeout(resolve, gap));
    phone.hello();
    await until(() => host.epoch > epoch && phone.view.stage === 'linked' && host.control?.readyState === 'open', `relinking (hello ${gap} ms in)`, 8000);
    // ...and it stays linked: no attempts keep replacing each other.
    const settled = host.epoch;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(host.epoch, settled, 'no more attempts once linked');
    assert.equal(phone.view.stage, 'linked');
  }
});

test('through the relay, a phone whose socket dies without the server noticing (a network change) relinks at once', async (t) => {
  const base = await pairingServer(t);
  const proxy = await relayProxy(t, base);
  const host = new PhonePoseSource({ base, createStream: fetchEventStream, transport: 'relay', origin: () => 'https://game.test', decodeFrame: noDecode });
  const events: PoseSourceEvent[] = [];
  host.subscribeRecords((event) => events.push(event));
  const camera = new FakeCamera();
  const phone = new PhoneLink({ base, createStream: fetchEventStream, camera: camera as unknown as WebcamPoseSource, now: phoneNow, createSocket: proxy.createSocket });
  t.after(() => { host.disconnect(); phone.stop(); });
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await phone.join(code);
  await until(() => phone.view.stage === 'linked' && host.control?.readyState === 'open', 'the first link');
  await host.setPlayerCount(2);
  await until(() => host.clock.ready, 'clock sync', 4000);

  const before = phone.link, stages: string[] = [];
  phone.subscribe((view) => stages.push(view.stage));
  const epoch = host.epoch, cutAt = performance.now();
  const closeServerEnd = proxy.cut();
  await until(() => stages.includes('linking') && phone.view.stage === 'linked' && phone.link !== before, 'relinking', 3000);
  assert.equal(host.epoch, epoch, 'to the same attempt');
  assert.ok(performance.now() - cutAt < 1000, 'at once, not after the server’s heartbeat');
  await until(() => host.clock.ready, 'clock sync again', 4000);
  camera.emit(phoneRecord(20));
  await until(() => events.find(isPoseRecordEvent), 'poses again');
  // The game told the phone its settings again.
  assert.equal(phone.view.playerCount, 2);
  closeServerEnd();
});

test('through the relay, a game whose socket dies on its side alone starts again at once, and the phone follows', async (t) => {
  const base = await pairingServer(t);
  const proxy = await relayProxy(t, base);
  const host = new PhonePoseSource({ base, createStream: fetchEventStream, transport: 'relay', origin: () => 'https://game.test', decodeFrame: noDecode, createSocket: proxy.createSocket });
  const phone = new PhoneLink({ base, createStream: fetchEventStream, camera: new FakeCamera() as unknown as WebcamPoseSource, now: phoneNow });
  t.after(() => { host.disconnect(); phone.stop(); });
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await phone.join(code);
  await until(() => phone.view.stage === 'linked' && host.control?.readyState === 'open', 'the first link');
  const epoch = host.epoch, cutAt = performance.now();
  const closeServerEnd = proxy.cut();
  await until(() => host.epoch > epoch && host.control?.readyState === 'open' && phone.view.stage === 'linked', 'relinking', 5000);
  assert.ok(performance.now() - cutAt < 3000, `within a few round trips (${Math.round(performance.now() - cutAt)} ms)`);
  closeServerEnd();
});

test('through the relay, a phone whose reconnection hangs gives it up and links again', async (t) => {
  const base = await pairingServer(t);
  const proxy = await relayProxy(t, base);
  const host = new PhonePoseSource({ base, createStream: fetchEventStream, transport: 'relay', origin: () => 'https://game.test', decodeFrame: noDecode });
  const phone = new PhoneLink({ base, createStream: fetchEventStream, camera: new FakeCamera() as unknown as WebcamPoseSource, createSocket: proxy.createSocket });
  t.after(() => { host.disconnect(); phone.stop(); });
  await host.connect();
  const { code } = await until(() => host.view.pairing, 'a code');
  await phone.join(code);
  await until(() => phone.view.stage === 'linked' && host.control?.readyState === 'open', 'the first link');
  // The network goes (the phone's reconnection hangs), then comes back a moment later.
  proxy.state.hang = true;
  const cutAt = performance.now();
  const closeServerEnd = proxy.cut();
  await until(() => phone.view.stage === 'linking' && phone.link, 'the phone reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  proxy.state.hang = false;
  await until(() => phone.view.stage === 'linked' && host.control?.readyState === 'open', 'relinking', 15_000);
  assert.ok(performance.now() - cutAt < 12_000, `well before the server's heartbeat (${Math.round(performance.now() - cutAt)} ms)`);
  closeServerEnd();
});
