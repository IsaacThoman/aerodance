import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityFor, sampleSnapshot } from '../choreography.ts';
import type { LandmarkOrigin, PlayerCount, Pose, PoseQuality, PoseSnapshot } from '../choreography.ts';
import {
  CONFIDENCE_THRESHOLD, DEFAULT_POSITION_STEP, EXTENSION, PoseFileWriter, buildFrames, decodePoseFile, encodePoseFile,
  firstPresentFrame, framesFromSamples, framesToSamples, quantizeConfidence, quantizePosition, sampleFrames, sparseSamples, strideOf,
} from '../binary.ts';
import type { FrameInput, PoseHeaderInput } from '../binary.ts';

const pose = (playerId: number, t: number, confidence: number | null = .9, unknownJoint = 5): Pose => ({ playerId, landmarks: Array.from({ length: 33 }, (_, j) => ({
  x: .3 + playerId * .4 + Math.sin(t / 300 + j) * .05, y: (j < 23 ? .3 : .7) + Math.cos(t / 250 + j) * .03, z: -.1 + j * .001,
  confidence: j === unknownJoint ? null : confidence,
})) });
// Calibration is stored as f32, so the fixture uses exactly representable values.
const calibration = (playerId: number) => ({ inputWidth: 640, inputHeight: 480, torsoLength: .25, baseHip: { x: playerId ? .75 : .25, y: .6875, z: 0 }, floorY: .875, profileVersion: 2, cameraScaleMode: 'body-relative' as const, bodyTorsoLength: .375 });
const choreographyHeader: PoseHeaderInput = {
  kind: 'choreography', playerSlots: 2, input: { width: 640, height: 480 }, modelId: 'full',
  song: { songId: 'fixture', durationMs: 3000, playableStartMs: 0, playableEndMs: 2000, maxInterpolationGapMs: 200, confidenceThreshold: CONFIDENCE_THRESHOLD },
  tracks: [0, 1].map(playerId => ({ slot: playerId, playerId, label: `Player ${playerId + 1}`, calibration: calibration(playerId), exclusions: playerId ? [{ startMs: 500, endMs: 600, reason: 'Occluded' }] : [] })),
  markers: [{ timeMs: 0, kind: 'beat', label: '1' }, { timeMs: 500, kind: 'phrase', label: 'Chorus' }],
  provenance: { compilerVersion: 'test', sources: [{ takeId: 'a', provenance: { modelId: 'full', sourceRateHz: 10 } }] },
};
const sameOrigin = (a: LandmarkOrigin, b: LandmarkOrigin) => a === b || [a, b].every(o => o === 'measured' || o === 'resampled');
/** Asserts a decoded snapshot matches the original within quantization. */
function assertClose(actual: PoseSnapshot, expected: PoseSnapshot, at: number, confidenceTolerance = 1 / 508) {
  assert.deepEqual(actual.poses.map(p => p.playerId), expected.poses.map(p => p.playerId), `players at ${at}`);
  actual.poses.forEach((p, i) => {
    const q = actual.quality[i], r = expected.quality[i];
    assert.equal(q.reviewed, r.reviewed, `reviewed at ${at}`);
    p.landmarks.forEach((l, j) => {
      const m = expected.poses[i].landmarks[j];
      for (const axis of ['x', 'y', 'z'] as const) assert.ok(Math.abs(l[axis] - m[axis]) <= DEFAULT_POSITION_STEP / 2 + 1e-9, `${axis} at ${at}`);
      if (m.confidence === null) assert.equal(l.confidence, null);
      else assert.ok(l.confidence !== null && Math.abs(l.confidence - m.confidence) <= confidenceTolerance + 1e-9, `confidence at ${at}: ${l.confidence} vs ${m.confidence}`);
      assert.ok(sameOrigin(q.landmarkOrigins[j], r.landmarkOrigins[j]), `origin at ${at}`);
      assert.equal(q.scoreEligible[j], r.scoreEligible[j], `eligibility at ${at} joint ${j}`);
    });
  });
}

