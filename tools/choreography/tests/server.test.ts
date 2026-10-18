import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudio } from "../server/index.ts";
import { makeZip, readZip, safePath } from "../server/zip.ts";
import { sha } from "../server/store.ts";
import {
  addTake,
  overwriteTracks,
  trackDataIds,
  newProject,
  isTrackData,
  validateProject,
} from "../core.ts";
import type { Project, StudioAssets, Take } from "../core.ts";
import { takeIdOf } from "../web/api.ts";
import { poseModel, MEDIAPIPE_VERSION } from '../../../packages/pose/browser/models.ts';
import { isObject, validateChoreography } from "../../../packages/pose/choreography.ts";
import type { Pose } from "../../../packages/pose/choreography.ts";
import { baseUrl, found, projectOf, read, takeOf, zipJson } from "./helpers.ts";
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
    visibility: 1,
    presence: 1,
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
const webcamRecords = (count: number) => Array.from({ length: count }, (_, i) => ({ ordinal: i, receivedBrowserTimeMs: 1000 + i * 100 + 20,
  audioPositionAtReceiptMs: i * 100 + 20, audioPositionAtFrameMs: 500 + i * 100, audioPlaybackRate: 1,
  record: { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'webcam', seq: i + 1,
    playerCount: 2, input: { width: 640, height: 480, mirrored: false }, modelId: 'lite',
    frameBrowserTimeMs: 1000 + i * 100, resultBrowserTimeMs: 1000 + i * 100 + 20,
    mediaTimeMs: i * 100, timingMethod: 'browser-frame-observation', poses: [pose(0), pose(1)] } }));
const wireRecords = (count: number) => Array.from({ length: count }, (_, i) => ({ ordinal: i, receivedBrowserTimeMs: i * 100,
  audioPositionAtReceiptMs: i * 100, record: { protocolVersion: 2, type: 'pose', sessionId: 's', seq: i + 1,
    frameReceivedTimeMs: i * 100, resultTimeMs: i * 100 + 20, playerCount: 2,
    input: { width: 640, height: 480, mirrored: false }, poses: [pose(0), pose(1)] } }));
