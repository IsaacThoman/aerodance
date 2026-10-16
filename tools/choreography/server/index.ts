import express from "express";
import type { ErrorRequestHandler, Request } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { Store, sha, json, id, httpError, isMissing } from "./store.ts";
import { makeZip, readZip } from "./zip.ts";
import {
  CAPTURE_SOURCES,
  newProject,
  takeFromRecords,
  assertCaptureMetadata,
  assertProject,
  validateTake,
  trackDataIds,
  migrateProject,
} from "../core.ts";
import type { AudioExtension, CaptureMetadata, Project, ProjectAudio } from "../core.ts";
import { finite, isArray, isObject, oneOf } from '../../../packages/pose/choreography.ts';
import { validateWebcamRecord } from '../../../packages/pose/webcamRecord.ts';
import { validateVideoRecord } from '../../../packages/pose/videoRecord.ts';

export interface StudioOptions { dataDir?: string; distDir?: string; }
const AUDIO_TYPES: Readonly<Record<string, AudioExtension>> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/flac": "flac",
};
// Request bodies are untrusted: routes narrow what they read.
function jsonBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!isObject(body)) throw Error("Expected a JSON object");
  return body;
}
const bodyOf = (req: Request): unknown => req.body;
const count = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
async function readCapture(folder: string): Promise<CaptureMetadata> {
  const metadata: unknown = JSON.parse(await fs.readFile(path.join(folder, "capture.json"), "utf8"));
  assertCaptureMetadata(metadata);
  return metadata;
}

