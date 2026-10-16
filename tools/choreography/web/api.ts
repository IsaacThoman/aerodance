import { isArray, isObject } from "../../../packages/pose/choreography.ts";
import type { ProjectSummary } from "../core.ts";

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  /** A Blob is sent as is; anything else as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
}
/** Calls the Studio API and resolves with its unvalidated JSON response; replaceable in tests. */
export type ApiRequest = (url: string, options?: RequestOptions) => Promise<unknown>;

export const request: ApiRequest = async (url, { body, ...options } = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(body && !(body instanceof Blob)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Error(await responseError(response));
  const data: unknown = await response.json();
  return data;
};
/** The API's error message for a failed response. */
export async function responseError(response: Response): Promise<string | undefined> {
  try {
    const data: unknown = await response.json();
    return isObject(data) && typeof data.error === "string" ? data.error : undefined;
  } catch {
    return `HTTP ${response.status}`;
  }
}
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The takeId of a capture the server started. */
export function takeIdOf(capture: unknown): string {
  if (!isObject(capture) || typeof capture.takeId !== "string") throw Error("Invalid capture response");
  return capture.takeId;
}
/** The project list from GET /api/projects. */
export function projectSummaries(list: unknown): ProjectSummary[] {
  const text = (v: unknown) => typeof v === "string";
  if (!isArray(list) || !list.every((p): p is ProjectSummary => isObject(p) && text(p.projectId) &&
    text(p.title) && text(p.artist) && text(p.updatedAt))) throw Error("Invalid project list");
  return list;
}