/** A compiled-style timeline: measured samples at ~10 Hz resampled onto a 30 Hz grid, with an edit, an absence and a long gap. */
function compiledTimeline() {
  const measured = [0, 95, 190, 290, 380, 470, 570, 660, 1000, 1100, 1190, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000].map(songTimeMs => {
    // One joint loses its confidence at 570 ms; frames interpolated next to it keep that origin.
    const unknown = songTimeMs === 570 ? 5 : -1;
    const poses = songTimeMs >= 1300 && songTimeMs <= 1500 ? [pose(0, songTimeMs, .9, unknown)] : [pose(0, songTimeMs, .9, unknown), pose(1, songTimeMs, songTimeMs % 200 ? .9 : .3, unknown)];
    return { songTimeMs, poses, quality: qualityFor(poses) };
  });
  const times = [...new Set([...measured.map(s => s.songTimeMs), ...Array.from({ length: 61 }, (_, i) => +(i * 1000 / 30).toFixed(6))])].sort((a, b) => a - b);
  return times.map(songTimeMs => {
    const s = sampleSnapshot(measured, songTimeMs, 'songTimeMs', 200);
    // An edited wrist between 1700 and 1800 ms, like a joint edit.
    if (songTimeMs >= 1700 && songTimeMs <= 1800) s.poses.forEach((p, i) => { p.landmarks[15].x += .05; s.quality[i].landmarkOrigins[15] = 'edited'; s.quality[i].scoreEligible[15] = false; });
    s.quality.forEach(q => { q.reviewed = songTimeMs < 1000; });
    return { songTimeMs, ...s };
  });
}

test('quantization: positions clamp at ±2 and confidence maps 0.5 to 127 and null to 255', () => {
  assert.equal(quantizePosition(5, DEFAULT_POSITION_STEP), 32767);
  assert.equal(quantizePosition(-5, DEFAULT_POSITION_STEP), -32767);
  assert.equal(quantizePosition(.25, DEFAULT_POSITION_STEP), 4096);
  assert.deepEqual([0, .5, 1, null, .499].map(quantizeConfidence), [0, 127, 254, 255, 127]);
  assert.deepEqual([[1, false, 0], [1, true, 0], [2, false, 0], [2, true, 0], [2, false, 5]].map(([p, f, e]) => strideOf(p as number, f as boolean, e as number)), [248, 280, 480, 544, 504]);
});

test('a choreography stores only frames interpolation cannot rebuild, and samples like the JSON timeline', () => {
  const dense = compiledTimeline();
  const sparse = sparseSamples(dense, 'songTimeMs', 200);
  assert.ok(sparse.length < dense.length * .6, `kept ${sparse.length} of ${dense.length}`);
  assert.equal(sparse[0], dense[0]); assert.equal(sparse.at(-1), dense.at(-1));
  const bytes = encodePoseFile(framesFromSamples(choreographyHeader, sparse, 'songTimeMs'));
  const frames = decodePoseFile(bytes);
  assert.ok(frames.jointFlags, 'edits and review need stored flags');
  assert.equal(bytes.length % 8, 0);
  for (const { songTimeMs } of dense) assertClose(sampleFrames(frames, songTimeMs), sampleSnapshot(dense, songTimeMs, 'songTimeMs', 200), songTimeMs, 1 / 254);
  for (let t = 0; t <= 2000; t += 7) assertClose(sampleFrames(frames, t), sampleSnapshot(dense, t, 'songTimeMs', 200), t, 1 / 254);
  // Absence and gaps over the limit are never bridged.
  assert.deepEqual(sampleFrames(frames, 800).poses, []);
  assert.deepEqual(sampleFrames(frames, 1400).poses.map(p => p.playerId), [0]);
  assert.deepEqual(sampleFrames(frames, 2000.5).poses, []);
  assert.equal(firstPresentFrame(frames, 1, 1300, 1600), frames.times.indexOf(1600));
  // Encoding the decoded frames again keeps every frame: the bytes are stable.
  assert.deepEqual(encodePoseFile(framesFromSamples(choreographyHeader, sparseSamples(framesToSamples(frames, 'songTimeMs'), 'songTimeMs', 200), 'songTimeMs')), bytes);
  assert.deepEqual(frames.song, choreographyHeader.song);
  assert.deepEqual(frames.tracks, choreographyHeader.tracks);
  assert.deepEqual(frames.markers, choreographyHeader.markers);
  assert.deepEqual(frames.provenance, choreographyHeader.provenance);
});

