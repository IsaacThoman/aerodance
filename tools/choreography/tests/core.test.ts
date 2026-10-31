import { test } from "node:test";
import assert from "node:assert/strict";
import { poseModel, MEDIAPIPE_VERSION } from '../../../packages/pose/browser/models.ts';
import { RECORDED_MODEL_HASHES } from '../../../packages/pose/modelMetadata.ts';
import {
  intervalsCover,
  newProject,
  addTake,
  importMotion,
  compileProject,
  appendOperation,
  reviewReport,
  reviewTimeline,
  missingIntervalsFromTimeline,
  takeFromRecords,
  validateProject,
  overwriteTracks,
  clearTrack,
  offsetTrack,
  historyStep,
  missingIntervals,
  interpolateTrack,
  validateTake,
  isTrackData,
  mirrorTrack,
  recalibrateTrack,
  setDancers,
} from "../core.ts";
import { songChoreographyFromTimeline } from "../../../packages/pose/song.ts";
import { encodePoseFile } from "../../../packages/pose/binary.ts";
import { encodeTake, encodeTrack, decodeTrack, importedPoseFile } from "../poseFiles.ts";
import { readFileSync } from "node:fs";
import type { CaptureMetadata, CompiledChoreography, StudioAssets, Take } from "../core.ts";
import {
  sampleSnapshot,
  mirrorPose,
  validateChoreography,
} from "../../../packages/pose/choreography.ts";
import type { Pose } from "../../../packages/pose/choreography.ts";
import { assertSamplesClose, captureOf, found } from "./helpers.ts";
const sampleAt = (data: CompiledChoreography, songTimeMs: number) =>
  found(data.samples.find((s) => s.songTimeMs === songTimeMs));
