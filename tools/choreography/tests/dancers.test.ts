import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addTake, appendOperation, compileProject, historyStep, mirrorTrack, newProject, overwriteTracks, reviewTimeline,
  setDancerCount, trackDataIds, validateProject,
} from "../core.ts";
import type { ProjectV3, StudioAssets, Take } from "../core.ts";
import { captureHeader } from "../poseFiles.ts";
import { captureModeLabel, captureModes, capturePlayers, capturePoses, captureSlots, detectionCount, fittingMode } from "../web/captureMode.ts";
import { operationTracks } from "../web/format.ts";
import { createStudio } from "../server/index.ts";
import { readZip } from "../server/zip.ts";
import { validateChoreography } from "../../../packages/pose/choreography.ts";
import type { Pose } from "../../../packages/pose/choreography.ts";
import { validateSongChoreography } from "../../../packages/pose/song.ts";
import { baseUrl, found, projectOf, songFolder, takeOf, zipJson } from "./helpers.ts";

// Dancer n stands at x = 0.2 + 0.2n, so poses show where they came from.
const pose = (playerId: number, x = 0.2 + 0.2 * playerId): Pose => ({
  playerId,
  landmarks: Array.from({ length: 33 }, (_, i) => ({
    x: x + (i % 2) * 0.02, y: i < 11 ? 0.15 : i < 23 ? 0.4 : i < 27 ? 0.6 : 0.9, z: 0, confidence: 0.9,
  })),
});
/** A take of these dancers, one second long. */
const take = (ids: number[], takeId: string = crypto.randomUUID()): Take => ({
  schema: "aerodance.take", schemaVersion: 1, takeId, name: `Dancers ${ids.join()}`, source: "choreography",
  input: { width: 640, height: 480, mirrored: false }, offsetMs: 0, timeScale: 1,
  samples: Array.from({ length: 11 }, (_, i) => ({ takeTimeMs: i * 100, poses: ids.map((id) => pose(id)) })),
});
// The left hip (an even landmark) sits exactly at the dancer's x.
const hipX = (p: Pose | undefined) => found(p).landmarks[24].x;
const at = (p: ProjectV3, assets: StudioAssets, ms: number) => found(compileProject(p, assets).samples.find((s) => s.songTimeMs === ms));

test("projects have one to four ordered tracks, two by default", () => {
  assert.equal(newProject("duet").tracks.length, 2);
  for (const dancers of [1, 2, 3, 4]) {
    const p = validateProject(newProject(`dancers-${dancers}`, dancers));
    assert.deepEqual(p.tracks.map((t) => [t.playerId, t.label]), Array.from({ length: dancers }, (_, i) => [i, `Player ${i + 1}`]));
  }
  for (const dancers of [0, 5, 1.5]) assert.throws(() => newProject("bad", dancers), /one to four dancers/);
  const five: { tracks: unknown[] } = structuredClone(newProject("five", 4));
  five.tracks.push({ ...structuredClone(newProject("five", 4).tracks[3]), playerId: 4 });
  assert.throws(() => validateProject(five), /One to four ordered tracks/);
  const unordered: { tracks: { playerId: number }[] } = structuredClone(newProject("unordered", 3));
  unordered.tracks[2].playerId = 1;
  assert.throws(() => validateProject(unordered), /ordered tracks/);
});

test("a four-dancer song compiles from a duet take, a mirror and a solo copied onto another track", () => {
  const duet = take([0, 1]), solo = take([0]);
  const assets: StudioAssets = new Map([[duet.takeId, duet], [solo.takeId, solo]]);
  let p = addTake(addTake(newProject("quartet", 4), duet), solo);
  p = overwriteTracks(p, duet, [0, 1], assets);
  const overwrite = found(p.operations.at(-1));
  assert.ok(overwrite.type === "overwrite");
  assert.deepEqual(overwrite.playerIds, [0, 1]);
  assert.equal(operationTracks(found(p.operations.at(-1))), "P1 and P2");
  p = mirrorTrack(p, assets, 0, 2);
  assert.equal(operationTracks(found(p.operations.at(-1))), "P1 → P3");
  p = overwriteTracks(p, solo, [0], assets, [3]);
  const data = compileProject(p, assets);
  validateChoreography(data);
  assert.deepEqual(data.tracks.map((t) => t.playerId), [0, 1, 2, 3]);
  const sample = at(p, assets, 500);
  assert.deepEqual(sample.poses.map((v) => v.playerId), [0, 1, 2, 3]);
  // P3 is P1 reflected, and P4 the solo dancer, wherever they stood.
  assert.ok(Math.abs(hipX(sample.poses[2]) - (1 - hipX(sample.poses[0]) - 0.02)) < 1e-3, `${hipX(sample.poses[2])}`);
  assert.ok(Math.abs(hipX(sample.poses[3]) - 0.2) < 1e-3);
  assert.deepEqual(sample.quality.map((q) => q.playerId), [0, 1, 2, 3]);
  assert.equal(reviewTimeline(data).coverage.length, 4);
  // A track nobody has danced yet blocks export.
  const empty = overwriteTracks(addTake(newProject("trio", 3), duet), duet, [0, 1], assets);
  assert.ok(reviewTimeline(compileProject(empty, assets)).blockers.some((b) => /Player 3: no eligible/.test(b)));
  // Takes only go onto tracks the song has.
  assert.throws(() => overwriteTracks(newProject("pair"), solo, [0], assets, [2]), /no track/);
  assert.throws(() => overwriteTracks(p, solo, [0], assets, [1, 2]), /no track/);
});