test('webcam batches reject protocol-v2 records and preserve a finalized take through export and backup', async t => {
  const { api, base } = await setup(t);
  let p = await projectOf(await api('/api/projects', {}));
  const model = poseModel('lite');
  const status = { modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION, delegate: 'CPU' };
  const takeId = takeIdOf(await (await api(`/api/projects/${p.projectId}/takes`, { sourceKind: 'webcam', status })).json());
  const url = `/api/projects/${p.projectId}/takes/${takeId}`;
  const records = Array.from({ length: 11 }, (_, i) => ({ ordinal: i, receivedBrowserTimeMs: 1000 + i * 100 + 20,
    audioPositionAtReceiptMs: i * 100 + 20, audioPositionAtFrameMs: i * 100, audioPlaybackRate: 1,
    record: { schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose', sessionId: 'webcam', seq: i + 1,
      playerCount: 2, input: { width: 640, height: 480, mirrored: false }, modelId: 'lite',
      frameBrowserTimeMs: 1000 + i * 100, resultBrowserTimeMs: 1000 + i * 100 + 20,
      mediaTimeMs: i * 100, timingMethod: 'browser-frame-observation', poses: [pose(0), pose(1)] } }));
  const mixed = records.map((r, i) => i === 0 ? { ...r, record: { protocolVersion: 2, type: 'pose' } } : r);
  assert.equal((await api(`${url}/batches`, { batchId: 0, records: mixed })).status, 400);
  assert.equal((await api(`${url}/batches`, { batchId: 0, records })).status, 200);
  assert.equal((await api(`${url}/batches`, { batchId: 0, records })).status, 200);
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
  const choreography = zipJson(files, `${p.songId}/choreography.json`);
  assert.equal(read(choreography, 'provenance', 'sources', 0, 'provenance', 'modelId'), 'lite');
  const { calibration } = validateChoreography(choreography).tracks[0];
  assert.equal(calibration.cameraScaleMode,'body-relative');
  assert.ok(found(calibration.bodyTorsoLength)>0);
  const backup = await fetch(`${base}/api/projects/${p.projectId}/backup`);
  const restored = await fetch(`${base}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await backup.arrayBuffer() });
  assert.equal(restored.status, 201); const rp = await projectOf(restored);
  const saved = await takeOf(await fetch(`${base}/api/projects/${rp.projectId}/takes/${rp.takes[0].takeId}`));
  assert.equal(saved.source, 'webcam'); assert.equal(saved.provenance?.modelHash, model.sha256);
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
  return { ...studio, api, base };
}
test("project revisions, persisted audio, bundle integrity and backup restore survive a new store", async (t) => {
  const { api, base, store } = await setup(t);
  let p = await projectOf(await api("/api/projects", {}));
  const uploaded = take();
  assert.equal(
    (await api(`/api/projects/${p.projectId}/import`, uploaded)).status,
    201,
  );
  p = addTake(p, uploaded);
  const assets: StudioAssets = new Map();
  p = overwriteTracks(p, uploaded, [0, 1], assets);
  for (const dataId of trackDataIds(p))
    await store.writeTrack(p.projectId, assets.get(dataId));
  p.metadata.artist = "Artist";
  p.metadata.stage = "club";
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
  const checks = read(zipJson(files, `${p.songId}/checksums.json`), "files");
  // The song carries its stage, so the game opens it on club.
  assert.equal(read(zipJson(files, `${p.songId}/song.json`), "stage"), "club");
  assert.ok(Array.isArray(checks));
  for (const file of checks) {
    assert.ok(isObject(file));
    const bytes = found(files.get(`${p.songId}/${file.path}`));
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
  assert.equal(
    (
      await (
        await fetch(`${base}/api/projects/${rp.projectId}/audio`)
      ).arrayBuffer()
    ).byteLength,
    audio.length,
  );
});
test('stored unsupported projects remain listed but cannot be opened or mutated by this editor', async t => {
  const {api,base,store}=await setup(t);
  const created=await projectOf(await api('/api/projects',{}));
  const p={...created,schemaVersion:3,
    tracks:created.tracks.map(({playerId,label})=>({playerId,label,dataId:'edited',originalDataId:'original',offsetMs:0}))};
  const bytes=Buffer.from(JSON.stringify(p));
  await store.atomic(store.location(p.projectId,'project.json'),bytes);
  const list: unknown=await (await fetch(base+'/api/projects')).json();
  assert.equal(read(list,0,'schemaVersion'),3);
  const opened=await fetch(`${base}/api/projects/${p.projectId}`);
  assert.equal(opened.status,400);
  assert.match(String(await errorOf(opened)),/Unsupported project format 3/);
  const audio=await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`,{
    method:'POST',headers:{'Content-Type':'audio/wav'},body:Buffer.from('audio'),
  });
  assert.equal(audio.status,400);
  assert.equal((await api(`/api/projects/${p.projectId}/takes`,{sourceKind:'webcam'})).status,400);
  assert.equal((await api(`/api/projects/${p.projectId}`,p,'PUT')).status,400);
  assert.deepEqual(await store.read(p.projectId,'project.json'),p);
});
test("record batches are idempotent and finalization rejects missing ordinals", async (t) => {
  const { api } = await setup(t),
    p = await projectOf(await api("/api/projects", {}));
  const capture: unknown = await (
    await api(`/api/projects/${p.projectId}/takes`, { sourceKind: "webcam", status: webcamStatus() })
  ).json();
  assert.equal(read(capture, "name"), "Webcam take");
  const url = `/api/projects/${p.projectId}/takes/${takeIdOf(capture)}`;
  const body = { batchId: 0, records: webcamRecords(2) };
  assert.equal((await api(`${url}/batches`, body)).status, 200);
  assert.equal((await api(`${url}/batches`, body)).status, 200);
  assert.equal(
    (await api(`${url}/finalize`, { batchCount: 1, recordCount: 3 })).status,
    400,
  );
  const done = await api(`${url}/finalize`, { batchCount: 1, recordCount: 2 });
  assert.equal(done.status, 200);
  const take = await takeOf(done);
  assert.equal(take.samples.length, 2);
  assert.equal(take.offsetMs, 500);
  assert.equal(take.source, "webcam");
  assert.equal((await api(`${url}/batches`, body)).status, 400);
});
test("capture uploads require a webcam or video source and stale Android captures cannot resume", async (t) => {
  const { api, store } = await setup(t),
    p = await projectOf(await api("/api/projects", {}));
  for (const body of [{}, { sourceKind: "android" }, { sourceKind: "bogus" }]) {
    const response = await api(`/api/projects/${p.projectId}/takes`, body);
    assert.equal(response.status, 400);
    assert.equal(await errorOf(response), "Invalid capture source");
  }
  // Capture folders left by older editors: Android, and before sourceKind existed.
  for (const sourceKind of ["android", undefined]) {
    const takeId = crypto.randomUUID(),
      folder = store.location(p.projectId, "capture", takeId);
    await store.atomic(path.join(folder, "capture.json"),
      Buffer.from(JSON.stringify({ takeId, projectId: p.projectId, name: "Android take", sourceKind })));
    await store.atomic(path.join(folder, "batches", "0.json"), Buffer.from(JSON.stringify(wireRecords(2))));
    const url = `/api/projects/${p.projectId}/takes/${takeId}`;
    for (const records of [wireRecords(2), []]) {
      const response = await api(`${url}/batches`, { batchId: 1, records });
      assert.equal(response.status, 400);
      assert.equal(await errorOf(response), "Unsupported capture source");
    }
    const finalized = await api(`${url}/finalize`, { batchCount: 1, recordCount: 2 });
    assert.equal(finalized.status, 400);
    assert.equal(await errorOf(finalized), "Unsupported capture source");
  }
  assert.deepEqual(read(await store.read(p.projectId, "project.json"), "takes"), []);
});
test("projects with stored Android takes open, compile, export, back up and restore", async (t) => {
  const { api, base, store } = await setup(t);
  const stored = take("android");
  stored.provenance = { sessionId: "s", sequenceGaps: 0, synthetic: false, alignmentMethod: "receipt-estimate" };
  const assets: StudioAssets = new Map([[stored.takeId, stored]]);
  let p: Project = overwriteTracks(addTake(newProject("android-project"), stored), stored, [0, 1], assets);
  p.metadata.artist = "Artist";
  p.metadata.rights.audio.license = "CC0";
  p.metadata.rights.choreography.license = "CC0";
  await store.writeTake(p.projectId, stored);
  for (const dataId of trackDataIds(p)) await store.writeTrack(p.projectId, assets.get(dataId));
  // The raw capture an Android take was finalized from travels with backups.
  const raw = Buffer.from(wireRecords(2).map((e) => JSON.stringify(e) + "\n").join(""));
  await store.atomic(store.location(p.projectId, "capture", stored.takeId, "records.ndjson"), raw);
  p = await store.save(p, null);
  const opened = await fetch(`${base}/api/projects/${p.projectId}`);
  assert.equal(opened.status, 200);
  p = await projectOf(opened);
  assert.equal(p.takes[0].source, "android");
  p = await projectOf(await fetch(`${base}/api/projects/${p.projectId}/audio?durationMs=1000&revision=${p.revision}`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from("fixture audio"),
  }));
  p.alignmentReviewed = true;
  p = await projectOf(await api(`/api/projects/${p.projectId}`, p, "PUT"));
  const compiled = await api(`/api/projects/${p.projectId}/compile`, { revision: p.revision });
  assert.equal(compiled.status, 200, await compiled.clone().text());
  const exported = await fetch(`${base}/api/projects/${p.projectId}/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const files = readZip(Buffer.from(await exported.arrayBuffer()));
  const choreography = zipJson(files, `${p.songId}/choreography.json`);
  assert.equal(read(choreography, "provenance", "sources", 0, "source"), "android");
  assert.ok(validateChoreography(choreography).samples.some((s) => s.poses.length === 2));
  const backup = Buffer.from(await (await fetch(`${base}/api/projects/${p.projectId}/backup`)).arrayBuffer());
  assert.deepEqual(readZip(backup).get(`raw/${stored.takeId}.ndjson`), raw);
  const restored = await fetch(`${base}/api/restore`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: backup });
  assert.equal(restored.status, 201);
  const rp = await projectOf(restored);
  const saved = await takeOf(await fetch(`${base}/api/projects/${rp.projectId}/takes/${stored.takeId}`));
  assert.equal(saved.source, "android");
  assert.deepEqual(
    (await store.compile(rp)).data.samples,
    (await store.compile(p)).data.samples,
  );
  assert.deepEqual(await readFile(store.location(rp.projectId, "capture", stored.takeId, "records.ndjson")), raw);
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
  const uploaded = take();
  await api(`/api/projects/${p.projectId}/import`, uploaded);
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
test("opening and restoring legacy projects migrates their independent tracks", async (t) => {
  const { base, store } = await setup(t);
  const uploaded = take("android");
  let p: Project = addTake(newProject("legacy-project", 1), uploaded);
  await store.writeTake(p.projectId, uploaded);
  p = await store.save(p, null);
  const legacyBackup = await (
    await fetch(`${base}/api/projects/${p.projectId}/backup`)
  ).arrayBuffer();
  const opened = validateProject(await (
    await fetch(`${base}/api/projects/${p.projectId}`)
  ).json());
  assert.equal(opened.schemaVersion, 2);
  assert.equal(opened.revision, p.revision + 1);
  assert.equal((await store.compile(opened)).data.samples[0].poses.length, 2);
  assert.equal(
    (await projectOf(await fetch(`${base}/api/projects/${p.projectId}`)))
      .revision,
    opened.revision,
  );
  const restored = await fetch(base + "/api/restore", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: legacyBackup,
  });
  assert.equal(restored.status, 201);
  const copy = validateProject(await restored.json());
  assert.equal(copy.schemaVersion, 2);
  assert.equal((await store.compile(copy)).data.samples[0].poses.length, 2);
});

test("capture payload limits use compact bytes rather than storage indentation", async t => {
  const { api } = await setup(t), p = await projectOf(await api("/api/projects", {}));
  const capture = await api(`/api/projects/${p.projectId}/takes`, { sourceKind: "webcam", status: webcamStatus() });
  const takeId = takeIdOf(await capture.json()), records = webcamRecords(1);
  for (const pose of records[0].record.poses) for (const joint of pose.landmarks)
    Object.assign(joint, { x: -0.0000012345678901234567, y: -0.0000012345678901234567, z: -0.0000012345678901234567,
      visibility: 0.0000012345678901234567, presence: 0.0000012345678901234567 });
  assert.ok(Buffer.byteLength(JSON.stringify(records[0].record)) < 16384);
  assert.ok(Buffer.byteLength(JSON.stringify(records[0].record, null, 2)) > 16384);
  const result = await api(`/api/projects/${p.projectId}/takes/${takeId}/batches`, { batchId: 0, records });
  assert.equal(result.status, 200, await result.text());
});
