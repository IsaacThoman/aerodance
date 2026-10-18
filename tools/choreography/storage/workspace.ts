import { Store, decode, equal, httpError, id, isMissing, json, sha } from "./store.ts";
import { makeZip, readZip } from "./zip.ts";
import { CAPTURE_SOURCES, assertCaptureMetadata, assertProject, takeFromRecords, takeSummary, trackDataIds } from "../core.ts";
import type { AudioExtension, CalibrationFrame, CaptureMetadata, ProjectAudio, Take } from "../core.ts";
import { captureHead, captureHeader, concatBytes, decodeCaptureBatch } from "../poseFiles.ts";
import { decodePoseFile } from "../../../packages/pose/binary.ts";
import { isObject, oneOf, validatePoses } from "../../../packages/pose/choreography.ts";

const AUDIO_TYPES: Readonly<Record<string, AudioExtension>> = {
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/flac": "flac",
};
const count = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
export const missing = () => Object.assign(Error("Project/asset not found"), { code: "ENOENT" });
/** A capture this editor started, so it can append to and finalize it. */
function resumable(metadata: CaptureMetadata): CaptureMetadata {
  if (!oneOf(CAPTURE_SOURCES, metadata.sourceKind) || metadata.header === undefined) throw Error("Unsupported capture source");
  return metadata;
}
/** The largest upload batch: 500 two-player webcam frames plus events. */
const MAX_BATCH_BYTES = 512 * 1024;
const calibrationFrameOf = (value: unknown): CalibrationFrame | undefined => {
  if (value == null) return undefined;
  if (!isObject(value) || typeof value.mediaTimeMs !== "number" || !Number.isFinite(value.mediaTimeMs)) throw Error("Invalid calibration frame time");
  return { mediaTimeMs: value.mediaTimeMs, poses: validatePoses(value.poses) };
};

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
  /** Starts a capture; `header` is the CaptureStart every batch is checked against. */
  async startCapture(projectId: string, request: Record<string, unknown>) {
    const sourceKind = request.sourceKind;
    if (!oneOf(CAPTURE_SOURCES, sourceKind)) throw Error("Invalid capture source");
    if (captureHeader(request.header).capture?.sourceKind !== sourceKind) throw Error("Invalid capture header");
    return this.locked(projectId, async () => {
      await this.project(projectId);
      const takeId = crypto.randomUUID();
      const metadata: CaptureMetadata = { takeId, projectId, name: String(request.name || (sourceKind === "video" ? "Video take" : "Webcam take")).slice(0, 200),
        createdAt: new Date().toISOString(), status: request.status || null, sourceKind, header: request.header };
      await this.atomic(this.location(projectId, "capture", takeId, "capture.json"), json(metadata));
      return metadata;
    });
  }
  async capture(projectId: string, takeId: string): Promise<CaptureMetadata> {
    const value = await this.read(projectId, "capture", id(takeId), "capture.json");
    assertCaptureMetadata(value);
    return value;
  }
  /** Stores one upload: FRMS and EVNT chunks continuing the capture file. Retries must match. */
  async appendBatch(projectId: string, takeId: string, batchId: unknown, bytes: Uint8Array) {
    if (!count(batchId, 0, 4999) || bytes.length > MAX_BATCH_BYTES) throw Error("Invalid record batch");
    return this.locked(projectId, async () => {
      await this.project(projectId);
      const metadata = resumable(await this.capture(projectId, takeId));
      decodeCaptureBatch(captureHead(metadata.header), bytes);
      if (await this.exists(this.location(projectId, "capture", takeId, "sealed"))) throw Error("Take already finalized");
      const filename = this.location(projectId, "capture", takeId, "batches", `${batchId}.bin`);
      try {
        if (!equal(await this.files.read(filename), bytes)) throw Error("Batch retry differs from saved content");
      } catch (e) { if (!isMissing(e)) throw e; await this.atomic(filename, bytes); }
      return { batchId, durable: true };
    });
  }
  /** Joins the batches into capture.adpose and stores the take built from it. */
  async finalize(projectId: string, takeId: string, request: Record<string, unknown>): Promise<Take> {
    return this.locked(projectId, async () => {
      await this.project(projectId);
      const folder = this.location(projectId, "capture", id(takeId));
      const metadata = resumable(await this.capture(projectId, takeId));
      if (await this.exists(`${folder}/sealed`) && metadata.take) return this.take(projectId, metadata.take);
      if (!count(request.batchCount, 1, 5000)) throw Error("Invalid batch count");
      const parts: Uint8Array[] = [captureHead(metadata.header, metadata.sourceKind === "video" ? calibrationFrameOf(request.calibrationFrame) : undefined)];
      for (let n = 0; n < request.batchCount; n++) {
        try { parts.push(await this.files.read(`${folder}/batches/${n}.bin`)); }
        catch (e) { if (isMissing(e)) throw Error("Missing/out-of-order recorder records", { cause: e }); throw e; }
      }
      const bytes = concatBytes(parts), capture = decodePoseFile(bytes);
      if (capture.times.length + capture.events.length !== request.recordCount) throw Error("Incomplete take");
      metadata.interruptionReason = typeof request.interruptionReason === "string" && request.interruptionReason ? request.interruptionReason : null;
      const result = takeFromRecords(capture, metadata);
      const take = { ...result, provenance: { ...result.provenance, rawSha256: await sha(bytes) } };
      const stored = await this.encodeTake(take);
      metadata.take = takeSummary(stored.take);
      // A failed commit leaves the acknowledged batches available for retry.
      await this.files.commit(new Map([
        [`${folder}/capture.adpose`, bytes], [`${folder}/sealed`, new TextEncoder().encode("sealed")],
        [`${folder}/capture.json`, json(metadata)],
        [this.takePath(projectId, takeId), stored.bytes],
      ]), [`${folder}/batches/`]);
      return stored.take;
    });
  }
  async audio(projectId: string): Promise<Blob> {
    const p = await this.project(projectId);
    if (!p.audio) throw missing();
    const bytes = await this.files.read(this.location(projectId, "assets", `${p.audio.sha256}.${p.audio.extension}`));
    return new Blob([new Uint8Array(bytes)], { type: p.audio.mimeType });
  }
  /** A backup ZIP or song bundle. */
  async download(projectId: string, kind: "backup" | "export"): Promise<Uint8Array<ArrayBuffer>> {
    return this.locked(projectId, async () => {
      const p = await this.project(projectId);
      if (kind === "export") return makeZip((await this.bundle(p)).files);
      const files = new Map([["project.json", json(p)]]);
      for (const t of p.takes) {
        files.set(`takes/${t.takeId}.adpose`, new Uint8Array(await this.files.read(this.takePath(projectId, t.takeId))));
        try { files.set(`raw/${t.takeId}.adpose`, new Uint8Array(await this.files.read(this.location(projectId, "capture", t.takeId, "capture.adpose")))); }
        catch (e) { if (!isMissing(e)) throw e; }
      }
      for (const dataId of trackDataIds(p)) files.set(`tracks/${dataId}.adpose`, new Uint8Array(await this.files.read(this.trackPath(projectId, dataId))));
      if (p.audio) files.set(`assets/${p.audio.sha256}.${p.audio.extension}`, new Uint8Array(await this.files.read(this.location(projectId, "assets", `${p.audio.sha256}.${p.audio.extension}`))));
      return makeZip(files);
    });
  }
  /** Restores a backup as a new project. */
  async restore(archive: Uint8Array) {
    const files = await readZip(archive), restored: unknown = JSON.parse(decode(files.get("project.json") || json(null)));
    assertProject(restored);
    const p = restored;
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
    const copy = (from: string, to: string, required = true) => {
      const bytes = files.get(from);
      if (bytes) staged.set(stage.location(p.projectId, ...to.split("/")), bytes);
      else if (required) throw Error(`Backup is missing ${from}`);
    };
    for (const ref of p.takes) {
      copy(`takes/${id(ref.takeId)}.adpose`, `takes/${ref.takeId}.adpose`);
      copy(`raw/${ref.takeId}.adpose`, `capture/${ref.takeId}/capture.adpose`, false);
    }
    for (const dataId of trackDataIds(p)) copy(`tracks/${id(dataId)}.adpose`, `tracks/${dataId}.adpose`);
    if (p.audio) {
      const asset = files.get(`assets/${p.audio.sha256}.${p.audio.extension}`);
      if (!asset || await sha(asset) !== p.audio.sha256) throw Error("Backup audio hash mismatch");
      staged.set(stage.location(p.projectId, "assets", `${p.audio.sha256}.${p.audio.extension}`), asset);
    }
    // Saving checks every take's hash and track's player; decoding checks the files.
    const saved = await stage.save(p, null);
    await stage.takes(saved);
    await this.files.commit(staged);
    return saved;
  }
}