test("a solo song is one track, and a solo take can fill any track", () => {
  const solo = take([0]);
  const assets: StudioAssets = new Map([[solo.takeId, solo]]);
  const p = overwriteTracks(addTake(newProject("solo", 1), solo), solo, [0], assets);
  const data = compileProject(p, assets);
  validateChoreography(data);
  assert.deepEqual(data.tracks.map((t) => t.playerId), [0]);
  assert.equal(reviewTimeline(data).coverage.length, 1);
  assert.throws(() => mirrorTrack(p, assets, 0), /another track/);
  // In a duet, the solo dancer's take can be P2 too.
  const duet = overwriteTracks(addTake(newProject("solo-duet"), solo), solo, [0], assets, [1]);
  assert.deepEqual(at(duet, assets, 500).poses.map((v) => v.playerId), [1]);
});

test("changing the number of dancers is one undoable step that keeps the removed tracks in the history", () => {
  const quartet = take([0, 1, 2, 3]);
  const assets: StudioAssets = new Map([[quartet.takeId, quartet]]);
  let p = addTake(newProject("resize"), quartet);
  p = overwriteTracks(p, quartet, [0, 1], assets);
  p = setDancerCount(p, 4);
  assert.deepEqual(p.tracks.map((t) => t.dataId === null), [false, false, true, true]);
  assert.equal(operationTracks(found(p.operations.at(-1))), "2 → 4 dancers");
  p = overwriteTracks(p, quartet, [0, 1, 2, 3], assets);
  assert.equal(operationTracks(found(p.operations.at(-1))), "All tracks");
  assert.deepEqual(at(p, assets, 500).poses.map((v) => v.playerId), [0, 1, 2, 3]);
  const kept = p.tracks.map((t) => t.dataId);
  p = setDancerCount(p, 1);
  assert.equal(p.tracks.length, 1);
  assert.deepEqual(at(p, assets, 500).poses.map((v) => v.playerId), [0]);
  validateProject(p);
  // The dropped tracks' snapshots are still needed by the history (and saved with it).
  assert.ok(kept.every((id) => id && trackDataIds(p).includes(id)));
  p = historyStep(p, -1);
  assert.deepEqual(p.tracks.map((t) => t.dataId), kept);
  p = historyStep(p, 1);
  assert.equal(p.tracks.length, 1);
  assert.throws(() => setDancerCount(p, 1), /already/);
  assert.throws(() => setDancerCount(p, 5), /one to four/);
});

test("a swap trades any two tracks' poses over the range; older swaps trade P1 and P2", () => {
  const trio = take([0, 1, 2]);
  const assets: StudioAssets = new Map([[trio.takeId, trio]]);
  const p = overwriteTracks(addTake(newProject("swap", 3), trio), trio, [0, 1, 2], assets);
  const swapped = appendOperation(p, { type: "swap", playerId: 0, withPlayerId: 2, startMs: 200, endMs: 600 }, assets);
  assert.equal(operationTracks(found(swapped.operations.at(-1))), "P1 ↔ P3");
  const inside = at(swapped, assets, 400).poses, outside = at(swapped, assets, 800).poses;
  assert.deepEqual(inside.map(hipX).map((x) => x.toFixed(2)), ["0.60", "0.40", "0.20"]);
  assert.deepEqual(outside.map(hipX).map((x) => x.toFixed(2)), ["0.20", "0.40", "0.60"]);
  const older = appendOperation(p, { type: "swap", playerId: null, startMs: 200, endMs: 600 }, assets);
  assert.deepEqual(at(older, assets, 400).poses.map(hipX).map((x) => x.toFixed(2)), ["0.40", "0.20", "0.60"]);
  for (const [playerId, withPlayerId] of [[0, 0], [0, 3], [null, 1]] as const)
    assert.throws(() => appendOperation(p, { type: "swap", playerId, withPlayerId, startMs: 200, endMs: 600 }, assets), /track/);
});