test('quality matching the confidence derivation stores no joint flags', () => {
  const samples = [0, 100, 200].map(songTimeMs => { const poses = [pose(0, songTimeMs, .499), pose(1, songTimeMs, .2)]; return { songTimeMs, poses, quality: qualityFor(poses) }; });
  const frames = decodePoseFile(encodePoseFile(framesFromSamples({ ...choreographyHeader, song: { ...choreographyHeader.song!, playableEndMs: 200 } }, samples, 'songTimeMs')));
  assert.equal(frames.jointFlags, null);
  assert.equal(frames.times.length * 480 + 8 + 8, decodePoseFile(encodePoseFile(frames)).times.length * 480 + 16);
  const q = framesToSamples(frames, 'songTimeMs')[0].quality;
  assert.equal(q[0].landmarkOrigins[5], 'missing-confidence');
  // 0.499 rounds up to the 0.5 threshold byte and becomes eligible: the accepted shift.
  assert.equal(q[0].scoreEligible[0], true);
  assert.equal(q[1].scoreEligible[0], false);
});

test('a video take round-trips its calibration frame, seek-time frames, sequence numbers and provenance', () => {
  const header: PoseHeaderInput = { kind: 'take', playerSlots: 2, input: { width: 1920, height: 1080 }, modelId: 'heavy', provenance: { filename: 'duet.webm', note: 'ünïcode' } };
  const inputs: FrameInput[] = [0, 66.733, 133.4, 200].map((timeMs, i) => ({ timeMs, poses: i === 2 ? [pose(1, timeMs)] : [pose(0, timeMs), pose(1, timeMs)], seq: i + 1, seekTime: i === 3 }));
  const quality: PoseQuality[] = qualityFor(inputs[0].poses);
  quality[0].landmarkOrigins[3] = 'gap-repaired'; quality[0].scoreEligible[3] = false; quality[1].reviewed = true;
  inputs[0].quality = quality;
  const frames = buildFrames(header, inputs, { calibrationFrame: { timeMs: 100, poses: [pose(0, 100), pose(1, 100)] } });
  const bytes = encodePoseFile(frames), decoded = decodePoseFile(bytes);
  assert.deepEqual(decoded, frames);
  assert.deepEqual(encodePoseFile(decoded), bytes);
  assert.deepEqual([...decoded.frameFlags], [0, 0, 0, 1]);
  assert.deepEqual([...decoded.seq], [1, 2, 3, 4]);
  assert.equal(decoded.calibrationFrame?.times[0], 100);
  const samples = framesToSamples(decoded, 'takeTimeMs');
  assert.deepEqual(samples[2].poses.map(p => p.playerId), [1]);
  assert.equal(samples[0].sourceSeq, 1);
  assert.equal(samples[0].quality[0].landmarkOrigins[3], 'gap-repaired');
  assert.equal(samples[0].quality[1].reviewed, true);
});