export function createStudio({
  dataDir = process.env.STUDIO_DATA_DIR || path.resolve("studio-data"),
  distDir = path.resolve("tools/choreography/dist"),
}: StudioOptions = {}) {
  const app = express(),
    store = new Store(dataDir);
  // Browser writes are same-origin.
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res
        .status(403)
        .json({ error: "Use the studio origin for writes" });
    next();
  });
  app.get("/api/health", async (_req, res) => {
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.access(dataDir, fs.constants.W_OK);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: "Studio data directory is not writable" });
    }
  });
  const raw = express.raw({ type: () => true, limit: "128mb" }),
    body = express.json({ limit: "256mb" });
  app.get("/api/projects", async (_req, res) => res.json(await store.list()));
  app.post("/api/projects", body, async (_req, res) =>
    res.status(201).json(await store.save(newProject(), null)),
  );
  app.get("/api/projects/:projectId", async (req, res) => {
    const project = await store.open(req.params.projectId);
    assertProject(project);
    res.json(project);
  });
  app.put("/api/projects/:projectId", body, async (req, res) => {
    const project = jsonBody(req);
    if (project.projectId !== req.params.projectId)
      throw Error("Project ID mismatch");
    res.json(await store.save(project, project.revision));
  });
  app.delete("/api/projects/:projectId", body, async (req, res) =>
    res.json(await store.remove(id(req.params.projectId), jsonBody(req).revision)),
  );
  app.delete("/api/projects/:projectId/takes/:takeId", body, async (req, res) =>
    res.json(
      await store.remove(
        id(req.params.projectId),
        jsonBody(req).revision,
        id(req.params.takeId),
      ),
    ),
  );
  app.post("/api/projects/:projectId/tracks", body, async (req, res) =>
    res
      .status(201)
      .json(await store.writeTrack(id(req.params.projectId), bodyOf(req), true)),
  );
  app.get("/api/projects/:projectId/tracks/:dataId", async (req, res) =>
    res.json(
      await store.read(
        req.params.projectId,
        "tracks",
        `${id(req.params.dataId)}.json`,
      ),
    ),
  );
  app.get("/api/projects/:projectId/takes/:takeId", async (req, res) =>
    res.json(
      await store.read(
        req.params.projectId,
        "takes",
        `${id(req.params.takeId)}.json`,
      ),
    ),
  );
  app.post("/api/projects/:projectId/import", body, async (req, res) => {
    const projectId = id(req.params.projectId);
    const take = await store.locked(projectId, async () => {
      await store.project(projectId);
      return store.writeTake(projectId, bodyOf(req));
    });
    res.status(201).json(take);
  });
  app.post("/api/projects/:projectId/audio", raw, async (req, res) => {
    const projectId = id(req.params.projectId),
      mime = req.get("content-type")?.split(";")[0],
      extension = mime && Object.hasOwn(AUDIO_TYPES, mime) ? AUDIO_TYPES[mime] : undefined;
    if (!mime || !extension) throw Error("Upload MP3, WAV, Ogg, M4A or FLAC audio");
    const durationMs = Math.round(Number(req.query.durationMs));
    if (!(durationMs > 0 && durationMs <= 3600000))
      throw Error("Invalid decoded duration");
    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes)) throw Error("Upload MP3, WAV, Ogg, M4A or FLAC audio");
    const audio: ProjectAudio = {
      sha256: sha(bytes),
      extension,
      mimeType: mime,
      durationMs,
      name: String(req.query.name || "Song audio").slice(0, 200),
    };
    const next = await store.locked(projectId, async () => {
      const p = await store.project(projectId);
      if (p.revision !== Number(req.query.revision))
        throw httpError("Project changed. Save/reload before uploading.", 409);
      await store.atomic(
        store.location(projectId, "assets", `${audio.sha256}.${extension}`),
        bytes,
      );
      p.audio = audio;
      p.durationMs = durationMs;
      p.playableEndMs = durationMs;
      p.playableStartMs = 0;
      p.alignmentReviewed = false;
      p.revision++;
      p.updatedAt = new Date().toISOString();
      await store.atomic(
        store.location(projectId, "revisions", `${p.revision}.json`),
        json(p),
      );
      await store.atomic(store.location(projectId, "project.json"), json(p));
      return p;
    });
    res.json(next);
  });
  app.get("/api/projects/:projectId/audio", async (req, res) => {
    const p = await store.project(req.params.projectId);
    if (!p.audio) return res.sendStatus(404);
    res
      .type(p.audio.mimeType)
      .sendFile(
        store.location(
          p.projectId,
          "assets",
          `${p.audio.sha256}.${p.audio.extension}`,
        ),
      );
  });
  app.post("/api/projects/:projectId/takes", body, async (req, res) => {
    const request = jsonBody(req), sourceKind = request.sourceKind;
    if (!oneOf(CAPTURE_SOURCES, sourceKind)) throw Error('Invalid capture source');
    const projectId = id(req.params.projectId);
    const metadata = await store.locked(projectId, async () => {
      await store.project(projectId);
      const takeId = randomUUID(),
        metadata: CaptureMetadata = {
          takeId,
          projectId,
          name: String(request.name || (sourceKind === 'video' ? 'Video take' : 'Webcam take')).slice(0, 200),
          createdAt: new Date().toISOString(),
          status: request.status || null,
          sourceKind,
        };
      const folder = store.location(projectId, "capture", takeId);
      await fs.mkdir(path.join(folder, "batches"), { recursive: true });
      await store.atomic(path.join(folder, "capture.json"), json(metadata));
      return metadata;
    });
    res.status(201).json(metadata);
  });
  app.post(
    "/api/projects/:projectId/takes/:takeId/batches",
    body,
    async (req, res) => {
      const projectId = id(req.params.projectId),
        takeId = id(req.params.takeId),
        folder = store.location(projectId, "capture", takeId),
        { batchId, records } = jsonBody(req);
      if (
        !count(batchId, 0) ||
        !isArray(records) ||
        records.length > 500
      )
        throw Error("Invalid record batch");
      const metadata = await readCapture(folder);
      // Captures left unfinished by older editors cannot be resumed.
      if (!oneOf(CAPTURE_SOURCES, metadata.sourceKind)) throw Error('Unsupported capture source');
      for (const e of records) {
        if (metadata.sourceKind === 'video') {
          if (!isObject(e) || !count(e.ordinal, 0) || !e.record ||
            Buffer.byteLength(JSON.stringify(e.record)) > 16384) throw Error('Invalid video record envelope');
          validateVideoRecord(e.record);
          continue;
        }
        if (
          !isObject(e) ||
          !count(e.ordinal, 0) ||
          !Number.isFinite(e.receivedBrowserTimeMs) ||
          !Number.isFinite(e.audioPositionAtReceiptMs) ||
          (e.audioPlaybackRate != null &&
            (!finite(e.audioPlaybackRate) || e.audioPlaybackRate <= 0))
        )
          throw Error("Invalid recorder timing");
        if (e.record) {
          if (Buffer.byteLength(JSON.stringify(e.record)) > 16384)
            throw Error("Pose record exceeds 16 KiB");
          validateWebcamRecord(e.record);
          if (!Number.isFinite(e.audioPositionAtFrameMs)) throw Error('Missing webcam audio anchor');
        } else if (!e.event) throw Error("Missing record/event");
      }
      await store.locked(projectId, async () => {
        await store.read(projectId, "project.json");
        await fs.access(path.join(folder, "capture.json"));
        if (
          await fs.access(path.join(folder, "sealed")).then(
            () => true,
            () => false,
          )
        )
          throw Error("Take already finalized");
        const bytes = json(records),
          filename = path.join(folder, "batches", `${batchId}.json`);
        try {
          const previous = await fs.readFile(filename);
          if (!previous.equals(bytes))
            throw Error("Batch retry differs from saved content");
        } catch (e) {
          if (!isMissing(e)) throw e;
          await store.atomic(filename, bytes);
        }
      });
      res.json({ batchId, durable: true });
    },
  );
  app.post(
    "/api/projects/:projectId/takes/:takeId/finalize",
    body,
    async (req, res) => {
      const projectId = id(req.params.projectId),
        takeId = id(req.params.takeId),
        folder = store.location(projectId, "capture", takeId),
        request = jsonBody(req);
      const take = await store.locked(projectId, async () => {
        await store.read(projectId, "project.json");
        if (
          await fs.access(path.join(folder, "sealed")).then(
            () => true,
            () => false,
          )
        )
          return store.read(projectId, "takes", `${takeId}.json`);
        const metadata = await readCapture(folder),
          records: Record<string, unknown>[] = [],
          batchCount = request.batchCount;
        if (!count(batchCount, 1, 5000))
          throw Error("Invalid batch count");
        for (let n = 0; n < batchCount; n++) {
          const batch: unknown = JSON.parse(
            await fs.readFile(
              path.join(folder, "batches", `${n}.json`),
              "utf8",
            ),
          );
          if (!isArray(batch)) throw Error("Missing/out-of-order recorder records");
          for (const e of batch) {
            if (!isObject(e) || e.ordinal !== records.length)
              throw Error("Missing/out-of-order recorder records");
            records.push(e);
          }
        }
        if (records.length !== request.recordCount)
          throw Error("Incomplete take");
        const reason = request.interruptionReason;
        metadata.interruptionReason = typeof reason === "string" && reason ? reason : null;
        if (metadata.sourceKind === 'video') metadata.calibrationFrame = request.calibrationFrame;
        const result = takeFromRecords(records, metadata);
        const raw = Buffer.from(records.map((e) => JSON.stringify(e) + "\n").join(""));
        await store.atomic(path.join(folder, "records.ndjson"), raw);
        const saved = await store.writeTake(projectId, {
          ...result,
          provenance: { ...result.provenance, rawSha256: sha(raw) },
        });
        await store.atomic(path.join(folder, "sealed"), Buffer.from("sealed"));
        return saved;
      });
      res.json(take);
    },
  );
  app.post("/api/projects/:projectId/compile", body, async (req, res) => {
    const p = await store.project(req.params.projectId);
    if (p.revision !== jsonBody(req).revision)
      throw httpError("Compile requires the saved revision", 409);
    res.json(await store.compile(p));
  });
  app.get("/api/projects/:projectId/export", async (req, res) => {
    const p = await store.project(req.params.projectId);
    const { files } = await store.bundle(p);
    res
      .attachment(`${p.songId}-r${p.revision}.aerodance-song.zip`)
      .type("application/zip")
      .send(makeZip(files));
  });
  app.get("/api/projects/:projectId/backup", async (req, res) => {
    const p = await store.project(req.params.projectId),
      files = new Map([["project.json", json(p)]]);
    for (const t of p.takes) {
      files.set(
        `takes/${t.takeId}.json`,
        await fs.readFile(
          store.location(p.projectId, "takes", `${t.takeId}.json`),
        ),
      );
      const rawFile = store.location(
        p.projectId,
        "capture",
        t.takeId,
        "records.ndjson",
      );
      try {
        files.set(`raw/${t.takeId}.ndjson`, await fs.readFile(rawFile));
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    for (const dataId of trackDataIds(p))
      files.set(
        `tracks/${dataId}.json`,
        await fs.readFile(
          store.location(p.projectId, "tracks", `${id(dataId)}.json`),
        ),
      );
    if (p.audio)
      files.set(
        `assets/${p.audio.sha256}.${p.audio.extension}`,
        await fs.readFile(
          store.location(
            p.projectId,
            "assets",
            `${p.audio.sha256}.${p.audio.extension}`,
          ),
        ),
      );
    res
      .attachment(`${p.songId}.aerodance-project.zip`)
      .type("application/zip")
      .send(makeZip(files));
  });
  app.post("/api/restore", raw, async (req, res) => {
    const archive: unknown = req.body;
    if (!Buffer.isBuffer(archive)) throw Error("Invalid ZIP");
    const files = readZip(archive),
      restored: unknown = JSON.parse(files.get("project.json")?.toString() || "null");
    assertProject(restored);
    let p: Project = restored;
    p.projectId = randomUUID();
    p.revision = 0;
    for (const ref of p.takes) {
      const take: unknown = JSON.parse(
        files.get(`takes/${ref.takeId}.json`)?.toString() || "null",
      );
      validateTake(take);
      await store.writeTake(p.projectId, take);
      const raw = files.get(`raw/${ref.takeId}.ndjson`);
      if (raw)
        await store.atomic(
          store.location(p.projectId, "capture", ref.takeId, "records.ndjson"),
          raw,
        );
    }
    if (p.schemaVersion === 1) {
      const assets = await store.takes(p);
      p = migrateProject(p, assets);
      for (const dataId of trackDataIds(p))
        await store.writeTrack(p.projectId, assets.get(dataId));
    } else {
      for (const dataId of trackDataIds(p)) {
        const data: unknown = JSON.parse(
          files.get(`tracks/${dataId}.json`)?.toString() || "null",
        );
        if (!isObject(data) || data.dataId !== dataId)
          throw Error("Backup track reference mismatch");
        await store.writeTrack(p.projectId, data);
      }
    }
    if (p.audio) {
      if (
        !/^[a-f0-9]{64}$/.test(p.audio.sha256) ||
        !["mp3", "wav", "ogg", "m4a", "flac"].includes(p.audio.extension)
      )
        throw Error("Invalid audio reference");
      const asset = files.get(`assets/${p.audio.sha256}.${p.audio.extension}`);
      if (!asset || sha(asset) !== p.audio.sha256)
        throw Error("Backup audio hash mismatch");
      await store.atomic(
        store.location(
          p.projectId,
          "assets",
          `${p.audio.sha256}.${p.audio.extension}`,
        ),
        asset,
      );
    }
    res.status(201).json(await store.save(p, null));
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found" }),
  );
  app.use(express.static(distDir));
  app.get("/{*splat}", (_req, res) =>
    res.sendFile(path.join(distDir, "index.html")),
  );
  const handleError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = isObject(err) && typeof err.status === "number" && err.status ? err.status : isMissing(err) ? 404 : 400;
    res.status(status).json({
      error: status === 404 ? "Project/asset not found" : isObject(err) ? err.message : undefined,
    });
  };
  app.use(handleError);
  return { app, store };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app } = createStudio();
  app.listen(Number(process.env.STUDIO_PORT) || 3000, "0.0.0.0", () =>
    console.log(
      `Dance Studio: http://localhost:${process.env.STUDIO_PORT || 3000}`,
    ),
  );
}
