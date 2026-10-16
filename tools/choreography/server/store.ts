import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { BinaryLike } from "node:crypto";
import {
  COMPILER_VERSION,
  assertProject,
  assertTake,
  assertTrackData,
  validateTake,
  validateTrackData,
  compileProject,
  reviewReport,
  trackDataIds,
  migrateProject,
} from "../core.ts";
import type { CompiledChoreography, Project, ProjectSummary, ProjectV2, ReviewReport, StudioAssets, Take, TrackData } from "../core.ts";
import { isObject } from "../../../packages/pose/choreography.ts";
import type { ChecksumManifest, Song } from "../../../packages/pose/song.ts";

/** An error the API answers with this HTTP status. */
export type HttpError = Error & { status: number };
export const httpError = (message: string, status: number): HttpError => Object.assign(Error(message), { status });
/** Whether a file system error means the file does not exist. */
export const isMissing = (e: unknown) => isObject(e) && e.code === "ENOENT";
export const sha = (b: BinaryLike) => createHash("sha256").update(b).digest("hex");
export const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");
export const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw Error("Invalid ID");
  return value;
};
export interface CompileResult { data: CompiledChoreography; report: ReviewReport; }
export interface SongBundleFiles { files: Map<string, Buffer>; report: ReviewReport; }
export class Store {
  root: string;
  queues = new Map<string, Promise<unknown>>();
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  location(projectId: string, ...parts: string[]) {
    return path.join(this.root, "projects", id(projectId), ...parts);
  }
  async read(projectId: string, ...parts: string[]): Promise<unknown> {
    return JSON.parse(
      await fs.readFile(this.location(projectId, ...parts), "utf8"),
    );
  }
  /** project.json, validated. */
  async project(projectId: string): Promise<Project> {
    const p = await this.read(projectId, "project.json");
    assertProject(p);
    return p;
  }
  async atomic(filename: string, bytes: string | Uint8Array) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const tmp = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, filename);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  /** Stores the next revision; resolves with the stored project (same format as the one given). */
  async save<P>(project: P, expectedRevision: unknown, alreadyLocked = false): Promise<P & Project> {
    assertProject(project);
    const persist = async () => {
      // The stored revision is checked as written, without validating the rest.
      let current: Record<string, unknown> | undefined;
      try {
        const stored = await this.read(project.projectId, "project.json");
        current = isObject(stored) ? stored : undefined;
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      if (
        (current && current.revision !== expectedRevision) ||
        (!current && expectedRevision !== null)
      )
        throw httpError("Project changed in another window. Reload before saving.", 409);
      if (current?.audio) {
        if (project.audio?.sha256 !== (isObject(current.audio) ? current.audio.sha256 : undefined))
          throw Error("Upload audio through the asset API");
      } else if (project.audio) {
        await fs.access(
          this.location(
            project.projectId,
            "assets",
            `${project.audio.sha256}.${project.audio.extension}`,
          ),
        );
      }
      for (const t of project.takes)
        await fs.access(
          this.location(project.projectId, "takes", `${id(t.takeId)}.json`),
        );
      for (const dataId of trackDataIds(project))
        await fs.access(
          this.location(project.projectId, "tracks", `${id(dataId)}.json`),
        );
      if (project.schemaVersion === 2) {
        for (const track of project.tracks)
          for (const dataId of new Set(
            [track.dataId, track.originalDataId].filter((v): v is string => Boolean(v)),
          )) {
            const data = await this.read(
              project.projectId,
              "tracks",
              `${id(dataId)}.json`,
            );
            if (!isObject(data) || data.playerId !== track.playerId || data.dataId !== dataId)
              throw Error("Track snapshot belongs to another player");
          }
      }
      const next = {
        ...project,
        revision: (typeof current?.revision === "number" ? current.revision : 0) + 1,
        createdAt: typeof current?.createdAt === "string" && current.createdAt ? current.createdAt : project.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await this.atomic(
        this.location(project.projectId, "revisions", `${next.revision}.json`),
        json(next),
      );
      await this.atomic(
        this.location(project.projectId, "project.json"),
        json(next),
      );
      return next;
    };
    return alreadyLocked ? persist() : this.locked(project.projectId, persist);
  }
  async list(): Promise<ProjectSummary[]> {
    await fs.mkdir(path.join(this.root, "projects"), { recursive: true });
    const folders = await fs.readdir(path.join(this.root, "projects"));
    const projects: ProjectSummary[] = [];
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    for (const folder of folders) {
      try {
        // Listed without validation: projects in formats this editor can't open stay visible.
        const p = await this.read(folder, "project.json");
        if (!isObject(p) || !isObject(p.metadata) || typeof p.projectId !== "string" || typeof p.updatedAt !== "string") continue;
        projects.push({
          projectId: p.projectId,
          schemaVersion: p.schemaVersion,
          title: text(p.metadata.title),
          artist: text(p.metadata.artist),
          updatedAt: p.updatedAt,
        });
      } catch { /* skip unreadable project folders */ }
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async writeTake(projectId: string, take: unknown): Promise<Take> {
    assertTake(take);
    const { sha256: _oldHash, ...content } = take;
    const bytes = json(content);
    const stored = { ...content, sha256: sha(bytes) };
    const filename = this.location(
      projectId,
      "takes",
      `${id(stored.takeId)}.json`,
    );
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, json(stored), { flag: "wx" });
    return stored;
  }
  /** The project's takes and track snapshots, validated. */
  async takes(p: Project): Promise<StudioAssets> {
    const entries = await Promise.all(
      p.takes.map(async (t): Promise<[string, Take | TrackData]> => [
        t.takeId,
        validateTake(await this.read(p.projectId, "takes", `${id(t.takeId)}.json`)),
      ]),
    );
    for (const dataId of trackDataIds(p))
      entries.push([
        dataId,
        validateTrackData(await this.read(p.projectId, "tracks", `${id(dataId)}.json`)),
      ]);
    return new Map(entries);
  }
  async open(projectId: string): Promise<ProjectV2> {
    return this.locked(projectId, async () => {
      const p = await this.project(projectId);
      if (p.schemaVersion === 2) return p;
      const assets = await this.takes(p),
        next = migrateProject(p, assets);
      for (const dataId of trackDataIds(next))
        await this.writeTrack(projectId, assets.get(dataId), false, true);
      return this.save(next, p.revision, true);
    });
  }
  async writeTrack(
    projectId: string,
    data: unknown,
    requireProject = false,
    alreadyLocked = false,
  ): Promise<{ dataId: string }> {
    assertTrackData(data);
    const persist = async () => {
      if (requireProject) await this.read(projectId, "project.json");
      const filename = this.location(
        projectId,
        "tracks",
        `${id(data.dataId)}.json`,
      );
      try {
        const current = await fs.readFile(filename);
        if (!current.equals(json(data)))
          throw Error("Track snapshot is immutable");
      } catch (e) {
        if (!isMissing(e)) throw e;
        await this.atomic(filename, json(data));
      }
      return { dataId: data.dataId };
    };
    return alreadyLocked ? persist() : this.locked(projectId, persist);
  }
  async remove(projectId: string, expectedRevision: unknown, takeId: string | null = null): Promise<Project | { deleted: true }> {
    return this.locked(projectId, async () => {
      // Deleting a whole project needs only its revision, so formats this editor can't open can be removed.
      const stored = await this.read(projectId, "project.json");
      if (!isObject(stored) || stored.revision !== expectedRevision)
        throw httpError("Project changed. Reload before deleting.", 409);
      if (!takeId) {
        await fs.rm(this.location(projectId), { recursive: true });
        return { deleted: true };
      }
      if (stored.schemaVersion !== 2)
        throw Error("Open the project before deleting takes");
      const p = stored;
      assertProject(p);
      if (!p.takes.some((t) => t.takeId === takeId))
        throw httpError("Take not found", 404);
      p.takes = p.takes.filter((t) => t.takeId !== takeId);
      p.revision++;
      p.updatedAt = new Date().toISOString();
      await this.atomic(
        this.location(projectId, "revisions", `${p.revision}.json`),
        json(p),
      );
      await this.atomic(this.location(projectId, "project.json"), json(p));
      await fs.rm(this.location(projectId, "takes", `${id(takeId)}.json`), {
        force: true,
      });
      await fs.rm(this.location(projectId, "capture", id(takeId)), {
        recursive: true,
        force: true,
      });
      return p;
    });
  }
  async compile(p: Project): Promise<CompileResult> {
    const data = compileProject(p, await this.takes(p));
    data.provenance.settingsHash = sha(
      json({
        operations: p.operations.slice(0, p.operationCursor),
        tracks: p.tracks,
      }),
    );
    return { data, report: reviewReport(p, data) };
  }
  async bundle(p: Project): Promise<SongBundleFiles> {
    const { data, report } = await this.compile(p);
    if (report.blockers.length)
      throw httpError(report.blockers.join("\n"), 422);
    if (!p.audio) throw httpError("Import song audio", 422);
    const extension = p.audio.extension,
      filename = `audio.${extension}`,
      audio = await fs.readFile(
        this.location(p.projectId, "assets", `${p.audio.sha256}.${extension}`),
      );
    if (sha(audio) !== p.audio.sha256)
      throw Error("Audio integrity check failed");
    const song: Song = {
      schema: "aerodance.song",
      schemaVersion: 1,
      songId: p.songId,
      bundleRevision: p.revision,
      ...p.metadata,
      durationMs: p.durationMs,
      playableStartMs: p.playableStartMs,
      playableEndMs: p.playableEndMs,
      supportedPlayerCounts: [1, 2],
      audio: { path: filename, mimeType: p.audio.mimeType },
      choreography: { path: "choreography.json", schemaVersion: 1 },
      coachMode: "mirror-player",
      rigProfile: "frutiger-seven-bone-v1",
      createdAt: p.createdAt,
      publishedAt: p.updatedAt,
      build: { compilerVersion: COMPILER_VERSION, projectRevision: p.revision },
    };
    const files = new Map([
      ["song.json", json(song)],
      ["choreography.json", Buffer.from(JSON.stringify(data) + "\n")],
      [filename, audio],
    ]);
    const checksums: ChecksumManifest = {
      schema: "aerodance.checksums",
      schemaVersion: 1,
      files: [...files].map(([name, bytes]) => ({
        path: name,
        bytes: bytes.length,
        sha256: sha(bytes),
      })),
    };
    if (
      [...files.values()].some((bytes) => bytes.length > 128 * 1024 * 1024) ||
      [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) >
        192 * 1024 * 1024
    )
      throw Error(
        "Bundle exceeds the game loader size limit; shorten the playable range or use smaller audio",
      );
    files.set("checksums.json", json(checksums));
    return {
      files: new Map(
        [...files].map(([name, bytes]) => [`${p.songId}/${name}`, bytes]),
      ),
      report,
    };
  }
}
