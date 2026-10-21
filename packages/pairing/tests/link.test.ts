import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../clock.ts';
import { parseGameMessage, parsePhoneMessage, poseMessage } from '../link.ts';
import { MAX_RELAY_FRAME } from '../relay.ts';
import { codeDigits, parsePairingEvent, spacedCode } from '../signals.ts';
import type { WebcamRecord } from '../../pose/webcamRecord.ts';

test('the clock follows the quickest recent round trip, and its error is half that trip', () => {
  const clock = new ClockSync();
  // Their clock runs 5000 ms ahead; delays out and back differ.
  const trip = (t0: number, out: number, back: number) => clock.add(t0, t0 + out + 5000, t0 + out + back);
  trip(0, 40, 10);
  assert.equal(clock.ready, false);
  trip(100, 4, 4);
  trip(200, 30, 2);
  assert.equal(clock.ready, true);
  assert.equal(clock.offsetMs, 5000);
  assert.equal(clock.uncertaintyMs, 4);
  assert.equal(clock.toLocal(15_000), 10_000);
  // Nonsense and very slow trips are ignored.
  clock.add(300, 1, 200);
  clock.add(300, NaN, 310);
  clock.add(300, 5300, 2000);
  assert.equal(clock.samples.length, 3);
  // Old samples age out, so drift is followed.
  trip(30_000, 10, 10);
  assert.equal(clock.samples.length, 1);
  assert.equal(clock.offsetMs, 5000);
  assert.equal(clock.uncertaintyMs, 10);
});

const landmarks = Array.from({ length: 33 }, (_, i) => ({ x: 0.123456789 + i / 100, y: 0.5, z: -0.0000012345, confidence: i === 1 ? null : 0.99999 }));
const record: WebcamRecord = { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 's', seq: 3, playerCount: 1,
  input: { width: 480, height: 640, mirrored: false }, modelId: 'lite', mediaTimeMs: 10, frameBrowserTimeMs: 100, resultBrowserTimeMs: 130,
  timingMethod: 'browser-frame-observation', poses: [{ playerId: 0, landmarks }] };

test('pose messages round their landmarks and still validate in full on arrival', () => {
  const message = parsePhoneMessage(poseMessage(record));
  assert.equal(message?.type, 'pose');
  if (message?.type !== 'pose') return;
  assert.equal(message.record.poses[0].landmarks[0].x, 0.12346);
  assert.equal(message.record.poses[0].landmarks[0].z, 0);
  assert.equal(message.record.poses[0].landmarks[0].confidence, 1);
  assert.equal(message.record.poses[0].landmarks[1].confidence, null);
  assert.deepEqual({ ...message.record, poses: [] }, { ...record, poses: [] });
  // A record that isn't one is refused.
  assert.equal(parsePhoneMessage(JSON.stringify({ type: 'pose', record: { ...record, poses: [{ playerId: 0, landmarks: [] }] } })), null);
  assert.equal(parsePhoneMessage(JSON.stringify({ type: 'pose', record: { ...record, timingMethod: 'guess' } })), null);
});

test('a four-player pose message validates and fits a relay frame', () => {
  const four: WebcamRecord = { ...record, playerCount: 4, poses: [0, 1, 2, 3].map((playerId) => ({ playerId, landmarks })) };
  const text = poseMessage(four);
  assert.ok(new TextEncoder().encode(text).length < MAX_RELAY_FRAME / 4);
  const message = parsePhoneMessage(text);
  assert.equal(message?.type === 'pose' && message.record.poses.length, 4);
  // A player beyond the record's count is refused.
  assert.equal(parsePhoneMessage(poseMessage({ ...four, playerCount: 3 })), null);
});

test('messages each way are checked before use', () => {
  assert.deepEqual(parseGameMessage(JSON.stringify({ type: 'config', playerCount: 2, modelId: 'full' })), { type: 'config', playerCount: 2, modelId: 'full' });
  assert.deepEqual(parseGameMessage(JSON.stringify({ type: 'config', playerCount: 4, modelId: 'full' })), { type: 'config', playerCount: 4, modelId: 'full' });
  assert.equal(parseGameMessage(JSON.stringify({ type: 'config', playerCount: 5, modelId: 'full' })), null);
  assert.equal(parseGameMessage(JSON.stringify({ type: 'config', playerCount: 1, modelId: 'huge' })), null);
  assert.deepEqual(parseGameMessage(JSON.stringify({ type: 'ping', id: 4, t0: 12.5 })), { type: 'ping', id: 4, t0: 12.5 });
  assert.deepEqual(parseGameMessage(JSON.stringify({ type: 'preview', on: true })), { type: 'preview', on: true });
  assert.equal(parseGameMessage(JSON.stringify({ type: 'preview', on: 'yes' })), null);
  assert.equal(parseGameMessage('{'), null);
  assert.equal(parseGameMessage({ type: 'game', playing: true }), null);
  const status = { type: 'status', status: 'connected', message: 'Lite', model: 'lite', delegate: 'GPU', facing: 'environment', inferenceMs: 12 };
  assert.deepEqual(parsePhoneMessage(JSON.stringify(status)), status);
  assert.equal(parsePhoneMessage(JSON.stringify({ ...status, status: 'dancing' })), null);
  assert.equal(parsePhoneMessage(JSON.stringify({ ...status, facing: 'up' })), null);
  assert.deepEqual(parsePhoneMessage(JSON.stringify({ type: 'pong', id: 1, t0: 1, t1: 2 })), { type: 'pong', id: 1, t0: 1, t1: 2 });
});

test('pairing signals and codes', () => {
  assert.equal(codeDigits('123 45-6789'), '123456');
  assert.equal(spacedCode('123456'), '123 456');
  assert.deepEqual(parsePairingEvent({ type: 'ice', epoch: 2, candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } }),
    { type: 'ice', epoch: 2, candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal(parsePairingEvent({ type: 'ice', epoch: -1, candidate: { candidate: 'c' } }), null);
  assert.equal(parsePairingEvent({ type: 'offer', epoch: 1 }), null);
  assert.deepEqual(parsePairingEvent({ type: 'hello', device: 'x'.repeat(200) }), { type: 'hello', device: 'x'.repeat(80) });
  // A phone that takes probes says so, and a probe says it's one; anything but true is left out.
  assert.deepEqual(parsePairingEvent({ type: 'hello', device: 'p', probes: true }), { type: 'hello', device: 'p', probes: true });
  assert.deepEqual(parsePairingEvent({ type: 'hello', device: 'p', probes: 'yes' }), { type: 'hello', device: 'p' });
  assert.deepEqual(parsePairingEvent({ type: 'offer', epoch: 3, sdp: 's', probe: true }), { type: 'offer', epoch: 3, sdp: 's', probe: true });
  assert.deepEqual(parsePairingEvent({ type: 'answer', epoch: 3, sdp: 's', probe: true }), { type: 'answer', epoch: 3, sdp: 's' });
  assert.equal(parsePairingEvent({ type: 'bogus' }), null);
});