test('a track stores its player in its single slot', () => {
  const header: PoseHeaderInput = { kind: 'track', playerSlots: 1, input: { width: 640, height: 480 }, modelId: null,
    tracks: [{ slot: 0, playerId: 1, label: 'Player 2', calibration: null, exclusions: [{ startMs: 0, endMs: 10, reason: 'Fall' }] }] };
  const decoded = decodePoseFile(encodePoseFile(framesFromSamples(header, [0, 50].map(takeTimeMs => ({ takeTimeMs, poses: [pose(1, takeTimeMs)] })), 'takeTimeMs')));
  assert.equal(decoded.times.length, 2);
  assert.deepEqual(framesToSamples(decoded, 'takeTimeMs')[1].poses.map(p => p.playerId), [1]);
  assert.throws(() => framesFromSamples(header, [{ takeTimeMs: 0, poses: [pose(0, 0)] }], 'takeTimeMs'), /no slot/);
});

test('a streamed webcam capture appends frame and event chunks, and equals the whole-file encoding', () => {
  const base = 4_000_000; // performance.now() a little over an hour into a session
  const header: PoseHeaderInput = { kind: 'capture', playerSlots: 2, input: { width: 640, height: 480 }, modelId: 'lite',
    capture: { sourceKind: 'webcam', sessionId: 'session-1', audioPlaybackRate: 1 },
    extensionIds: [1, 2, 3, 4, 5], extensionBases: [base, base, base, 0, 0], provenance: { audioAnchor: 'test' } };
  const frame = (i: number): FrameInput => ({ timeMs: i * 33.367, seq: i + 1, poses: i % 3 ? [pose(0, i * 33)] : [],
    extensions: { 1: base + i * 33.367 + .0004, 2: base + i * 33.367 + 12.25, 3: base + i * 33.367 + 13.001, 4: 1000 + i * 33.4, 5: 1012.5 + i * 33.4 } });
  const start = { type: 'audio-start-scheduled' as const, audioContextStartTime: 12.5, positionMs: 0, rate: 1, receivedBrowserTimeMs: base - 1, audioPositionAtReceiptMs: 0 };
  const stop = { type: 'audio-stop' as const, reason: null, receivedBrowserTimeMs: base + 900, audioPositionAtReceiptMs: 1300 };
  const writer = new PoseFileWriter(header);
  const parts = [writer.start(), writer.events([start]), writer.frames([0, 1, 2].map(frame)), writer.frames([3, 4].map(frame)), writer.events([stop])];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { file.set(p, at); return at + p.length; }, 0);
  const decoded = decodePoseFile(file);
  assert.equal(decoded.times.length, 5);
  assert.deepEqual(decoded.events.map(e => [e.type, e.frameIndex]), [['audio-start-scheduled', 0], ['audio-stop', 5]]);
  assert.deepEqual(decoded.events[1], { ...stop, frameIndex: 5 });
  const frames = decoded.extensions.get(EXTENSION.frameBrowserTimeMs)!;
  assert.ok(Math.abs(frames[1] - (base + 33.367 + .0004)) <= .0005, 'extension fields keep microseconds');
  assert.deepEqual(decoded.capture, header.capture);
  assert.deepEqual(decoded, buildFrames(header, [0, 1, 2, 3, 4].map(frame), { events: decoded.events }));
  // Whole-file encoding merges the two frame batches into one chunk.
  assert.equal(decodePoseFile(encodePoseFile(decoded)).events.length, 2);
  assert.throws(() => writer.frames([frame(4)]), /increase/);
  assert.throws(() => new PoseFileWriter({ ...header, extensionBases: undefined }), /base/);
  assert.throws(() => buildFrames(header, [{ ...frame(0), extensions: { ...frame(0).extensions, 1: base + 3e6 } }]), /out of range/);
});

