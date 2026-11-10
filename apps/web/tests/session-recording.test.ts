import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionLogWriter } from '../../../packages/pose/sessionLog.ts';
import type { SessionHeader, SessionLine, SessionPose } from '../../../packages/pose/sessionLog.ts';
import { readSession, summarizeSession } from '../../../tools/replay/session.ts';
import { Puppet, REALISM } from '../src/pose/puppet/Puppet.ts';

const header: SessionHeader = { t: 1000, type: 'header', format: 'aerodance.session', version: 1,
  commit: null, userAgent: 'test', game: 'test-game', playerCount: 1, options: {}, detail: 'hands',
  camera: { width: 640, height: 480, frameRate: 30, label: 'Puppet' }, timeOrigin: 5000, videoStartTime: 1000,
  mimeType: 'video/webm', rotation: 0 };
function pose(t: number, seq: number): SessionPose {
  const puppet = new Puppet({ now: () => t, realism: REALISM.clean });
  puppet.follow(1);
  const found = puppet.detect(t, { world: true, hands: true });
  return { t, type: 'pose', lined: true, captureBrowserTimeMs: t - seq * 10, receivedBrowserTimeMs: t,
    timing: { method: 'browser-frame-observation' }, record: {
      schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'test', seq,
      playerCount: 1, input: { width: 640, height: 480, mirrored: false }, modelId: 'lite',
      mediaTimeMs: t - 1000, frameBrowserTimeMs: t - seq * 10, resultBrowserTimeMs: t,
      timingMethod: 'browser-frame-observation', poses: [{ playerId: 0, landmarks: found.landmarks[0].map(({ x, y, z, visibility, presence }) => ({ x, y, z, confidence: Math.min(visibility, presence) })), world: found.world[0], hands: found.hands[0] }],
    } };
}

test('batched log round trip preserves full webcam records, frame metadata and game events in order', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aerodance-session-'));
  const file = path.join(dir, 'session.jsonl');
  const writes: string[] = [];
  const writer = new SessionLogWriter({ write: async text => { writes.push(text); }, close: async () => { await writeFile(file, writes.join('')); } });
  const records: SessionLine[] = [header, { t: 1001, type: 'phase', data: { phase: 'calibrating' } },
    { t: 1002, type: 'frame', callbackTime: 1001, metadata: { mediaTime: 0, presentedFrames: 1, width: 640, height: 480,
      expectedDisplayTime: 1003, captureTime: 995, receiveTime: 1000, presentationTime: 1001 } },
    pose(1040, 1), { t: 1041, type: 'contact', data: { paddle: 'left' } }];
  records.forEach(line => writer.append(line));
  assert.equal(writes.length, 0, 'no per-record JSON/write');
  writer.flush();
  writer.append({ t: 1100, type: 'end', data: { reason: 'quit' } });
  await writer.close();
  assert.equal(writes.length, 2);
  const read = await readSession(file);
  assert.deepEqual(read.records, [...records, { t: 1100, type: 'end', data: { reason: 'quit' } }]);
  assert.deepEqual(read.header, header);
  await writeFile(file, JSON.stringify(header) + '\n{"t":900,"type":"phase"}\n');
  await assert.rejects(readSession(file), /:2: Expected a timed record in order/);
  await writeFile(file, JSON.stringify({ ...header, version: 99 }) + '\n');
  await assert.rejects(readSession(file), /v1 header/);
});

test('summary uses interval rate, interpolated latency quantiles, all-result hand rates and boundary gaps', () => {
  const a = pose(1100, 1), b = pose(1200, 2), c = pose(1600, 3);
  b.record.poses[0].hands = b.record.poses[0].hands!.filter(h => h.side === 'right');
  c.record.poses = [];
  const summary = summarizeSession({ header, records: [header, a, b, c, { t: 1900, type: 'end', data: {} }] });
  assert.equal(summary.durationMs, 900);
  assert.equal(summary.poseHz.mean, 4);
  assert.equal(summary.poseHz.p5, 2.875);
  assert.deepEqual(summary.captureToResultMs, { median: 20, p95: 29 });
  assert.deepEqual(summary.handRates, [{ playerId: 0, left: { found: 1, samples: 3, rate: 1 / 3 }, right: { found: 2, samples: 3, rate: 2 / 3 } }]);
  assert.deepEqual(summary.gapsOver200Ms, [{ from: 1200, to: 1600, durationMs: 400 }, { from: 1600, to: 1900, durationMs: 300 }]);
  assert.equal(summary.frameCount, 0);
  const empty = summarizeSession({ header, records: [header] });
  assert.deepEqual(empty.poseHz, { mean: null, p5: null });
  assert.deepEqual(empty.captureToResultMs, { median: null, p95: null });
});

test('disk failure is surfaced after closing the partial log, and slow sinks have a bounded queue', async () => {
  let closed = false;
  const writer = new SessionLogWriter({ write: async () => { throw Error('disk full'); }, close: async () => { closed = true; } });
  writer.append(header);
  await assert.rejects(writer.close(), /disk full/);
  assert.ok(closed);
  const slow = new SessionLogWriter({ write: async () => {}, close: async () => {} });
  for (let n = 0; n < 9; n++) { slow.append(header); slow.flush(); }
  await assert.rejects(slow.close(), /cannot keep up/);
});