const pose = (playerId: number, x = 0.2): Pose => ({
  playerId,
  landmarks: Array.from({ length: 33 }, (_, i) => ({
    x: x + (i % 2) * 0.02,
    y: i < 11 ? 0.15 : i < 23 ? 0.4 : i < 27 ? 0.6 : 0.9,
    z: 0,
    confidence: 0.9,
  })),
});
test('webcam take timing follows frames despite variable inference latency and retains model provenance', () => {
  const model = poseModel('lite');
  const metadata: CaptureMetadata = { sourceKind: 'webcam', takeId: 'webcam-take', status: {
    modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU',
  } };
  const records = [20, 180, 30].map((delay, i) => ({
    receivedBrowserTimeMs: 1000 + i * 100 + delay,
    audioPositionAtReceiptMs: 2000 + i * 100 + delay,
    audioPositionAtFrameMs: 2000 + i * 100, audioPlaybackRate: 1,
    record: { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'webcam', seq: i + 1,
      playerCount: 2, input: { width: 640, height: 480, mirrored: false }, modelId: 'lite',
      frameBrowserTimeMs: 1000 + i * 100, resultBrowserTimeMs: 1000 + i * 100 + delay,
      mediaTimeMs: i * 100, timingMethod: 'browser-frame-observation', poses: [pose(0), pose(1)] },
  }));
  const take = takeFromRecords(captureOf(records, 'webcam'), metadata);
  assert.equal(take.source, 'webcam'); assert.equal(take.offsetMs, 2000);
  assert.deepEqual(take.samples.map(s => s.takeTimeMs), [0, 100, 200]);
  assert.deepEqual(take.samples.map(s => s.sourceSeq), [1, 2, 3]);
  assert.equal(take.provenance?.modelHash, model.sha256);
  const retired = structuredClone(records).map(r => ({ ...r, record: { ...r.record, modelId: 'full' } }));
  const capture = captureOf(retired, 'webcam');
  assert.throws(() => takeFromRecords(capture, metadata), /Invalid webcam model configuration/);
  const historical = takeFromRecords(capture, { ...metadata, status: {
    modelId: 'full', modelHash: RECORDED_MODEL_HASHES.full, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU',
  } });
  assert.equal(historical.provenance?.modelId, 'full');
  assert.equal(historical.provenance?.modelHash, RECORDED_MODEL_HASHES.full);
  assert.equal(importedPoseFile(encodeTake(historical), 'historical.adpose').provenance?.modelId, 'full');
  const early = structuredClone(records); early[1].receivedBrowserTimeMs = early[1].record.resultBrowserTimeMs - 1;
  assert.throws(() => takeFromRecords(captureOf(early, 'webcam'), metadata), /timing/);
});
test('earlier and future project formats and broken tracks fail validation before the editor renders them', () => {
  const project = newProject('format-fixture');
  // Loose views of copies: these tests build projects the types rule out.
  for (const schemaVersion of [1, 2, 4]) {
    const other: { schemaVersion: number } = structuredClone(project); other.schemaVersion = schemaVersion;
    assert.throws(() => validateProject(other), new RegExp(`Unsupported project format ${schemaVersion}`));
  }
  const clips: { tracks: unknown[] } = structuredClone(project);
  clips.tracks = clips.tracks.map((_, playerId) => ({ playerId, label: 'P', clips: [] }));
  assert.throws(() => validateProject(clips), /Invalid track reference/);
});
/** A project whose two tracks hold a take; `edit` changes the take before the tracks copy it. */
function fixture(edit?: (take: Take) => void) {
  const take: Take = {
    schema: "aerodance.take",
    schemaVersion: 1,
    takeId: "take-a",
    name: "A",
    source: "choreography",
    input: { width: 640, height: 480, mirrored: false },
    offsetMs: 0,
    timeScale: 1,
    samples: Array.from({ length: 11 }, (_, i) => ({
      takeTimeMs: i * 100,
      poses: [pose(0), pose(1, 0.7)],
    })),
  };
  edit?.(take);
  const takes: StudioAssets = new Map([[take.takeId, take]]);
  const p = overwriteTracks(addTake(newProject("project-a"), take), take, [0, 1], takes);
  p.durationMs = 1000;
  p.playableEndMs = 1000;
  p.audio = { sha256: "a".repeat(64), extension: "wav", mimeType: "audio/wav", durationMs: 1000, name: "song.wav" };
  p.metadata.artist = "Artist";
  p.metadata.rights.audio.license = "CC0";
  p.metadata.rights.choreography.license = "CC0";
  p.alignmentReviewed = true;
  return { p, take, takes };
}
test('body recalibration uses the edited frame with offsets, persists, and supports undo/redo without changing poses', () => {
  for (const playerId of [0, 1]) {
    const { p: initial, takes, take } = fixture();
    let p = offsetTrack(initial, playerId, -100);
    p = appendOperation(p, { type: 'joint', playerId, joint: 23, value: { x: .4, y: .7, z: -.1 },
      startMs: 100, endMs: 500, timeMs: 300 }, takes);
    const before = structuredClone(p), originalTake = structuredClone(take);
    const source = takes.get(found(p.tracks[playerId].dataId));
    assert.ok(isTrackData(source));
    const beforeSource = structuredClone(source);
    const frame = found(sampleSnapshot(compileProject(p, takes).samples, 300).poses.find(v => v.playerId === playerId));
    p = recalibrateTrack(p, takes, playerId, 300);
    const data = takes.get(found(p.tracks[playerId].dataId));
    assert.ok(isTrackData(data));
    const calibration = found(data.calibration);
    assert.equal(calibration.profileVersion, 2);
    assert.equal(calibration.cameraScaleMode, 'body-relative');
    assert.ok(Math.abs(calibration.baseHip.x - (frame.landmarks[23].x + frame.landmarks[24].x) / 2) < 1e-6);
    assert.ok(Math.abs(calibration.baseHip.y - (frame.landmarks[23].y + frame.landmarks[24].y) / 2) < 1e-6);
    assert.deepEqual(data.samples, source.samples);
    assert.deepEqual(data.sources, source.sources);
    assert.deepEqual(data.exclusions, source.exclusions);
    assert.deepEqual(takes.get(source.dataId), beforeSource);
    assert.deepEqual(take, originalTake);
    assert.deepEqual(p.tracks[1 - playerId], before.tracks[1 - playerId]);
    assert.equal(p.tracks[playerId].originalDataId, before.tracks[playerId].originalDataId);
    assert.equal(p.tracks[playerId].offsetMs, -100);
    assert.deepEqual(historyStep(p, -1).tracks, before.tracks);
    assert.deepEqual(historyStep(historyStep(p, -1), 1).tracks, p.tracks);
    const reloaded = decodeTrack(encodeTrack(data));
    assert.ok(isTrackData(reloaded));
    assert.deepEqual(reloaded.calibration, calibration);
    assert.deepEqual(compileProject(validateProject(JSON.parse(JSON.stringify(p))), takes).tracks[playerId].calibration, calibration);
  }
});
test('body recalibration rejects missing, low confidence, and out-of-frame skeletons', () => {
  for (const change of [
    (take: Take) => { take.samples[5].poses = []; },
    (take: Take) => { take.samples[5].poses[0].landmarks[27].confidence = .1; },
    (take: Take) => { take.samples[5].poses[0].landmarks[11].x = -0.1; },
  ]) {
    const { p, takes } = fixture(change), size = takes.size;
    assert.throws(() => recalibrateTrack(p, takes, 0, 500), /clearly visible/);
    assert.equal(takes.size, size);
  }
  const { p, takes } = fixture();
  assert.throws(() => recalibrateTrack(p, takes, 2, 500), /Invalid calibration player/);
  assert.throws(() => recalibrateTrack(p, takes, 0, NaN), /playable range/);
  assert.throws(() => recalibrateTrack(p, takes, 0, 1100), /playable range/);
  assert.throws(() => recalibrateTrack(clearTrack(p, 0), takes, 0, 500), /no poses/);
});
test('mirroring a complete edited track preserves timing and gaps, reflects calibration, and is independent and undoable', () => {
  for (const sourcePlayerId of [0, 1]) {
    const { p: initial, takes } = fixture(take => { take.samples[5].poses = []; });
    let p = appendOperation(initial, { type: 'joint', playerId: sourcePlayerId, joint: 11, value: { x: .1, y: .2, z: -.3 },
      startMs: 0, endMs: 300, timeMs: 100 }, takes);
    p = appendOperation(p, { type: 'exclude', playerId: sourcePlayerId, startMs: 200, endMs: 400, reason: 'occluded' }, takes);
    p = offsetTrack(p, sourcePlayerId, -200);
    const source = takes.get(found(p.tracks[sourcePlayerId].dataId));
    assert.ok(isTrackData(source));
    source.calibration = { inputWidth: 640, inputHeight: 480, baseHip: { x: .2, y: .6, z: -.1 }, floorY: .9, torsoLength: .2,
      profileVersion: 2, cameraScaleMode: 'body-relative', bodyTorsoLength: .25 };
    const before = structuredClone(p), beforeSource = structuredClone(source), destination = 1 - sourcePlayerId;
    p = mirrorTrack(p, takes, sourcePlayerId);
    const reflected = takes.get(found(p.tracks[destination].dataId));
    assert.ok(isTrackData(reflected));
    assert.deepEqual(takes.get(source.dataId), beforeSource);
    assert.deepEqual(p.tracks[sourcePlayerId], before.tracks[sourcePlayerId]);
    assert.equal(p.tracks[destination].offsetMs, -200);
    assert.deepEqual(reflected.samples.map(s => s.takeTimeMs), source.samples.map(s => s.takeTimeMs));
    assert.deepEqual(reflected.samples.map(s => s.poses.length), source.samples.map(s => s.poses.length));
    for (const [i, sample] of reflected.samples.entries()) {
      if (!sample.poses.length) continue;
      const landmarks = sample.poses[0].landmarks, original = source.samples[i].poses[0].landmarks;
      assert.equal(sample.poses[0].playerId, destination);
      assert.ok(Math.abs(landmarks[12].x - (1 - original[11].x)) < .0001);
      assert.ok(Math.abs(landmarks[12].z - original[11].z) < .0001);
      assert.ok(sample.quality[0].landmarkOrigins.every(o => o === 'edited'));
      assert.ok(sample.quality[0].scoreEligible.every(v => !v));
      assert.equal(sample.quality[0].reviewed, false);
    }
    assert.deepEqual(reflected.exclusions, source.exclusions);
    assert.deepEqual(reflected.sources, source.sources);
    assert.ok(Math.abs(found(reflected.calibration).baseHip.x - .8) < 1e-6);
    assert.equal(found(reflected.calibration).cameraScaleMode, 'body-relative');
    assert.equal(p.alignmentReviewed, false);
    assert.deepEqual(historyStep(p, -1).tracks, before.tracks);
    assert.deepEqual(historyStep(historyStep(p, -1), 1).tracks, p.tracks);
    const after = appendOperation(p, { type: 'mirror', playerId: sourcePlayerId, startMs: 0, endMs: 500 }, takes);
    assert.equal(after.tracks[destination].dataId, reflected.dataId);
    assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))).tracks, p.tracks);
  }
  assert.throws(() => mirrorTrack(newProject(), new Map(), 0), /no poses/);
  assert.throws(() => mirrorTrack(newProject(), new Map(), 2), /Invalid source/);
});
test("finite playback preserves explicit identity and never bridges missing snapshots", () => {
  const samples = [
    { songTimeMs: 0, poses: [pose(1)] },
    { songTimeMs: 100, poses: [] },
    { songTimeMs: 200, poses: [pose(1, 0.8)] },
  ];
  assert.deepEqual(sampleSnapshot(samples, 50).poses, []);
  assert.deepEqual(sampleSnapshot(samples, 150).poses, []);
  assert.equal(sampleSnapshot(samples, 200).poses[0].playerId, 1);
  assert.deepEqual(sampleSnapshot(samples, 201).poses, []);
  assert.deepEqual(
    sampleSnapshot(
      [
        { songTimeMs: 0, poses: [pose(0)] },
        { songTimeMs: 501, poses: [pose(0)] },
      ],
      250,
    ).poses,
    [],
  );
});
test("pose edit is reversible, preserves measured confidence and needs review", () => {
  const { p, takes, take } = fixture(),
    raw = JSON.stringify(take);
  const edited = appendOperation(p, {
    type: "joint",
    playerId: 0,
    startMs: 300,
    endMs: 700,
    timeMs: 500,
    joint: 15,
    value: { x: 0.44, y: 0.23, z: -0.1 },
  }, takes);
  const data = compileProject(edited, takes),
    s = sampleAt(data, 500);
  // Snapshots store positions in 1/16384 steps and confidence in 1/254 steps.
  assert.equal(s.poses[0].landmarks[15].x, Math.round(0.44 * 16384) / 16384);
  assert.equal(s.poses[0].landmarks[15].confidence, Math.round(0.9 * 254) / 254);
  assert.equal(s.quality[0].scoreEligible[15], false);
  assert.equal(JSON.stringify(take), raw);
  assert.deepEqual(
    sampleAt(compileProject(historyStep(edited, -1), takes), 500).poses,
    sampleAt(compileProject(p, takes), 500).poses,
  );
});
test("exclusions override approvals and single-player track 0 matches the two-player track", () => {
  const { p, takes } = fixture();
  let edited = appendOperation(p, {
    type: "exclude",
    playerId: 0,
    startMs: 400,
    endMs: 600,
    reason: "occlusion",
  }, takes);
  edited = appendOperation(edited, {
    type: "approve",
    playerId: 0,
    startMs: 0,
    endMs: 1000,
    reason: "reviewed",
  }, takes);
  const data = compileProject(edited, takes);
  assert.ok(
    sampleAt(data, 500)
      .quality[0].scoreEligible.every((v) => !v),
  );
  const reference = sampleSnapshot(data.samples, 250).poses.find(
    (p) => p.playerId === 0,
  );
  assert.deepEqual(reference, sampleSnapshot(data.samples, 250).poses[0]);
  assert.equal(reviewReport(edited, data).blockers.length, 0);
});
test("mirror swaps every anatomical pair and is an involution, without changing player ID", () => {
  const p = pose(1);
  p.landmarks[15].x = 0.13;
  p.landmarks[16].x = 0.77;
  const mirrored = mirrorPose(p);
  assert.equal(mirrored.playerId, 1);
  assert.ok(Math.abs(mirrored.landmarks[15].x - 0.23) < 1e-10);
  const twice = mirrorPose(mirrored);
  p.landmarks.forEach((j, i) =>
    assert.ok(Math.abs(j.x - twice.landmarks[i].x) < 1e-10),
  );
});
test("legacy migration keeps both original confidence fields unknown", async () => {
  const legacy = {
    version: 1,
    duration: 0.2,
    source: { width: 640, height: 480 },
    times: [0, 0.1],
    poses: [0, 1].map(() =>
      [pose(0), pose(1)].map((p) =>
        p.landmarks.map((j) => [j.x, j.y, j.z, 0.9]),
      ),
    ),
  };
  const take = importMotion(legacy, "demo", "demo-take");
  assert.equal(take.samples[0].poses[0].landmarks[0].confidence, null);
  assert.equal(take.samples[1].takeTimeMs, legacy.times[1] * 1000);
});
test("captures need a webcam or video source", () => {
  const capture = captureOf([0, 1].map((i) => ({
    receivedBrowserTimeMs: i * 100 + 30, audioPositionAtReceiptMs: i * 100 + 30, audioPositionAtFrameMs: i * 100, audioPlaybackRate: 1,
    record: { schema: "aerodance.webcam-record", schemaVersion: 1, type: "pose", sessionId: "s", seq: i + 1, playerCount: 2,
      input: { width: 640, height: 480, mirrored: false }, modelId: "lite", frameBrowserTimeMs: i * 100,
      resultBrowserTimeMs: i * 100 + 20, mediaTimeMs: i * 100, timingMethod: "browser-frame-observation", poses: [pose(0), pose(1)] },
  })), "webcam");
  for (const sourceKind of [undefined, "android", "bogus"])
    assert.throws(
      () => takeFromRecords(capture, { takeId: "capture", sourceKind }),
      /Unsupported capture source/,
    );
  assert.throws(() => takeFromRecords(capture, { takeId: "capture", sourceKind: "video" }), /does not match/);
});
test("runtime validation rejects corrupt payloads and timestamps", () => {
  const { p, takes } = fixture(),
    data = compileProject(p, takes);
  data.samples[1].poses[0].landmarks[0].x = Infinity;
  assert.throws(() => validateChoreography(data), /finite/);
  const bad = compileProject(p, takes);
  bad.samples[1].songTimeMs = bad.samples[0].songTimeMs;
  assert.throws(() => validateChoreography(bad), /times/);
});
test("gap repair requires bounded endpoints and never invents measured confidence", () => {
  const { p, takes } = fixture((take) => {
    take.samples[4].poses = [];
    take.samples[5].poses = [];
  });
  const edited = appendOperation(p, {
    type: "repair",
    playerId: 0,
    startMs: 300,
    endMs: 600,
  }, takes);
  const data = compileProject(edited, takes),
    s = sampleAt(data, 500);
  assert.equal(s.poses[0].playerId, 0);
  assert.equal(s.poses[0].landmarks[0].confidence, null);
  assert.ok(s.quality[0].landmarkOrigins.every((v) => v === "gap-repaired"));
  assert.ok(s.quality[0].scoreEligible.every((v) => !v));
  assert.throws(() => appendOperation(p, {
    type: "repair",
    playerId: 0,
    startMs: 0,
    endMs: 2000,
  }, takes), /at most one second/);
});

