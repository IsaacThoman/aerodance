import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhonePoseSource } from '../src/pose/PhonePoseSource.ts';
import { CameraInput, PHONE_CAMERA } from '../src/pose/CameraInput.ts';
import { isPoseRecordEvent } from '../src/pose/PoseSource.ts';
import type { PoseSourceEvent } from '../src/pose/PoseSource.ts';
import { standingPose } from '../src/pose/ReplayPoseSource.ts';
import { PhoneLink, deviceName, linkCode } from '../src/phone/PhoneLink.ts';
import { PoseSourceController } from '../../packages/pose/browser/PoseSourceController.ts';
import type { WebcamConfigureOptions, WebcamPoseSource, WebcamRecordEvent, WebcamView } from '../../packages/pose/browser/WebcamPoseSource.ts';
import type { WebcamRecord } from '../../packages/pose/webcamRecord.ts';
import type { PlayerCount } from '../../packages/pose/choreography.ts';
import { FakeConnection, createFakeConnection, fetchEventStream, pairingServer, until } from './fixtures/fakePairing.ts';

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
    this.publish({ ...(options.modelId ? { model: options.modelId as WebcamView['model'] } : {}), ...(options.facing ? { facing: options.facing } : {}) });
  }
  async setPlayerCount(count: PlayerCount) { this.playerCount = count; }
  emit(record: WebcamRecord) {
    for (const fn of this.recordListeners) fn({ record, receivedBrowserTimeMs: record.resultBrowserTimeMs, captureBrowserTimeMs: record.frameBrowserTimeMs, timing: { method: record.timingMethod } });
  }
}

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
  assert.equal(pairing.url, `https://game.test/phone/#${pairing.code}`);
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
  await host.configure({ modelId: 'full' });
  await until(() => camera.configured.some((c) => c.modelId === 'full'), 'the model');
  await until(() => host.view.model === 'full', 'the phone to report the model');

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

test('a game that cannot reach the pairing server says so', async () => {
  const host = new PhonePoseSource({ base: 'http://127.0.0.1:9/pair' });
  await host.connect();
  assert.equal(host.view.status, 'error');
  assert.match(host.view.message, /pairing server/);
});

test('the phone is the last camera; choosing it switches the game’s input and only its poses reach the game', async () => {
  store.clear();
  const phone = new PhonePoseSource({ base: 'http://127.0.0.1:9/pair' });
  const input = new CameraInput({ webcam: new PoseSourceController(), phone });
  const heard: PoseSourceEvent[] = [];
  input.subscribeRecords((event) => heard.push(event));
  assert.equal(input.view.sourceKind, 'webcam');
  assert.deepEqual(input.view.cameras.at(-1), PHONE_CAMERA);
  await input.configure({ cameraId: PHONE_CAMERA.deviceId });
  assert.equal(input.view.sourceKind, 'phone');
  assert.equal(input.view.cameraId, PHONE_CAMERA.deviceId);
  assert.equal(input.video, null);
  assert.equal(store.get('aerodance-camera'), 'phone');
  assert.equal(new CameraInput({ webcam: new PoseSourceController(), phone: new PhonePoseSource() }).mode, 'phone');

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

test('the phone names itself and reads its code from the link', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari'), 'Android phone');
  assert.equal(deviceName('Mozilla/5.0 (X11; Linux x86_64)'), 'Phone');
  assert.equal(linkCode(new URL('https://a.test/phone/#123456')), '123456');
  assert.equal(linkCode(new URL('https://a.test/phone/?code=654321')), '654321');
  assert.equal(linkCode(new URL('https://a.test/phone/#12345')), '');
});
