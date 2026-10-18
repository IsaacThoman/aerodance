// Optional migration server for existing disk workspaces. The shipped Studio is static.
import express from "express";
import type { ErrorRequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { Store, isMissing } from "./store.ts";
import { downloadName } from "../storage/store.ts";
import { createRequest } from "../storage/commands.ts";
import { isObject } from "../../../packages/pose/choreography.ts";

export interface StudioOptions { dataDir?: string; distDir?: string; }
export function createStudio({
  dataDir = process.env.STUDIO_DATA_DIR || path.resolve("studio-data"),
  distDir = path.resolve("tools/choreography/dist"),
}: StudioOptions = {}) {
  const app = express(), store = new Store(dataDir), command = createRequest(store);
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res.status(403).json({ error: "Use the studio origin for writes" });
    next();
  });
  app.get("/api/health", async (_req, res) => {
    try { await fs.mkdir(dataDir, { recursive: true }); await fs.access(dataDir, fs.constants.W_OK); res.json({ ok: true }); }
    catch { res.status(503).json({ error: "Studio data directory is not writable" }); }
  });
  app.get("/api/projects/:projectId/audio", async (req, res) => {
    const audio = await store.audio(req.params.projectId);
    res.type(audio.type).send(Buffer.from(await audio.arrayBuffer()));
  });
  for (const kind of ["backup", "export"] as const) {
    app.get(`/api/projects/:projectId/${kind}`, async (req, res) => {
      const p = await store.project(req.params.projectId);
      const bytes = await store.download(p.projectId, kind);
      res.attachment(await downloadName(p, kind, bytes))
        .type("application/zip").send(Buffer.from(bytes));
    });
  }
  app.use("/api", express.json({ limit: "256mb" }), express.raw({ type: () => true, limit: "128mb" }), async (req, res) => {
    const raw: unknown = req.body;
    const body = Buffer.isBuffer(raw) ? new Blob([new Uint8Array(raw)], { type: req.get("content-type") || "application/octet-stream" }) : raw;
    const value = await command(req.originalUrl, { method: req.method, body, headers: { "Content-Type": req.get("content-type") || "" } });
    const pathname = req.originalUrl.split("?")[0];
    const created = req.method === "POST" && (/^\/api\/(projects|restore)$/.test(pathname) || /\/(tracks|import|takes)$/.test(pathname));
    res.status(created ? 201 : 200).json(value);
  });
  app.use(express.static(distDir));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  const handleError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = isObject(err) && typeof err.status === "number" && err.status ? err.status : isMissing(err) ? 404 : 400;
    res.status(status).json({ error: status === 404 ? "Project/asset not found" : err instanceof Error ? err.message : "Studio operation failed" });
  };
  app.use(handleError);
  return { app, store };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createStudio();
  app.listen(Number(process.env.STUDIO_PORT) || 3000, "127.0.0.1", () => console.log(`Legacy Studio workspace: http://localhost:${process.env.STUDIO_PORT || 3000}`));
}