test("grouped keyframes translate points together, preserve confidence and undo as one edit", () => {
  const { p, takes } = fixture();
  const original = sampleAt(compileProject(p, takes), 500);
  const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const targets = indices.map((joint) => ({
    joint,
    value: {
      x: original.poses[0].landmarks[joint].x + 0.1,
      y: original.poses[0].landmarks[joint].y + 0.05,
      z: original.poses[0].landmarks[joint].z,
    },
  }));
  const edited = appendOperation(p, {
    type: "joint",
    playerId: 0,
    joint: 0,
    value: targets[0].value,
    targets,
    timeMs: 500,
    startMs: 350,
    endMs: 650,
  }, takes);
  const compiled = compileProject(edited, takes);
  const frame = sampleAt(compiled, 500);
  for (const i of indices) {
    assert.ok(
      Math.abs(
        frame.poses[0].landmarks[i].x - original.poses[0].landmarks[i].x - 0.1,
      ) <= 1 / 16384,
    );
    assert.equal(
      frame.poses[0].landmarks[i].confidence,
      original.poses[0].landmarks[i].confidence,
    );
    assert.equal(frame.quality[0].scoreEligible[i], false);
  }
  assert.deepEqual(
    frame.poses[0].landmarks[15],
    original.poses[0].landmarks[15],
  );
  assert.deepEqual(frame.poses[1], original.poses[1]);
  assert.deepEqual(
    compileProject(historyStep(edited, -1), takes).samples,
    compileProject(p, takes).samples,
  );
});