test("mirroring picks its destination; a duet's goes to the other dancer", () => {
  const duet = take([0, 1]);
  const assets: StudioAssets = new Map([[duet.takeId, duet]]);
  const two = overwriteTracks(addTake(newProject("mirror"), duet), duet, [0], assets);
  assert.equal(mirrorTrack(two, assets, 0).operations.at(-1)?.playerId, 1);
  const four = overwriteTracks(addTake(newProject("mirror-four", 4), duet), duet, [0], assets);
  assert.throws(() => mirrorTrack(four, assets, 0), /another track/);
  assert.throws(() => mirrorTrack(four, assets, 0, 0), /another track/);
  assert.throws(() => mirrorTrack(four, assets, 3, 0), /no poses/);
  assert.equal(mirrorTrack(four, assets, 0, 3).tracks.filter((t) => t.dataId).length, 2);
});

test("captures record every dancer of the song, or one alone in their own slot", () => {
  assert.deepEqual(captureModes(1), ["p1"]);
  assert.deepEqual(captureModes(2), ["all", "p1", "p2"]);
  assert.deepEqual(captureModes(4), ["all", "p1", "p2", "p3", "p4"]);
  assert.deepEqual(["all", "p1"].map((m) => captureModeLabel(m as "all" | "p1", 2)), ["Both players", "P1 only"]);
  assert.equal(captureModeLabel("all", 3), "All 3 dancers");
  assert.deepEqual([capturePlayers("all", 4), capturePlayers("p3", 4)], [[0, 1, 2, 3], [2]]);
  assert.deepEqual([detectionCount("all", 3), detectionCount("p3", 4)], [3, 1]);
  assert.deepEqual([captureSlots("all", 3), captureSlots("p1", 4), captureSlots("p4", 4)], [3, 1, 4]);
  assert.deepEqual(capturePoses([pose(0)], "p4").map((p) => p.playerId), [3]);
  // A mode the song no longer has falls back to everyone (one dancer: P1).
  assert.deepEqual([fittingMode("p4", 2), fittingMode("p2", 1), fittingMode("all", 1), fittingMode("p2", 3)], ["all", "p1", "p1", "p2"]);
  const header = (sourceKind: "webcam" | "video", playerCount: number) => ({
    sourceKind, sessionId: "s", input: { width: 640, height: 480 }, playerCount, modelId: "lite",
    audioPlaybackRate: sourceKind === "webcam" ? 1 : null, extensionBases: sourceKind === "webcam" ? [0, 0, 0, 0, 0] : [],
  });
  for (const kind of ["webcam", "video"] as const) {
    for (const slots of [1, 3, 4]) assert.equal(captureHeader(header(kind, slots)).playerSlots, slots);
    for (const slots of [0, 5]) assert.throws(() => captureHeader(header(kind, slots)), /Invalid capture header/);
  }
});

async function studio(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "dance-studio-dancers-")),
    app = createStudio({ dataDir: root }),
    server = app.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = baseUrl(server);
  const api = (url: string, body: unknown, method = "POST") =>
    fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ...app, api, base };
}

test("export writes the song's dancers into song.json and one choreography track each", async (t) => {
  const { api, base, store } = await studio(t);
  for (const dancers of [1, 3, 4]) {
    let p = await projectOf(await api("/api/projects", {}));
    const imported = await api(`/api/projects/${p.projectId}/import`, take(Array.from({ length: dancers }, (_, i) => i)));
    assert.equal(imported.status, 201, await imported.clone().text());
    const uploaded = await takeOf(imported);
    p = setDancerCount(addTake(p, uploaded), dancers);
    const assets: StudioAssets = new Map();
    p = overwriteTracks(p, uploaded, p.tracks.map((tr) => tr.playerId), assets);
    for (const dataId of trackDataIds(p)) if (assets.has(dataId)) await store.writeTrack(p.projectId, assets.get(dataId));
    p.metadata.title = `${dancers} dancers`;
    p.metadata.artist = "Artist";
    p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
    p = await projectOf(await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`,
      { method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from("fixture audio") }));
    p.alignmentReviewed = true;
    p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
    const exported = await fetch(`${base}/api/projects/${p.projectId}/export`);
    assert.equal(exported.status, 200, await exported.clone().text());
    const files = readZip(Buffer.from(await exported.arrayBuffer())), songId = songFolder(files);
    const song = zipJson(files, `${songId}/song.json`);
    assert.ok(song && typeof song === "object" && "dancerCount" in song);
    assert.equal(song.dancerCount, dancers);
    // The game reads it back with as many dancers as song.json says.
    const choreography = validateSongChoreography(song, found(files.get(`${songId}/choreography.adpose`)));
    assert.equal(choreography.playerSlots, dancers);
    assert.deepEqual(found(choreography.tracks).map((tr) => tr.playerId), Array.from({ length: dancers }, (_, i) => i));
  }
});