test('a replay recording keeps the capture clock beside song time', () => {
  const header: PoseHeaderInput = { kind: 'recording', playerSlots: 1, input: { width: 640, height: 480 }, modelId: null, extensionIds: [EXTENSION.captureBrowserTimeMs], provenance: { songId: 'demo' } };
  const frames = buildFrames(header, [{ timeMs: -120.5, poses: [pose(0, 0)], extensions: { 6: 98765.4321 } }, { timeMs: -87.1, poses: [], extensions: { 6: 98798.8 } }]);
  const decoded = decodePoseFile(encodePoseFile(frames));
  assert.equal(decoded.clock, 'song');
  const capture = decoded.extensions.get(6)!;
  assert.equal(capture[0], 98765.4321, 'the base is the first value');
  assert.ok(Math.abs(capture[1] - 98798.8) <= .0005);
});

test('every kind holds one to four dancers, a track exactly one', () => {
  const header: PoseHeaderInput = { kind: 'recording', playerSlots: 4, input: { width: 640, height: 480 }, modelId: null, extensionIds: [EXTENSION.captureBrowserTimeMs], provenance: { songId: 'demo' } };
  const four = [0, 1, 2, 3].map(id => pose(id, 0));
  const bytes = encodePoseFile(buildFrames(header, [{ timeMs: 0, poses: four, extensions: { 6: 1 } }, { timeMs: 10, poses: [four[3]], extensions: { 6: 2 } }]));
  const decoded = decodePoseFile(bytes);
  assert.equal(decoded.playerSlots, 4);
  assertClose(framesToSamples(decoded, 'songTimeMs')[0], { poses: four, quality: qualityFor(four) }, 0);
  assert.deepEqual(framesToSamples(decoded, 'songTimeMs')[1].poses.map(p => p.playerId), [3]);
  // Five slots are refused when writing and reading.
  const five = bytes.slice(); five[chunkAt(five, 'HEAD') + 4] = 5;
  assert.throws(() => decodePoseFile(five), /player slots must be 1 to 4/);
  assert.throws(() => buildFrames({ ...header, playerSlots: 5 as PlayerCount }, []), /player slots must be 1 to 4/);
  assert.throws(() => new PoseFileWriter({ kind: 'capture', playerSlots: 5 as PlayerCount, input: { width: 640, height: 480 }, modelId: 'lite', capture: { sourceKind: 'webcam', sessionId: 's', audioPlaybackRate: 1 } }), /player slots must be 1 to 4/);
  // Takes and captures of four dancers.
  for (const kind of ['capture', 'take'] as const) {
    const capture = kind === 'capture' ? { capture: { sourceKind: 'video' as const, sessionId: 's', audioPlaybackRate: null } } : {};
    const frames = buildFrames({ kind, playerSlots: 4, input: { width: 640, height: 480 }, modelId: 'lite', ...capture }, [{ timeMs: 0, poses: four }, { timeMs: 10, poses: four.slice(1) }]);
    assert.deepEqual(framesToSamples(decodePoseFile(encodePoseFile(frames)), 'takeTimeMs')[1].poses.map(p => p.playerId), [1, 2, 3], kind);
  }
  // A choreography has a track for each of its slots, in order; a track file holds one.
  const valid3 = valid(); valid3[chunkAt(valid3, 'HEAD') + 4] = 3;
  assert.throws(() => decodePoseFile(valid3), /every dancer needs a track/);
});

test('a choreography holds one to four dancers', () => {
  for (const dancers of [1, 3, 4]) {
    const ids = Array.from({ length: dancers }, (_, id) => id);
    const header = { ...choreographyHeader, playerSlots: dancers as PlayerCount, tracks: ids.map(id => ({ ...choreographyHeader.tracks![0], slot: id, playerId: id, label: `Player ${id + 1}` })) };
    const decoded = decodePoseFile(encodePoseFile(framesFromSamples(header, [0, 1000, 2000].map(songTimeMs => ({ songTimeMs, poses: ids.map(id => pose(id, songTimeMs)) })), 'songTimeMs')));
    assert.equal(decoded.playerSlots, dancers);
    assert.deepEqual(decoded.tracks!.map(t => t.playerId), ids);
    assert.deepEqual(framesToSamples(decoded, 'songTimeMs')[1].poses.map(p => p.playerId), ids);
  }
});