test("songs dance on openreef unless the project picks another stage", () => {
  const p = newProject("stage-test");
  assert.equal(p.metadata.stage, "openreef");
  p.metadata.stage = "club";
  validateProject(p);
  // Loose view: these steps store stages the types rule out.
  const metadata: { stage?: string } = p.metadata;
  metadata.stage = "moon";
  assert.throws(() => validateProject(p), /dance stages/);
  // Projects saved before songs had stages pick up the default.
  delete metadata.stage;
  validateProject(p);
  assert.equal(p.metadata.stage, "openreef");
  // Projects saved on the removed reef stage move to openreef.
  metadata.stage = "reef";
  validateProject(p);
  assert.equal(p.metadata.stage, "openreef");
});

function independent(take = fixture().take) {
  const assets: StudioAssets = new Map([[take.takeId, take]]);
  let p = addTake(newProject("independent"), take);
  assert.ok(p.tracks.every((t) => t.dataId === null));
  p = overwriteTracks(p, take, [0, 1], assets);
  return { p, take, assets };
}
test("tracks own copied data, survive take deletion, and support atomic overwrite/undo", () => {
  const { p, take, assets } = independent();
  p.alignmentReviewed = true;
  const libraryOnly = addTake(p, { ...take, takeId: "unassigned" });
  assert.equal(libraryOnly.alignmentReviewed, true);
  assert.deepEqual(libraryOnly.tracks, p.tracks);
  const first = compileProject(p, assets);
  take.samples[5].poses[0].landmarks[0].x = 0.99;
  p.takes = [];
  assets.delete(take.takeId);
  assert.deepEqual(compileProject(p, assets).samples, first.samples);
  assert.equal(
    compileProject(p, assets).provenance.sources[0].takeId,
    take.takeId,
  );
  const other = { ...fixture().take, takeId: "replacement", offsetMs: -100 };
  other.samples.forEach((s) => (s.poses[0].landmarks[0].x = 0.4));
  const overwritten = overwriteTracks(p, other, [0], assets);
  assert.deepEqual(overwritten.tracks[1], p.tracks[1]);
  assert.equal(overwritten.tracks[0].offsetMs, -100);
  assert.deepEqual(historyStep(overwritten, -1).tracks, p.tracks);
  assert.deepEqual(
    historyStep(historyStep(overwritten, -1), 1).tracks,
    overwritten.tracks,
  );
  const both = overwriteTracks(p, other, [0, 1], assets);
  assert.equal(both.operationCursor, p.operationCursor + 1);
  assert.ok(both.tracks.every((t) => t.offsetMs === -100));
});
test("independent negative offsets crop export and recover poses and edits on realignment", () => {
  const { p: initial, assets } = independent();
  let p = initial;
  p = appendOperation(
    p,
    {
      type: "joint",
      playerId: 0,
      joint: 15,
      timeMs: 100,
      startMs: 0,
      endMs: 200,
      value: { x: 0.55, y: 0.4, z: 0 },
    },
    assets,
  );
  const other = structuredClone(p.tracks[1]);
  p = offsetTrack(p, 0, -100);
  const data = compileProject(p, assets);
  assert.ok(data.samples.every((s) => s.songTimeMs >= 0));
  // Snapshots store positions in 1/16384 steps.
  assert.equal(data.samples[0].poses[0].landmarks[15].x, Math.round(0.55 * 16384) / 16384);
  assert.deepEqual(p.tracks[1], other);
  p = offsetTrack(p, 0, 0);
  assert.equal(
    sampleSnapshot(compileProject(p, assets).samples, 100).poses[0]
      .landmarks[15].x,
    Math.round(0.55 * 16384) / 16384,
  );
  p = offsetTrack(p, 0, -2000);
  assert.ok(
    compileProject(p, assets).samples.every(
      (s) => !s.poses.some((v) => v.playerId === 0),
    ),
  );
  p = offsetTrack(p, 0, 0);
  assert.equal(compileProject(p, assets).samples[0].poses.length, 2);
  assert.throws(() => offsetTrack(p, 0, NaN), /finite/);
});
test("track deletion clears only its poses and offset and is undoable", () => {
  const { p, assets } = independent();
  const cleared = clearTrack(offsetTrack(p, 0, 100), 0);
  assert.equal(cleared.tracks[0].offsetMs, 0);
  assert.equal(cleared.tracks[0].dataId, null);
  assert.deepEqual(cleared.tracks[1], p.tracks[1]);
  assert.equal(cleared.takes.length, p.takes.length);
  assert.ok(
    compileProject(cleared, assets).samples.every(
      (s) => s.poses.length === 1 && s.poses[0].playerId === 1,
    ),
  );
  assert.equal(historyStep(cleared, -1).tracks[0].dataId, p.tracks[0].dataId);
});
test("interpolation fills short and long bounded gaps, preserves existing poses, and leaves edge gaps", () => {
  const take = fixture().take;
  take.samples = [
    { takeTimeMs: 0, poses: [] },
    { takeTimeMs: 100, poses: [pose(0, 0.1), pose(1)] },
    { takeTimeMs: 200, poses: [pose(1)] },
    { takeTimeMs: 400, poses: [pose(0, 0.4), pose(1)] },
    { takeTimeMs: 2000, poses: [pose(0, 0.8), pose(1)] },
    { takeTimeMs: 2100, poses: [] },
  ];
  const { p: initial, assets } = independent(take);
  let p = initial;
  assert.equal(missingIntervals(p, assets, 0).length, 2);
  const before = compileProject(p, assets);
  const repaired = interpolateTrack(p, assets, 0);
  assert.equal(repaired.filled, 2);
  p = repaired.project;
  const data = compileProject(p, assets);
  assert.equal(missingIntervals(p, assets, 0).length, 0);
  assert.deepEqual(data.samples[0].poses, []);
  assert.deepEqual(found(data.samples.at(-1)).poses, []);
  for (const time of [100, 400, 2000])
    assert.deepEqual(
      sampleSnapshot(data.samples, time).poses[0],
      sampleSnapshot(before.samples, time).poses[0],
    );
  const q = found(sampleSnapshot(data.samples, 1000).quality.find(
    (q) => q.playerId === 0,
  ));
  assert.ok(q.landmarkOrigins.every((v) => v === "gap-repaired"));
  assert.ok(q.scoreEligible.every((v) => !v));
  assert.equal(
    sampleSnapshot(data.samples, 1000).poses[0].landmarks[0].confidence,
    null,
  );
  assert.deepEqual(
    p.tracks[1],
    found(repaired.project.operations.at(-1)).beforeTracks[1],
  );
  assert.deepEqual(
    compileProject(historyStep(p, -1), assets).samples,
    before.samples,
  );
  assert.throws(() => interpolateTrack(p, assets, 0), /No bounded/);
});
test("stored exclusions override later approvals and move with their track", () => {
  const { p: initial, assets } = independent();
  let p = initial;
  p = appendOperation(
    p,
    {
      type: "exclude",
      playerId: 0,
      startMs: 200,
      endMs: 400,
      reason: "occlusion",
    },
    assets,
  );
  p = appendOperation(
    p,
    { type: "approve", playerId: 0, startMs: 0, endMs: 1000, reason: "review" },
    assets,
  );
  p = offsetTrack(p, 0, -100);
  assert.ok(
    sampleSnapshot(
      compileProject(p, assets).samples,
      200,
    ).quality[0].scoreEligible.every((v) => !v),
  );
});
test("review coverage combines adjacent and overlapping exclusions", () => {
  const split = [{ startMs: 300, endMs: 500 }, { startMs: 100, endMs: 300 }];
  assert.ok(intervalsCover(split, 233, 433), "two adjacent reviews cover a step that spans both");
  assert.ok(intervalsCover([{ startMs: 100, endMs: 400 }, { startMs: 350, endMs: 600 }], 120, 580));
  assert.ok(!intervalsCover([{ startMs: 100, endMs: 300 }, { startMs: 310, endMs: 500 }], 233, 433), "a hole between reviews stays unreviewed");
  assert.ok(!intervalsCover([], 0, 1));
  assert.ok(!intervalsCover([{ startMs: 150, endMs: 500 }], 100, 200), "coverage must start at the step");
  assert.ok(intervalsCover([{ startMs: 56.9, endMs: 525.7969999985098 }], 523.566667, 525.797), "review bounds that differ from the rounded sample grid by float error still cover it");
});
test("a song has one to four dancers: duet takes fill the extra tracks, which compile, mirror, swap and undo", () => {
  const { p: duet, take, takes } = fixture();
  // Two more dancers start empty; undo takes them away again.
  let p = setDancers(duet, 4);
  assert.deepEqual(p.tracks.map((t) => t.playerId), [0, 1, 2, 3]);
  assert.deepEqual(p.tracks.slice(0, 2), duet.tracks);
  assert.ok(p.tracks.slice(2).every((t) => t.dataId === null));
  assert.deepEqual(historyStep(p, -1).tracks, duet.tracks);
  // The duet take dances the third and fourth dancers too.
  p = overwriteTracks(p, take, [0, 1], takes, [2, 3]);
  const third = takes.get(found(p.tracks[2].dataId));
  assert.ok(isTrackData(third));
  assert.equal(third.playerId, 2);
  assert.ok(third.samples.every((s) => s.poses.every((v) => v.playerId === 2) && s.quality.every((q) => q.playerId === 2)));
  const overwrite = p.operations.at(-1);
  assert.ok(overwrite?.type === "overwrite");
  assert.deepEqual(overwrite.playerIds, [2, 3]);
  const data = compileProject(p, takes);
  assert.deepEqual(data.tracks.map((t) => t.playerId), [0, 1, 2, 3]);
  assert.deepEqual(sampleAt(data, 500).poses.map((v) => v.playerId), [0, 1, 2, 3]);
  validateChoreography(data);
  // Every dancer's coverage is reviewed (the new tracks reset the alignment review, as any track change does).
  assert.deepEqual(reviewTimeline(data).blockers, []);
  assert.deepEqual(reviewReport(p, data).blockers, ["Review and confirm audio alignment"]);
  assert.deepEqual(reviewTimeline(data).coverage.map((c) => c.playerId), [0, 1, 2, 3]);
  assert.equal(songChoreographyFromTimeline({ ...data, songId: "crew" }).playerSlots, 4);
  // Mirroring and swapping reach any other dancer.
  const mirrored = mirrorTrack(p, takes, 0, 3), reflected = takes.get(found(mirrored.tracks[3].dataId));
  assert.ok(isTrackData(reflected) && reflected.playerId === 3);
  assert.deepEqual(mirrored.tracks.slice(0, 3), p.tracks.slice(0, 3));
  const x = (q: typeof p, id: number) => found(sampleAt(compileProject(q, takes), 500).poses.find((v) => v.playerId === id)).landmarks[0].x;
  const swapped = appendOperation(p, { type: "swap", playerId: 1, withPlayerId: 2, startMs: 0, endMs: 1000 }, takes);
  assert.ok(Math.abs(x(swapped, 1) - x(p, 2)) < 1e-6 && Math.abs(x(swapped, 2) - x(p, 1)) < 1e-6);
  assert.ok(Math.abs(x(swapped, 0) - x(p, 0)) < 1e-6 && Math.abs(x(swapped, 3) - x(p, 3)) < 1e-6);
  // Swapped into an empty track, the poses keep their camera frame and calibration.
  const wide = fixture((t) => { t.input = { width: 1280, height: 720, mirrored: false }; });
  const empty = setDancers(wide.p, 3), filled = appendOperation(empty, { type: "swap", playerId: 0, withPlayerId: 2, startMs: 0, endMs: 1000 }, wide.takes);
  const moved = wide.takes.get(found(filled.tracks[2].dataId)), first = wide.takes.get(found(wide.p.tracks[0].dataId));
  assert.ok(isTrackData(moved) && isTrackData(first));
  assert.deepEqual(moved.input, first.input);
  assert.deepEqual(moved.calibration, first.calibration);
  assert.equal(compileProject(filled, wide.takes).tracks[2].calibration.inputWidth, 1280);
  // P1 and P2's swap still means just those two.
  const legacy = appendOperation(p, { type: "swap", playerId: null, startMs: 0, endMs: 1000 }, takes);
  assert.ok(Math.abs(x(legacy, 0) - x(p, 1)) < 1e-6 && Math.abs(x(legacy, 2) - x(p, 2)) < 1e-6);
  // A solo: one dancer, reviewed and compiled alone.
  const solo = setDancers(p, 1), alone = compileProject(solo, takes);
  assert.throws(() => appendOperation(solo, { type: "swap", playerId: null, startMs: 0, endMs: 1000 }, takes), /song's dancers/);
  assert.equal(alone.tracks.length, 1);
  assert.deepEqual(reviewTimeline(alone).coverage.map((c) => c.playerId), [0]);
  assert.deepEqual(historyStep(solo, -1).tracks, p.tracks);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(solo))).tracks, solo.tracks);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))).operations.length, p.operations.length);
  // Only the song's own dancers can be edited or filled.
  for (const dancers of [0, 5, 2.5]) assert.throws(() => setDancers(p, dancers), /one to four dancers/);
  assert.throws(() => overwriteTracks(duet, take, [0], takes, [2]), /song's dancers/);
  assert.throws(() => overwriteTracks(p, take, [0, 1], takes, [2, 2]), /song's dancers/);
  assert.throws(() => mirrorTrack(p, takes, 1, 1), /another dancer/);
  assert.throws(() => mirrorTrack(duet, takes, 0, 2), /another dancer/);
  assert.throws(() => appendOperation(p, { type: "swap", playerId: 1, withPlayerId: 1, startMs: 0, endMs: 1000 }, takes), /two different/);
  assert.throws(() => appendOperation(duet, { type: "swap", playerId: 0, withPlayerId: 3, startMs: 0, endMs: 1000 }, takes), /song's dancers/);
  assert.throws(() => appendOperation(duet, { type: "smooth", playerId: 2, windowMs: 120, startMs: 0, endMs: 1000 }, takes), /song's dancers/);
  for (const op of [() => clearTrack(duet, 2), () => offsetTrack(duet, 3, 0), () => interpolateTrack(duet, takes, 2)]) assert.throws(op);
  const broken: { tracks: unknown[] } = structuredClone(p);
  broken.tracks = [...broken.tracks, { ...p.tracks[0], playerId: 4 }];
  assert.throws(() => validateProject(broken), /One to four ordered dancer tracks/);
  // A four-dancer song imported back into the library keeps every dancer as a take.
  const crew = validateTake(importedPoseFile(encodePoseFile(songChoreographyFromTimeline({ ...data, songId: "crew" })), "crew.adpose"));
  assert.ok(crew.samples.some((s) => s.poses.length === 4));
  assert.deepEqual(validateTake(importedPoseFile(encodeTake(crew), "again.adpose")).samples.map((s) => s.poses.length), crew.samples.map((s) => s.poses.length));
  const refilled = overwriteTracks(setDancers(duet, 4), crew, [0, 1, 2, 3], takes);
  assert.ok(refilled.tracks.every((t) => t.dataId));
});
test("the library imports .adpose takes and song choreography", () => {
  const { take } = fixture();
  const imported = validateTake(importedPoseFile(encodeTake(take), "take.adpose", "imported-take"));
  assert.equal(imported.takeId, "imported-take");
  assert.equal(imported.name, "take.adpose");
  assert.equal(imported.source, "imported");
  assertSamplesClose(imported.samples, take.samples);
  const song = validateTake(importedPoseFile(readFileSync("apps/web/tests/fixtures/song-70c63c8e/choreography.adpose"), "song.adpose"));
  assert.equal(song.source, "choreography");
  assert.equal(song.provenance?.songId, "song-70c63c8e");
  assert.ok(song.samples.some((s) => s.poses.length === 2));
  const assets: StudioAssets = new Map();
  const p = overwriteTracks(addTake(newProject("import-project"), take), take, [0], assets);
  const track = assets.get(found(p.tracks[0].dataId));
  assert.ok(isTrackData(track));
  assert.throws(() => importedPoseFile(encodeTrack(track), "track.adpose"), /Import a take or choreography/);
});

test("unknown licenses do not block export and cached timeline review follows metadata changes", () => {
  const { p, takes } = fixture();
  p.metadata.rights = { audio: { license: "unknown", attribution: "" }, choreography: { license: "unknown", attribution: "" } };
  const data = compileProject(p, takes), analysis = reviewTimeline(data);
  assert.deepEqual(reviewReport(p, data).blockers, []);
  assert.deepEqual(reviewReport(p, data, analysis), reviewReport(p, data));
  const blank = { ...p, metadata: { ...p.metadata, title: "" } };
  assert.ok(reviewReport(blank, data, analysis).blockers.includes("Add song title and artist"));
  assert.equal(reviewReport(blank, data, analysis).coverage, analysis.coverage);
  for (const id of [0, 1]) assert.deepEqual(missingIntervalsFromTimeline(data, id), missingIntervals(p, takes, id));
});
