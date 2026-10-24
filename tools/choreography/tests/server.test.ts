import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudio } from "../server/index.ts";
import { makeZip, readZip, safePath } from "../server/zip.ts";
import { sha } from "../server/store.ts";
import {
  addTake,
  overwriteTracks,
  setDancers,
  trackDataIds,
  isTrackData,
} from "../core.ts";
import { validateSong, validateSongChoreography } from "../../../packages/pose/song.ts";
import type { StudioAssets, Take } from "../core.ts";
import { takeIdOf } from "../web/api.ts";
import { captureHead, captureHeader } from "../poseFiles.ts";
import type { CaptureStart } from "../poseFiles.ts";
import { EXTENSION, PoseFileWriter, decodePoseFile } from "../../../packages/pose/binary.ts";
import { poseModel, MEDIAPIPE_VERSION } from '../../../packages/pose/browser/models.ts';
import { isObject } from "../../../packages/pose/choreography.ts";
import type { Pose } from "../../../packages/pose/choreography.ts";
import { baseUrl, found, projectOf, read, songFolder, takeOf, zipJson, zipPose } from "./helpers.ts";
const errorOf = async (response: Response) => read(await response.json(), "error");
function trackData(assets: StudioAssets, dataId: string) {
  const data = assets.get(dataId);
  assert.ok(isTrackData(data));
  return data;
}
const pose = (id: number): Pose => ({
  playerId: id,
  landmarks: Array.from({ length: 33 }, (_, i) => ({
    x: id === 0 ? 0.75 : 0.25,
    y: i < 23 ? 0.4 : 0.8,
    z: 0,
    confidence: 1,
  })),
});
const take = (source = "choreography"): Take => ({
  schema: "aerodance.take",
  schemaVersion: 1,
  takeId: crypto.randomUUID(),
  name: "Fixture",
  source,
  input: { width: 640, height: 480, mirrored: false },
  offsetMs: 0,
  timeScale: 1,
  samples: Array.from({ length: 11 }, (_, i) => ({
    takeTimeMs: i * 100,
    poses: [pose(0), pose(1)],
  })),
});
const webcamStatus = () => {
  const model = poseModel('lite');
  return { modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU' };
};
const webcamRecords = (count: number, audioStartMs = 500) => Array.from({ length: count }, (_, i) => ({ ordinal: i, receivedBrowserTimeMs: 1000 + i * 100 + 20,
  audioPositionAtReceiptMs: i * 100 + 20, audioPositionAtFrameMs: audioStartMs + i * 100, audioPlaybackRate: 1,
  record: { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'webcam', seq: i + 1,
    playerCount: 2, input: { width: 640, height: 480, mirrored: false }, modelId: 'lite',
    frameBrowserTimeMs: 1000 + i * 100, resultBrowserTimeMs: 1000 + i * 100 + 20,
    mediaTimeMs: i * 100, timingMethod: 'browser-frame-observation', poses: [pose(0), pose(1)] } }));
const webcamHeader: CaptureStart = { sourceKind: "webcam", sessionId: "webcam", input: { width: 640, height: 480 }, playerCount: 2,
  modelId: "lite", audioPlaybackRate: 1, extensionBases: [1000, 1000, 1000, 0, 0] };
/** Capture records as the frame chunk a recorder uploads. */
const webcamBatch = (records: ReturnType<typeof webcamRecords>) => new PoseFileWriter(captureHeader(webcamHeader)).frames(records.map(e => ({
  timeMs: e.record.mediaTimeMs, poses: e.record.poses, seq: e.record.seq, extensions: {
    [EXTENSION.frameBrowserTimeMs]: e.record.frameBrowserTimeMs, [EXTENSION.resultBrowserTimeMs]: e.record.resultBrowserTimeMs,
    [EXTENSION.receivedBrowserTimeMs]: e.receivedBrowserTimeMs, [EXTENSION.audioPositionAtFrameMs]: e.audioPositionAtFrameMs,
    [EXTENSION.audioPositionAtReceiptMs]: e.audioPositionAtReceiptMs,
  },
})));
test('webcam batches accept only frame and event chunks and preserve a finalized take through export and backup', async t => {
  const { api, upload, base } = await setup(t);
  let p = await projectOf(await api('/api/projects', {}));
  const model = poseModel('lite');
  const status = { modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU' };
  const takeId = takeIdOf(await (await api(`/api/projects/${p.projectId}/takes`, { sourceKind: 'webcam', status, header: webcamHeader })).json());
  const url = `/api/projects/${p.projectId}/takes/${takeId}`;
  const records = webcamRecords(11, 0), batch = webcamBatch(records);
  assert.equal((await upload(`${url}/batches?batchId=0`, captureHead(webcamHeader))).status, 400);
  assert.equal((await api(`${url}/batches?batchId=0`, { batchId: 0, records })).status, 400, 'JSON envelopes are no longer accepted');
  assert.equal((await upload(`${url}/batches?batchId=0`, batch)).status, 200);
  assert.equal((await upload(`${url}/batches?batchId=0`, batch)).status, 200);
  const response = await api(`${url}/finalize`, { batchCount: 1, recordCount: records.length });
  assert.equal(response.status, 200, await response.clone().text());
  const webcamTake = await takeOf(response);
  assert.equal(webcamTake.source, 'webcam'); assert.equal(webcamTake.offsetMs, 0);
  assert.equal(webcamTake.provenance?.modelHash, model.sha256);
  p = addTake(p, webcamTake);
  const assets: StudioAssets = new Map([[webcamTake.takeId, webcamTake]]);
  p = overwriteTracks(p, webcamTake, [0, 1], assets);
  for (const dataId of trackDataIds(p))
    assert.equal((await api(`/api/projects/${p.projectId}/tracks`, assets.get(dataId))).status, 201);
  p.metadata.artist = 'Fixture artist'; p.metadata.rights.audio.license = 'CC0'; p.metadata.rights.choreography.license = 'CC0';
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, 'PUT'));
  p = await projectOf(await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('fixture audio'),
  }));
  p.alignmentReviewed = true; p = await projectOf(await api(`/api/projects/${p.projectId}`, p, 'PUT'));
  const exported = await fetch(`${base}/api/projects/${p.projectId}/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const files = readZip(Buffer.from(await exported.arrayBuffer()));
  const choreography = zipPose(files, `${songFolder(files)}/choreography.adpose`);
  assert.equal(read(choreography.provenance, 'sources', 0, 'provenance', 'modelId'), 'lite');
  const calibration = found(found(choreography.tracks)[0].calibration);
  assert.equal(calibration.cameraScaleMode,'body-relative');
  assert.ok(found(calibration.bodyTorsoLength)>0);
  const backup = await fetch(`${base}/api/projects/${p.projectId}/backup`);
  const restored = await fetch(`${base}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await backup.arrayBuffer() });
  assert.equal(restored.status, 201); const rp = await projectOf(restored);
  const saved = await takeOf(await fetch(`${base}/api/projects/${rp.projectId}/takes/${rp.takes[0].takeId}`));
  assert.equal(saved.source, 'webcam'); assert.equal(saved.provenance?.modelHash, model.sha256);
  const archive = await (await fetch(`${base}/api/projects/${p.projectId}/backup`)).arrayBuffer();
  const raw = found(readZip(Buffer.from(archive)).get(`raw/${takeId}.adpose`));
  assert.equal(decodePoseFile(raw).times.length, 11);
  assert.equal(saved.provenance?.rawSha256, sha(raw), 'the take records the capture file it was built from');
});
async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "dance-studio-")),
    studio = createStudio({ dataDir: root }),
    server = studio.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = baseUrl(server);
  const api = (url: string, body: unknown, method = "POST") =>
    fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const upload = (url: string, bytes: Uint8Array<ArrayBuffer>) =>
    fetch(base + url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
  return { ...studio, api, upload, base };
}
test("project revisions, persisted audio, bundle integrity and backup restore survive a new store", async (t) => {
  const { api, base, store } = await setup(t);
  let p = await projectOf(await api("/api/projects", {}));
  const imported = await api(`/api/projects/${p.projectId}/import`, take());
  assert.equal(imported.status, 201);
  const uploaded = await takeOf(imported);
  p = addTake(p, uploaded);
  const forged = addTake(p, { ...uploaded, takeId: crypto.randomUUID() });
  assert.equal((await api(`/api/projects/${p.projectId}`, forged, "PUT")).status, 404, "a listed take needs its file");
  const assets: StudioAssets = new Map();
  p = overwriteTracks(p, uploaded, [0, 1], assets);
  for (const dataId of trackDataIds(p))
    await store.writeTrack(p.projectId, assets.get(dataId));
  p.metadata.artist = "Artist";
  p.metadata.stage = "club";
  p.metadata.rights.audio.attribution = "Original music attribution";
  p.metadata.rights.choreography.attribution = "Original choreography attribution";
  p.metadata.rights.audio.license = "CC0";
  p.metadata.rights.choreography.license = "CC0";
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  const old = structuredClone(p);
  p.metadata.title = "Saved routine";
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  assert.equal(
    (await api(`/api/projects/${p.projectId}`, old, "PUT")).status,
    409,
  );
  const audio = Buffer.from("fixture audio bytes"),
    uploadedAudio = await fetch(
      `${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`,
      { method: "POST", headers: { "Content-Type": "audio/wav" }, body: audio },
    );
  assert.equal(uploadedAudio.status, 200);
  p = await projectOf(uploadedAudio);
  p.alignmentReviewed = true;
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  const fresh = createStudio({ dataDir: store.root }).store;
  assert.equal(
    read(await fresh.read(p.projectId, "project.json"), "metadata", "title"),
    "Saved routine",
  );
  const exported = await fetch(`${base}/api/projects/${p.projectId}/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const files = readZip(Buffer.from(await exported.arrayBuffer()));
  const songId = songFolder(files);
  assert.match(songId, /^song-[0-9a-f]{16}$/);
  assert.equal(read(zipJson(files, `${songId}/song.json`), "songId"), songId);
  const checks = read(zipJson(files, `${songId}/checksums.json`), "files");
  // The song carries its stage, so the game opens it on club, and its dancers.
  assert.equal(read(zipJson(files, `${songId}/song.json`), "stage"), "club");
  assert.equal(read(zipJson(files, `${songId}/song.json`), "dancers"), 2);
  assert.deepEqual(read(zipJson(files, `${songId}/song.json`), "rights"), {
    audio: { license: "unknown", attribution: "" }, choreography: { license: "unknown", attribution: "" },
  });
  assert.ok(Array.isArray(checks));
  for (const file of checks) {
    assert.ok(isObject(file));
    const bytes = found(files.get(`${songId}/${file.path}`));
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha(bytes), file.sha256);
  }
  const second = await fetch(`${base}/api/projects/${p.projectId}/export`);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), makeZip(files));
  const backup = await fetch(`${base}/api/projects/${p.projectId}/backup`),
    restored = await fetch(`${base}/api/restore`, {
      method: "POST",
      body: await backup.arrayBuffer(),
      headers: { "Content-Type": "application/zip" },
    });
  assert.equal(restored.status, 201);
  const rp = await projectOf(restored);
  assert.notEqual(rp.projectId, p.projectId);
  assert.equal(rp.metadata.title, p.metadata.title);
  assert.deepEqual(rp.metadata.rights, p.metadata.rights);
  assert.equal(
    (
      await (
        await fetch(`${base}/api/projects/${rp.projectId}/audio`)
      ).arrayBuffer()
    ).byteLength,
    audio.length,
  );
  // The song ID follows the dance: the same audio and motion keep it in any project and
  // under new metadata, and changing the motion gives a new one.
  const songIdOf = async (projectId: string) => {
    const response = await fetch(`${base}/api/projects/${projectId}/export`);
    assert.equal(response.status, 200, await response.clone().text());
    const id = songFolder(readZip(Buffer.from(await response.arrayBuffer())));
    assert.match(found(response.headers.get("content-disposition")), new RegExp(`${id}-r\\d+\\.aerodance-song\\.zip`));
    return id;
  };
  assert.equal(await songIdOf(rp.projectId), songId);
  let edited = await projectOf(await api(`/api/projects/${rp.projectId}`, { ...rp, metadata: { ...rp.metadata, title: "Renamed routine" } }, "PUT"));
  assert.equal(await songIdOf(rp.projectId), songId);
  edited = await projectOf(await api(`/api/projects/${rp.projectId}`, { ...edited, playableEndMs: edited.playableEndMs - 100 }, "PUT"));
  assert.notEqual(await songIdOf(edited.projectId), songId);
});
test("a trio exports with three dancers, its third danced from a duet take's first", async (t) => {
  const { api, base, store } = await setup(t);
  let p = await projectOf(await api("/api/projects", {}));
  const uploaded = await takeOf(await api(`/api/projects/${p.projectId}/import`, take()));
  const assets: StudioAssets = new Map();
  p = setDancers(addTake(p, uploaded), 3);
  p = overwriteTracks(p, uploaded, [0, 1], assets);
  p = overwriteTracks(p, uploaded, [0], assets, [2]);
  for (const dataId of trackDataIds(p)) await store.writeTrack(p.projectId, assets.get(dataId));
  p.metadata.artist = "Artist";
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  p = await projectOf(await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`,
    { method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from("fixture audio bytes") }));
  p.alignmentReviewed = true;
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  assert.equal(p.tracks.length, 3);
  const exported = await fetch(`${base}/api/projects/${p.projectId}/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const files = readZip(Buffer.from(await exported.arrayBuffer()));
  const songId = songFolder(files);
  const song = validateSong(zipJson(files, `${songId}/song.json`));
  assert.equal(song.dancers, 3);
  const choreography = validateSongChoreography(song, found(files.get(`${songId}/choreography.adpose`)));
  assert.deepEqual(choreography.tracks.map((t) => t.playerId), [0, 1, 2]);
  assert.equal(choreography.playerSlots, 3);
});
test('stored projects in earlier formats remain listed but cannot be opened or mutated by this editor', async t => {
  const {api,base,store}=await setup(t);
  const created=await projectOf(await api('/api/projects',{}));
  const p={...created,schemaVersion:2,
    tracks:created.tracks.map(({playerId,label})=>({playerId,label,dataId:'edited',originalDataId:'original',offsetMs:0}))};
  const bytes=Buffer.from(JSON.stringify(p));
  await store.atomic(store.location(p.projectId,'project.json'),bytes);
  const list: unknown=await (await fetch(base+'/api/projects')).json();
  assert.equal(read(list,0,'schemaVersion'),2);
  const opened=await fetch(`${base}/api/projects/${p.projectId}`);
  assert.equal(opened.status,400);
  assert.match(String(await errorOf(opened)),/Unsupported project format 2/);
  const audio=await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`,{
    method:'POST',headers:{'Content-Type':'audio/wav'},body:Buffer.from('audio'),
  });
  assert.equal(audio.status,400);
  assert.equal((await api(`/api/projects/${p.projectId}/takes`,{sourceKind:'webcam'})).status,400);
  assert.equal((await api(`/api/projects/${p.projectId}`,p,'PUT')).status,400);
  assert.deepEqual(await store.read(p.projectId,'project.json'),p);
});
test("record batches are idempotent and finalization rejects missing records", async (t) => {
  const { api, upload } = await setup(t),
    p = await projectOf(await api("/api/projects", {}));
  assert.equal((await api(`/api/projects/${p.projectId}/takes`, { sourceKind: "webcam", status: webcamStatus() })).status, 400,
    "a capture declares its header");
  const capture: unknown = await (
    await api(`/api/projects/${p.projectId}/takes`, { sourceKind: "webcam", status: webcamStatus(), header: webcamHeader })
  ).json();
  assert.equal(read(capture, "name"), "Webcam take");
  const url = `/api/projects/${p.projectId}/takes/${takeIdOf(capture)}`;
  const body = webcamBatch(webcamRecords(2));
  assert.equal((await upload(`${url}/batches?batchId=0`, body)).status, 200);
  assert.equal((await upload(`${url}/batches?batchId=0`, body)).status, 200);
  assert.equal((await upload(`${url}/batches?batchId=0`, webcamBatch(webcamRecords(3)))).status, 400, "a retry must match");
  assert.equal(
    (await api(`${url}/finalize`, { batchCount: 1, recordCount: 3 })).status,
    400,
  );
  assert.equal((await api(`${url}/finalize`, { batchCount: 2, recordCount: 2 })).status, 400);
  const done = await api(`${url}/finalize`, { batchCount: 1, recordCount: 2 });
  assert.equal(done.status, 200);
  const take = await takeOf(done);
  assert.equal(take.samples.length, 2);
  assert.equal(take.offsetMs, 500);
  assert.equal(take.source, "webcam");
  assert.equal((await upload(`${url}/batches?batchId=0`, body)).status, 400);
  assert.deepEqual(await takeOf(await api(`${url}/finalize`, { batchCount: 1, recordCount: 2 })), take, "finalizing again returns the take");
});
test("capture uploads require a webcam or video source and a capture this editor started", async (t) => {
  const { api, upload, store } = await setup(t),
    p = await projectOf(await api("/api/projects", {}));
  for (const body of [{}, { sourceKind: "android" }, { sourceKind: "bogus" }]) {
    const response = await api(`/api/projects/${p.projectId}/takes`, body);
    assert.equal(response.status, 400);
    assert.equal(await errorOf(response), "Invalid capture source");
  }
  // A capture folder without a declared header can't take batches or be finalized.
  const takeId = crypto.randomUUID();
  await store.atomic(path.join(store.location(p.projectId, "capture", takeId), "capture.json"),
    Buffer.from(JSON.stringify({ takeId, projectId: p.projectId, name: "Old take", sourceKind: "webcam" })));
  const url = `/api/projects/${p.projectId}/takes/${takeId}`;
  const response = await upload(`${url}/batches?batchId=0`, webcamBatch(webcamRecords(2)));
  assert.equal(response.status, 400);
  assert.equal(await errorOf(response), "Unsupported capture source");
  const finalized = await api(`${url}/finalize`, { batchCount: 1, recordCount: 2 });
  assert.equal(await errorOf(finalized), "Unsupported capture source");
  assert.deepEqual(read(await store.read(p.projectId, "project.json"), "takes"), []);
});
test("write API rejects cross-origin requests and ZIP reader rejects corruption/traversal", async (t) => {
  const { base } = await setup(t);
  assert.equal(
    (
      await fetch(base + "/api/projects", {
        method: "POST",
        headers: {
          Origin: "https://untrusted.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(safePath("../project.json"), false);
  assert.equal(safePath("/data/project.json"), false);
  assert.throws(
    () => makeZip(new Map([["../bad", Buffer.from("bad")]])),
    /Unsafe/,
  );
  const zip = makeZip(new Map([["test.txt", Buffer.from("hello")]]));
  zip[38] ^= 1;
  assert.throws(() => readZip(zip), /checksum/);
});

test("deleting a take preserves tracks, provenance, backup restore, and undo assets", async (t) => {
  const { api, base, store } = await setup(t);
  let p = await projectOf(await api("/api/projects", {}));
  const uploaded = await takeOf(await api(`/api/projects/${p.projectId}/import`, take()));
  p = addTake(p, uploaded);
  const assets: StudioAssets = new Map();
  p = overwriteTracks(p, uploaded, [0, 1], assets);
  for (const dataId of trackDataIds(p)) {
    assert.equal(
      (await api(`/api/projects/${p.projectId}/tracks`, assets.get(dataId)))
        .status,
      201,
    );
    assert.equal(
      (await api(`/api/projects/${p.projectId}/tracks`, assets.get(dataId)))
        .status,
      201,
    );
    const altered = structuredClone(trackData(assets, dataId));
    altered.samples[0].poses[0].landmarks[0].x = 0.88;
    assert.equal(
      (await api(`/api/projects/${p.projectId}/tracks`, altered)).status,
      400,
    );
  }
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  const mismatched = structuredClone(p);
  mismatched.tracks[0].dataId = mismatched.tracks[1].dataId;
  assert.equal(
    (await api(`/api/projects/${p.projectId}`, mismatched, "PUT")).status,
    400,
  );
  const before = await store.compile(p);
  const url = `/api/projects/${p.projectId}/takes/${uploaded.takeId}`;
  assert.equal(
    (await api(url, { revision: p.revision - 1 }, "DELETE")).status,
    409,
  );
  assert.equal((await fetch(base + url)).status, 200);
  const deleted = await api(url, { revision: p.revision }, "DELETE");
  assert.equal(deleted.status, 200);
  p = await projectOf(deleted);
  assert.equal(p.takes.length, 0);
  assert.equal((await fetch(base + url)).status, 404);
  assert.deepEqual((await store.compile(p)).data.samples, before.data.samples);
  assert.equal(
    (await store.compile(p)).data.provenance.sources[0].takeId,
    uploaded.takeId,
  );
  const zip = await (
    await fetch(`${base}/api/projects/${p.projectId}/backup`)
  ).arrayBuffer();
  const restored = await fetch(base + "/api/restore", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: zip,
  });
  assert.equal(restored.status, 201);
  const copy = await projectOf(restored);
  assert.equal(copy.takes.length, 0);
  assert.deepEqual(
    (await store.compile(copy)).data.samples,
    before.data.samples,
  );
  assert.deepEqual(trackDataIds(copy), trackDataIds(p));
});
test("project deletion rejects stale revisions and queued writes cannot recreate it", async (t) => {
  const { api, base, store } = await setup(t);
  const p = await projectOf(await api("/api/projects", {}));
  const url = `/api/projects/${p.projectId}`;
  assert.equal(
    (await api(url, { revision: p.revision - 1 }, "DELETE")).status,
    409,
  );
  assert.equal((await fetch(base + url)).status, 200);
  const uploaded = take(),
    assets: StudioAssets = new Map();
  const assigned = overwriteTracks(
    addTake(p, uploaded),
    uploaded,
    [0, 1],
    assets,
  );
  const data = assets.get(found(assigned.tracks[0].dataId));
  const deleting = store.remove(p.projectId, p.revision);
  const lateSave = store.save(p, p.revision);
  const lateAsset = store.writeTrack(p.projectId, data, true);
  const results = await Promise.allSettled([deleting, lateSave, lateAsset]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[2].status, "rejected");
  assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await api(url + "/tracks", data)).status, 404);
  assert.equal((await api(url + "/import", uploaded)).status, 404);
  assert.deepEqual(await store.list(), []);
});
test("capture batches are binary and bounded", async t => {
  const { api, upload } = await setup(t), p = await projectOf(await api("/api/projects", {}));
  const capture = await api(`/api/projects/${p.projectId}/takes`, { sourceKind: "webcam", status: webcamStatus(), header: webcamHeader });
  const url = `/api/projects/${p.projectId}/takes/${takeIdOf(await capture.json())}/batches`;
  const large = webcamBatch(webcamRecords(1100));
  assert.ok(large.length > 512 * 1024);
  assert.equal((await upload(`${url}?batchId=0`, large)).status, 400);
  assert.equal((await upload(`${url}?batchId=5000`, webcamBatch(webcamRecords(1)))).status, 400);
  assert.equal((await upload(url, webcamBatch(webcamRecords(1)))).status, 400, "the batch number is required");
  assert.equal((await upload(`${url}?batchId=0`, webcamBatch(webcamRecords(500)))).status, 200);
});
