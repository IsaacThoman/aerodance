import { isObject } from "../../../packages/pose/choreography.ts";
import { newProject } from "../core.ts";
import { id } from "./store.ts";
import type { Workspace } from "./workspace.ts";

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
}
/** Authoring commands; the browser adapter runs them locally. */
export type ApiRequest = (url: string, options?: RequestOptions) => Promise<unknown>;
const object = (body: unknown): Record<string, unknown> => {
  if (!isObject(body)) throw Error("Expected a project command");
  return body;
};
export const createRequest = (workspace: Workspace): ApiRequest => async (url, { body, method = "GET", headers } = {}) => {
  const parsed = new URL(url, "https://studio.local"), parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") throw Error("Unknown local command");
  if (parts[1] === "restore" && method === "POST" && body instanceof Blob) {
    if (body.size > 256 * 1024 * 1024) throw Error("Project archive exceeds 256 MiB");
    return await workspace.restore(new Uint8Array(await body.arrayBuffer()));
  }
  if (parts[1] !== "projects") throw Error("Unknown local command");
  if (parts.length === 2) {
    if (method === "GET") return await workspace.list();
    if (method === "POST") return await workspace.save(newProject(), null);
  }
  const projectId = id(parts[2]);
  if (parts.length === 3) {
    if (method === "GET") return await workspace.open(projectId);
    if (method === "PUT") {
      const p = object(body);
      if (p.projectId !== projectId) throw Error("Project ID mismatch");
      return await workspace.save(p, p.revision);
    }
    if (method === "DELETE") return await workspace.remove(projectId, object(body).revision);
  }
  if (parts[3] === "compile" && method === "POST") {
    const p = await workspace.project(projectId);
    if (p.revision !== object(body).revision) throw Object.assign(Error("Compile requires the saved revision"), { status: 409 });
    if (p.schemaVersion !== 3) throw Error("Open the project to migrate it to project format 3");
    return workspace.compile(p);
  }
  const action = parts[3], takeId = parts[4] ? id(parts[4]) : "";
  if (action === "audio" && method === "POST" && body instanceof Blob) {
    if (body.size > 128 * 1024 * 1024) throw Error("Audio exceeds 128 MiB");
    return await workspace.uploadAudio(projectId, new Uint8Array(await body.arrayBuffer()), headers?.["Content-Type"]?.split(";")[0] || body.type,
      Math.round(Number(parsed.searchParams.get("durationMs"))), Number(parsed.searchParams.get("revision")), parsed.searchParams.get("name") || "Song audio",
      parsed.searchParams.has('takeId') ? id(parsed.searchParams.get('takeId')) : undefined);
  }
  if (action === "tracks") {
    if (method === "POST") return await workspace.writeTrack(projectId, body, true);
    if (method === "GET" && takeId) return await workspace.track(projectId, takeId);
  }
  if (action === "import" && method === "POST") return await workspace.importTake(projectId, body);
  if (action === "takes") {
    if (method === "POST" && !takeId) return await workspace.startCapture(projectId, object(body));
    if (method === "GET" && takeId) return await workspace.takeById(projectId, takeId);
    if (method === "DELETE" && takeId) return await workspace.remove(projectId, object(body).revision, takeId);
    if (method === "POST" && parts[5] === "batches") {
      // A batch is FRMS/EVNT chunk bytes; the batch number travels in the query.
      const bytes = body instanceof Uint8Array ? body : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : null;
      if (!bytes) throw Error("Expected a record batch");
      return await workspace.appendBatch(projectId, takeId, Number(parsed.searchParams.get("batchId") ?? NaN), bytes);
    }
    if (method === "POST" && parts[5] === "finalize") return await workspace.finalize(projectId, takeId, object(body));
  }
  throw Object.assign(Error("Unknown local command"), { status: 404 });
};