const valid = () => encodePoseFile(framesFromSamples(choreographyHeader, [0, 1000, 2000].map(songTimeMs => ({ songTimeMs, poses: [pose(0, songTimeMs), pose(1, songTimeMs)] })), 'songTimeMs'));
/** Byte offset of a chunk's payload. */
function chunkAt(bytes: Uint8Array, tag: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  for (let at = 8; at < bytes.length; at += 8 + view.getUint32(at + 4, true) + (8 - view.getUint32(at + 4, true) % 8) % 8)
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) === tag) return at + 8;
  throw Error(`No ${tag}`);
}
function withChunk(bytes: Uint8Array, tag: string, payload = new Uint8Array(8)) {
  const out = new Uint8Array(bytes.length + 8 + payload.length);
  out.set(bytes); out.set([...tag].map(c => c.charCodeAt(0)), bytes.length);
  new DataView(out.buffer).setUint32(bytes.length + 4, payload.length, true);
  out.set(payload, bytes.length + 8);
  return out;
}

test('decoding rejects malformed files and skips unknown ancillary chunks', () => {
  assert.equal(decodePoseFile(withChunk(valid(), 'zzzz')).times.length, 3);
  const frms = chunkAt(valid(), 'FRMS'), stride = 480;
  const mutations: [string, (b: Uint8Array, v: DataView) => void][] = [
    ['not an .adpose', b => { b[1] = 0; }],
    ['format version', (_, v) => v.setUint16(16, 2, true)],
    ['increasing', (_, v) => v.setFloat64(frms + 8 + stride, -1, true)],
    ['invalid position', (_, v) => v.setInt16(frms + 8 + stride + 16, -32768, true)],
    ['invalid position', (_, v) => v.setUint8(frms + 8 + 8, 1)], // slot 1 marked absent but holding data
    ['frame masks', (_, v) => v.setUint8(frms + 8 + 11, 1)],
    ['endpoint', (_, v) => v.setFloat64(frms + 8 + 2 * stride, 1999, true)],
  ];
  for (const [message, mutate] of mutations) {
    const bytes = valid(); mutate(bytes, new DataView(bytes.buffer));
    assert.throws(() => decodePoseFile(bytes), new RegExp(message), message);
  }
  assert.throws(() => decodePoseFile(withChunk(valid(), 'ZZZZ')), /critical chunk ZZZZ/);
  assert.throws(() => decodePoseFile(withChunk(valid(), 'SONG')), /before the frames/);
  assert.throws(() => decodePoseFile(withChunk(valid(), 'EVNT', new Uint8Array(2))), /EVNT is not allowed/);
  const truncated = valid().subarray(0, valid().length - 100);
  assert.throws(() => decodePoseFile(truncated), /truncated/);
  assert.throws(() => decodePoseFile(truncated, { allowTruncated: true }), /needs FRMS/);
  // A huge frame count is caught against the chunk length before allocating.
  const huge = valid(); new DataView(huge.buffer).setUint32(frms, 0xffffffff, true);
  assert.throws(() => decodePoseFile(huge), /does not match/);
});

test('capture recovery keeps everything before a cut-off final chunk', () => {
  const header: PoseHeaderInput = { kind: 'capture', playerSlots: 1, input: { width: 640, height: 480 }, modelId: 'lite', capture: { sourceKind: 'webcam', sessionId: 's', audioPlaybackRate: 1 } };
  const writer = new PoseFileWriter(header);
  const parts = [writer.start(), writer.frames([{ timeMs: 0, poses: [pose(0, 0)] }]), writer.frames([{ timeMs: 33, poses: [pose(0, 33)] }]).subarray(0, 100)];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { file.set(p, at); return at + p.length; }, 0);
  assert.throws(() => decodePoseFile(file), /truncated/);
  assert.deepEqual([...decodePoseFile(file, { allowTruncated: true }).times], [0]);
});
