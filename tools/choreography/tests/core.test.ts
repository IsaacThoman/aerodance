import { test } from "node:test";
import assert from "node:assert/strict";
import { poseModel, MEDIAPIPE_VERSION } from '../../../packages/pose/browser/models.ts';
import {
  intervalsCover,
  newProject,
  addTake,
  importMotion,
  compileProject,
  appendOperation,
  reviewReport,
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
} from "../core.ts";
import { encodeTake, encodeTrack, importedPoseFile } from "../poseFiles.ts";
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
  const model = poseModel('full');
  const metadata: CaptureMetadata = { sourceKind: 'webcam', takeId: 'webcam-take', status: {
    modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU',
  } };
  const records = [20, 180, 30].map((delay, i) => ({
    receivedBrowserTimeMs: 1000 + i * 100 + delay,
    audioPositionAtReceiptMs: 2000 + i * 100 + delay,
    audioPositionAtFrameMs: 2000 + i * 100, audioPlaybackRate: 1,
    record: { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'webcam', seq: i + 1,
      playerCount: 2, input: { width: 640, height: 480, mirrored: false }, modelId: 'full',
      frameBrowserTimeMs: 1000 + i * 100, resultBrowserTimeMs: 1000 + i * 100 + delay,
      mediaTimeMs: i * 100, timingMethod: 'browser-frame-observation', poses: [pose(0), pose(1)] },
  }));
  const take = takeFromRecords(captureOf(records, 'webcam'), metadata);
  assert.equal(take.source, 'webcam'); assert.equal(take.offsetMs, 2000);
  assert.deepEqual(take.samples.map(s => s.takeTimeMs), [0, 100, 200]);
  assert.deepEqual(take.samples.map(s => s.sourceSeq), [1, 2, 3]);
  assert.equal(take.provenance?.modelHash, model.sha256);
  const lite = structuredClone(records).map(r => ({ ...r, record: { ...r.record, modelId: 'lite' } }));
  assert.throws(() => takeFromRecords(captureOf(lite, 'webcam'), metadata), /Invalid webcam model configuration/);
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
      input: { width: 640, height: 480, mirrored: false }, modelId: "full", frameBrowserTimeMs: i * 100,
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
test("the library imports .adpose takes and song choreography", () => {
  const { take } = fixture();
  const imported = validateTake(importedPoseFile(encodeTake(take), "take.adpose", "imported-take"));
  assert.equal(imported.takeId, "imported-take");
  assert.equal(imported.name, "take.adpose");
  assert.equal(imported.source, "imported");
  assertSamplesClose(imported.samples, take.samples);
  const song = validateTake(importedPoseFile(readFileSync("client/tests/fixtures/song-70c63c8e/choreography.adpose"), "song.adpose"));
  assert.equal(song.source, "choreography");
  assert.equal(song.provenance?.songId, "song-70c63c8e");
  assert.ok(song.samples.some((s) => s.poses.length === 2));
  const assets: StudioAssets = new Map();
  const p = overwriteTracks(addTake(newProject("import-project"), take), take, [0], assets);
  const track = assets.get(found(p.tracks[0].dataId));
  assert.ok(isTrackData(track));
  assert.throws(() => importedPoseFile(encodeTrack(track), "track.adpose"), /Import a take or choreography/);
});
