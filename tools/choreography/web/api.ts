import { isArray, isObject } from "../../../packages/pose/choreography.ts";
import type { ProjectSummary } from "../core.ts";
import { BrowserFiles } from "../storage/browserFiles.ts";
import { Workspace } from "../storage/workspace.ts";
import { createRequest } from "../storage/commands.ts";
export type { RequestOptions, ApiRequest } from "../storage/commands.ts";
import type { ApiRequest } from "../storage/commands.ts";

export const workspace = new Workspace(new BrowserFiles());

export function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "QuotaExceededError")
    return Error("Browser storage is full. Your last saved project is preserved. Download a Backup, then free space before saving again.");
  return error instanceof Error ? error : Error(String(error));
}
const localRequest = createRequest(workspace);
export const request: ApiRequest = async (url, options) => {
  try { return await localRequest(url, options); }
  catch (error) { throw storageError(error); }
};
export const errorMessage = (e: unknown) => storageError(e).message;
export function takeIdOf(capture: unknown): string {
  if (!isObject(capture) || typeof capture.takeId !== "string") throw Error("Invalid capture result");
  return capture.takeId;
}
export function projectSummaries(list: unknown): ProjectSummary[] {
  const text = (v: unknown) => typeof v === "string";
  if (!isArray(list) || !list.every((p): p is ProjectSummary => isObject(p) && text(p.projectId) &&
    text(p.title) && text(p.artist) && text(p.updatedAt))) throw Error("Invalid project list");
  return list;
}
