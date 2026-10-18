import { Store, decode, equal, httpError, id, isMissing, json, sha } from "./store.ts";
import { makeZip, readZip } from "./zip.ts";
import { CAPTURE_SOURCES, assertCaptureMetadata, assertProject, migrateProject, takeFromRecords, trackDataIds, validateTake } from "../core.ts";
import type { AudioExtension, CaptureMetadata, ProjectAudio } from "../core.ts";
import { finite, isArray, isObject, oneOf } from "../../../packages/pose/choreography.ts";
import { validateVideoRecord } from "../../../packages/pose/videoRecord.ts";
import { validateWebcamRecord } from "../../../packages/pose/webcamRecord.ts";

const AUDIO_TYPES: Readonly<Record<string, AudioExtension>> = {
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/flac": "flac",
};
const count = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
export const missing = () => Object.assign(Error("Project/asset not found"), { code: "ENOENT" });

/** Local authoring operations. Both revision checks and mutations run under a project lock. */
export class Workspace extends Store {
  async uploadAudio(projectId: string, bytes: Uint8Array, mime: string, durationMs: number, revision: number, name: string) {
    const extension = Object.hasOwn(AUDIO_TYPES, mime) ? AUDIO_TYPES[mime] : undefined;
    if (!extension) throw Error("Import MP3, WAV, Ogg, M4A or FLAC audio");
    if (!(durationMs > 0 && durationMs <= 3600000)) throw Error("Invalid decoded duration");
    if (bytes.length > 128 * 1024 * 1024) throw Error("Audio exceeds 128 MiB");
    const audio: ProjectAudio = { sha256: await sha(bytes), extension, mimeType: mime, durationMs, name: name.slice(0, 200) };
    return this.locked(projectId, async () => {
      const p = await this.project(projectId);
      if (p.revision !== revision) throw httpError("Project changed. Save/reload before importing.", 409);
      p.audio = audio; p.durationMs = durationMs; p.playableEndMs = durationMs;
      p.playableStartMs = 0; p.alignmentReviewed = false; p.revision++; p.updatedAt = new Date().toISOString();
      await this.files.commit(new Map([
        [this.location(projectId, "assets", `${audio.sha256}.${extension}`), bytes],
        [this.location(projectId, "project.json"), json(p)],
        [this.location(projectId, "revisions", `${p.revision}.json`), json(p)],
      ]));
      return p;
    });
  }
  async importTake(projectId: string, take: unknown) {
    return this.locked(projectId, async () => { await this.project(projectId); return this.writeTake(projectId, take); });
  }
  async startCapture(projectId: string, request: Record<string, unknown>) {
    const sourceKind = request.sourceKind;
    if (!oneOf(CAPTURE_SOURCES, sourceKind)) throw Error("Invalid capture source");
    return this.locked(projectId, async () => {
      await this.project(projectId);
      const takeId = crypto.randomUUID();
      const metadata: CaptureMetadata = { takeId, projectId, name: String(request.name || (sourceKind === "video" ? "Video take" : "Webcam take")).slice(0, 200),
        createdAt: new Date().toISOString(), status: request.status || null, sourceKind };
      await this.atomic(this.location(projectId, "capture", takeId, "capture.json"), json(metadata));
      return metadata;
    });
  }
  async capture(projectId: string, takeId: string): Promise<CaptureMetadata> {
    const value = await this.read(projectId, "capture", id(takeId), "capture.json");
    assertCaptureMetadata(value);
    return value;
  }
  async appendBatch(projectId: string, takeId: string, request: Record<string, unknown>) {
    const { batchId, records } = request;
    if (!count(batchId, 0, 4999) || !isArray(records) || records.length > 500) throw Error("Invalid record batch");
    return this.locked(projectId, async () => {
      await this.project(projectId);
      const metadata = await this.capture(projectId, takeId);
      if (!oneOf(CAPTURE_SOURCES, metadata.sourceKind)) throw Error("Unsupported capture source");
      for (const e of records) {
        if (metadata.sourceKind === "video") {
          if (!isObject(e) || !count(e.ordinal, 0) || !e.record || new TextEncoder().encode(JSON.stringify(e.record)).length > 16384) throw Error("Invalid video record envelope");
          validateVideoRecord(e.record); continue;
        }
        if (!isObject(e) || !count(e.ordinal, 0) || !Number.isFinite(e.receivedBrowserTimeMs) ||
          !Number.isFinite(e.audioPositionAtReceiptMs) || (e.audioPlaybackRate != null && (!finite(e.audioPlaybackRate) || e.audioPlaybackRate <= 0)))
          throw Error("Invalid recorder timing");
        if (e.record) {
          if (new TextEncoder().encode(JSON.stringify(e.record)).length > 16384) throw Error("Pose record exceeds 16 KiB");
          validateWebcamRecord(e.record);
          if (!Number.isFinite(e.audioPositionAtFrameMs)) throw Error("Missing webcam audio anchor");
        } else if (!e.event) throw Error("Missing record/event");
      }
      if (await this.exists(this.location(projectId, "capture", takeId, "sealed"))) throw Error("Take already finalized");
      const filename = this.location(projectId, "capture", takeId, "batches", `${batchId}.json`), bytes = json(records);
      try {
        if (!equal(await this.files.read(filename), bytes)) throw Error("Batch retry differs from saved content");
      } catch (e) { if (!isMissing(e)) throw e; await this.atomic(filename, bytes); }
      return { batchId, durable: true };
    });
  }
  async finalize(projectId: string, takeId: string, request: Record<string, unknown>) {
    return this.locked(projectId, async () => {
      await this.project(projectId);
      const folder = this.location(projectId, "capture", id(takeId));
      if (await this.exists(`${folder}/sealed`)) return this.read(projectId, "takes", `${takeId}.json`);
      const metadata = await this.capture(projectId, takeId), records: Record<string, unknown>[] = [];
      if (!count(request.batchCount, 1, 5000)) throw Error("Invalid batch count");
      for (let n = 0; n < request.batchCount; n++) {
        const batch: unknown = JSON.parse(decode(await this.files.read(`${folder}/batches/${n}.json`)));
        if (!isArray(batch)) throw Error("Missing/out-of-order recorder records");
        for (const e of batch) {
          if (!isObject(e) || e.ordinal !== records.length) throw Error("Missing/out-of-order recorder records");
          records.push(e);
        }
      }
      if (records.length !== request.recordCount) throw Error("Incomplete take");
      metadata.interruptionReason = typeof request.interruptionReason === "string" && request.interruptionReason ? request.interruptionReason : null;
      if (metadata.sourceKind === "video") metadata.calibrationFrame = request.calibrationFrame;
      const result = takeFromRecords(records, metadata);
      const raw = new TextEncoder().encode(records.map(e => JSON.stringify(e) + "\n").join(""));
      const content = { ...result, provenance: { ...result.provenance, rawSha256: await sha(raw) } };
      const saved = { ...content, sha256: await sha(json(content)) };
      // A failed commit leaves the acknowledged batches available for retry.
      await this.files.commit(new Map([
        [`${folder}/records.ndjson`, raw], [`${folder}/sealed`, new TextEncoder().encode("sealed")],
        [this.location(projectId, "takes", `${takeId}.json`), json(saved)],
      ]));
      return saved;
    });
  }
  async audio(projectId: string): Promise<Blob> {
    const p = await this.project(projectId);
    if (!p.audio) throw missing();
    const bytes = await this.files.read(this.location(projectId, "assets", `${p.audio.sha256}.${p.audio.extension}`));
    return new Blob([new Uint8Array(bytes)], { type: p.audio.mimeType });
  }
  async download(projectId: string, kind: "backup" | "export"): Promise<Uint8Array<ArrayBuffer>> {
    return this.locked(projectId, async () => {
      const p = await this.project(projectId);
      if (kind === "export") return makeZip((await this.bundle(p)).files);
      const files = new Map([["project.json", json(p)]]);
      for (const t of p.takes) {
        files.set(`takes/${t.takeId}.json`, new Uint8Array(await this.files.read(this.location(projectId, "takes", `${t.takeId}.json`))));
        try { files.set(`raw/${t.takeId}.ndjson`, new Uint8Array(await this.files.read(this.location(projectId, "capture", t.takeId, "records.ndjson")))); }
        catch (e) { if (!isMissing(e)) throw e; }
      }
      for (const dataId of trackDataIds(p)) files.set(`tracks/${dataId}.json`, new Uint8Array(await this.files.read(this.location(projectId, "tracks", `${dataId}.json`))));
      if (p.audio) files.set(`assets/${p.audio.sha256}.${p.audio.extension}`, new Uint8Array(await this.files.read(this.location(projectId, "assets", `${p.audio.sha256}.${p.audio.extension}`))));
      return makeZip(files);
    });
  }
  async restore(archive: Uint8Array) {
    const files = await readZip(archive), restored: unknown = JSON.parse(decode(files.get("project.json") || json(null)));
    assertProject(restored);
    let p = restored;
    p.projectId = crypto.randomUUID(); p.revision = 0;
    // Validate the entire backup in isolation before a single durable commit.
    const staged = new Map<string, Uint8Array>();
    const stage = new Store({
      read: async name => { const bytes = staged.get(name); if (!bytes) throw missing(); return bytes; },
      has: async name => staged.has(name),
      commit: async entries => { for (const [name, bytes] of entries) staged.set(name, bytes); },
      list: async prefix => [...staged.keys()].filter(name => name.startsWith(prefix)),
      locked: async (_key, fn) => fn(),
    });
    for (const ref of p.takes) {
      const take = validateTake(JSON.parse(decode(files.get(`takes/${ref.takeId}.json`) || json(null))));
      if (take.takeId !== ref.takeId) throw Error("Backup take reference mismatch");
      await stage.writeTake(p.projectId, take);
      const raw = files.get(`raw/${ref.takeId}.ndjson`);
      if (raw) staged.set(stage.location(p.projectId, "capture", ref.takeId, "records.ndjson"), raw);
    }
    if (p.schemaVersion === 1) {
      const assets = await stage.takes(p);
      p = migrateProject(p, assets);
      for (const dataId of trackDataIds(p)) await stage.writeTrack(p.projectId, assets.get(dataId));
    } else {
      for (const dataId of trackDataIds(p)) {
        const data: unknown = JSON.parse(decode(files.get(`tracks/${dataId}.json`) || json(null)));
        if (!isObject(data) || data.dataId !== dataId) throw Error("Backup track reference mismatch");
        await stage.writeTrack(p.projectId, data);
      }
    }
    if (p.audio) {
      const asset = files.get(`assets/${p.audio.sha256}.${p.audio.extension}`);
      if (!asset || await sha(asset) !== p.audio.sha256) throw Error("Backup audio hash mismatch");
      staged.set(stage.location(p.projectId, "assets", `${p.audio.sha256}.${p.audio.extension}`), asset);
    }
    const saved = await stage.save(p, null);
    await this.files.commit(staged);
    return saved;
  }
}
