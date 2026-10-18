import {
  COMPILER_VERSION,
  assertProject,
  assertTake,
  assertTrackData,
  validateTake,
  validateTrackData,
  compileProject,
  reviewReport,
  takeSummary,
  trackDataIds,
} from "../core.ts";
import type { CompiledChoreography, Project, ProjectSummary, ProjectV3, ReviewReport, StudioAssets, Take, TakeSummary, TrackData } from "../core.ts";
import { concatBytes, decodeTake, decodeTrack, encodeTake, encodeTrack } from "../poseFiles.ts";
import { isObject } from "../../../packages/pose/choreography.ts";
import { songChoreographyFromTimeline } from "../../../packages/pose/song.ts";
import type { ChecksumManifest, Song, SongChoreography } from "../../../packages/pose/song.ts";
import { encodePoseFile } from "../../../packages/pose/binary.ts";
import { readZip } from "./zip.ts";

/** An error the API answers with this HTTP status. */
export type HttpError = Error & { status: number };
export const httpError = (message: string, status: number): HttpError => Object.assign(Error(message), { status });
/** Whether a file system error means the file does not exist. */
export const isMissing = (e: unknown) => isObject(e) && e.code === "ENOENT";
export async function sha(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, "0")).join("");
}
export const json = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
export const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Paths are relative to the workspace; a multi-file commit must be atomic. */
export interface WorkspaceFiles {
  read(path: string): Promise<Uint8Array>;
  has(path: string): Promise<boolean>;
  commit(entries: ReadonlyMap<string, Uint8Array>, remove?: string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
  locked<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
export const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw Error("Invalid ID");
  return value;
};
/**
 * A song's ID: a hash of its audio and its motion, so each distinct dance gets its own ID and
 * re-exporting an unchanged one keeps it. Metadata and provenance don't count, and the
 * choreography is hashed with an empty ID since the file carries the result.
 */
export async function bundleSongId(audioSha256: string, motion: SongChoreography): Promise<string> {
  const input = concatBytes([new TextEncoder().encode(audioSha256), encodePoseFile(motion)]);
  return `song-${(await sha(input)).slice(0, 16)}`;
}
/** The file name a project download is saved as; a song bundle is named after its song folder. */
export async function downloadName(p: Project, kind: "backup" | "export", bytes: Uint8Array): Promise<string> {
  if (kind === "backup") return `${p.projectId}.aerodance-project.zip`;
  const [first] = (await readZip(bytes)).keys();
  return `${first.split("/")[0]}-r${p.revision}.aerodance-song.zip`;
}
export interface CompileResult { data: CompiledChoreography; report: ReviewReport; }
export interface SongBundleFiles { files: Map<string, Uint8Array>; report: ReviewReport; }
export class Store {
  files: WorkspaceFiles;
  constructor(files: WorkspaceFiles) { this.files = files; }
  location(projectId: string, ...parts: string[]) {
    return ["projects", id(projectId), ...parts].join("/");
  }
  async read(projectId: string, ...parts: string[]): Promise<unknown> {
    return JSON.parse(decode(await this.files.read(this.location(projectId, ...parts))));
  }
  takePath(projectId: string, takeId: string) { return this.location(projectId, "takes", `${id(takeId)}.adpose`); }
  trackPath(projectId: string, dataId: string) { return this.location(projectId, "tracks", `${id(dataId)}.adpose`); }
  async project(projectId: string): Promise<Project> {
    const p = await this.read(projectId, "project.json");
    assertProject(p);
    return p;
  }
  async atomic(filename: string, bytes: Uint8Array) {
    await this.files.commit(new Map([[filename, bytes]]));
  }
  locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.files.locked(key, fn);
  }
  exists(filename: string): Promise<boolean> { return this.files.has(filename); }
  async require(filename: string) {
    if (!await this.exists(filename)) throw Object.assign(Error("Project/asset not found"), { code: "ENOENT" });
  }
  async persist(p: Project, remove: string[] = []) {
    await this.files.commit(new Map([
      [this.location(p.projectId, "revisions", `${p.revision}.json`), json(p)],
      [this.location(p.projectId, "project.json"), json(p)],
    ]), remove);
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
        await this.require(
          this.location(
            project.projectId,
            "assets",
            `${project.audio.sha256}.${project.audio.extension}`,
          ),
        );
      }
      // A take added since the stored revision must match the file it summarizes.
      const known = new Set(isObject(current) && Array.isArray(current.takes) ? current.takes.map(t => isObject(t) ? t.takeId : null) : []);
      for (const t of project.takes) {
        const bytes = await this.files.read(this.takePath(project.projectId, t.takeId)).catch((e: unknown) => {
          if (isMissing(e)) throw Object.assign(Error("Project/asset not found"), { code: "ENOENT" });
          throw e;
        });
        if (!known.has(t.takeId) && t.sha256 !== await sha(bytes)) throw Error("Take metadata does not match the stored take");
      }
      for (const track of project.tracks)
        for (const dataId of new Set(
          [track.dataId, track.originalDataId].filter((v): v is string => Boolean(v)),
        )) {
          const data = decodeTrack(await this.files.read(this.trackPath(project.projectId, dataId)));
          if (data.playerId !== track.playerId || data.dataId !== dataId)
            throw Error("Track snapshot belongs to another player");
        }
      const next = {
        ...project,
        revision: (typeof current?.revision === "number" ? current.revision : 0) + 1,
        createdAt: typeof current?.createdAt === "string" && current.createdAt ? current.createdAt : project.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await this.persist(next);
      return next;
    };
    return alreadyLocked ? persist() : this.locked(project.projectId, persist);
  }
  async list(): Promise<ProjectSummary[]> {
    const folders = [...new Set((await this.files.list("projects/")).filter(name => name.endsWith("/project.json")).map(name => name.split("/")[1]))];
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
  /** Stores an immutable take; resolves with the take as stored, quantized and with its hash. */
  async writeTake(projectId: string, take: unknown): Promise<Take> {
    const stored = await this.encodeTake(take), filename = this.takePath(projectId, stored.take.takeId);
    if (await this.exists(filename)) throw Error("Take is immutable");
    await this.atomic(filename, stored.bytes);
    return stored.take;
  }
  /** A take's file, and the take as reading that file gives it back. */
  async encodeTake(take: unknown): Promise<{ bytes: Uint8Array; take: Take }> {
    assertTake(take);
    const bytes = encodeTake(take);
    return { bytes, take: validateTake(decodeTake(bytes, { ...takeSummary(take), sha256: await sha(bytes) })) };
  }
  async take(projectId: string, summary: TakeSummary): Promise<Take> {
    return validateTake(decodeTake(await this.files.read(this.takePath(projectId, summary.takeId)), summary));
  }
  /** A take by ID, with the metadata its project summary keeps. */
  async takeById(projectId: string, takeId: string): Promise<Take> {
    const p = await this.project(projectId);
    const summary = p.takes.find(t => t.takeId === takeId);
    if (!summary) throw httpError("Take not found", 404);
    return this.take(projectId, summary);
  }
  async track(projectId: string, dataId: string): Promise<TrackData> {
    const data = validateTrackData(decodeTrack(await this.files.read(this.trackPath(projectId, dataId))));
    if (data.dataId !== dataId) throw Error("Track snapshot reference mismatch");
    return data;
  }
  /** The project's takes and track snapshots, validated. */
  async takes(p: ProjectV3): Promise<StudioAssets> {
    const entries = await Promise.all(
      p.takes.map(async (t): Promise<[string, Take | TrackData]> => [t.takeId, await this.take(p.projectId, t)]),
    );
    for (const dataId of trackDataIds(p)) entries.push([dataId, await this.track(p.projectId, dataId)]);
    return new Map(entries);
  }
  async open(projectId: string): Promise<ProjectV3> {
    return this.project(projectId);
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
      const filename = this.trackPath(projectId, data.dataId), bytes = encodeTrack(data);
      try {
        // Encoding a decoded snapshot reproduces its bytes, so a retried upload matches.
        if (!equal(await this.files.read(filename), bytes))
          throw Error("Track snapshot is immutable");
      } catch (e) {
        if (!isMissing(e)) throw e;
        await this.atomic(filename, bytes);
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
        await this.files.commit(new Map(), [this.location(projectId) + "/"]);
        return { deleted: true };
      }
      const p = stored;
      assertProject(p);
      if (!p.takes.some((t) => t.takeId === takeId))
        throw httpError("Take not found", 404);
      p.takes = p.takes.filter((t) => t.takeId !== takeId);
      p.revision++;
      p.updatedAt = new Date().toISOString();
      await this.persist(p, [
        this.takePath(projectId, takeId),
        this.location(projectId, "capture", id(takeId)) + "/",
      ]);
      return p;
    });
  }
  async compile(p: ProjectV3): Promise<CompileResult> {
    const data = compileProject(p, await this.takes(p));
    data.provenance.settingsHash = await sha(
      json({
        operations: p.operations.slice(0, p.operationCursor),
        tracks: p.tracks,
      }),
    );
    return { data, report: reviewReport(p, data) };
  }
  async bundle(p: ProjectV3): Promise<SongBundleFiles> {
    const { data, report } = await this.compile(p);
    if (report.blockers.length)
      throw httpError(report.blockers.join("\n"), 422);
    if (!p.audio) throw httpError("Import song audio", 422);
    const extension = p.audio.extension,
      filename = `audio.${extension}`,
      audio = await this.files.read(
        this.location(p.projectId, "assets", `${p.audio.sha256}.${extension}`),
      );
    if (await sha(audio) !== p.audio.sha256)
      throw Error("Audio integrity check failed");
    const markers = data.markers.map(({ songTimeMs, kind, label }) => ({ timeMs: songTimeMs, kind, label }));
    const songId = await bundleSongId(p.audio.sha256, songChoreographyFromTimeline({ ...data, songId: "" }, { markers }));
    const song: Song = {
      schema: "aerodance.song",
      schemaVersion: 1,
      songId,
      bundleRevision: p.revision,
      ...p.metadata,
      durationMs: p.durationMs,
      playableStartMs: p.playableStartMs,
      playableEndMs: p.playableEndMs,
      supportedPlayerCounts: [1, 2],
      audio: { path: filename, mimeType: p.audio.mimeType },
      choreography: { path: "choreography.adpose", schemaVersion: 2 },
      coachMode: "mirror-player",
      rigProfile: "frutiger-seven-bone-v1",
      createdAt: p.createdAt,
      publishedAt: p.updatedAt,
      build: { compilerVersion: COMPILER_VERSION, projectRevision: p.revision },
    };
    const files = new Map([
      ["song.json", json(song)],
      ["choreography.adpose", encodePoseFile(songChoreographyFromTimeline({ ...data, songId }, {
        markers,
        provenance: data.provenance,
      }))],
      [filename, audio],
    ]);
    const checksums: ChecksumManifest = {
      schema: "aerodance.checksums",
      schemaVersion: 1,
      files: await Promise.all([...files].map(async ([name, bytes]) => ({
        path: name,
        bytes: bytes.length,
        sha256: await sha(bytes),
      }))),
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
        [...files].map(([name, bytes]) => [`${songId}/${name}`, bytes]),
      ),
      report,
    };
  }
}
