// The browser side of the bridge (server.ts): the dance, its tracking and edits.
import { decodeTracking } from '../tracking.ts';
import type { TrackingData } from '../tracking.ts';
import type { Dance } from '../format.ts';
import type { ApplyResult } from '../project.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly currentRevision: number | null;
  constructor(message: string, status: number, currentRevision: number | null) { super(message); this.status = status; this.currentRevision = currentRevision; }
}
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; currentRevision?: number };
    throw new ApiError(body.error ?? `${url}: HTTP ${response.status}`, response.status, body.currentRevision ?? null);
  }
  return response.json() as Promise<T>;
}
const post = <T>(url: string, body: unknown) => call<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const fetchDance = async (revision?: number) => (await call<{ dance: Dance }>(revision === undefined ? '/api/dance' : `/api/dance?revision=${revision}`)).dance;
export const applyOps = (ops: unknown[], expectRevision: number, label?: string) =>
  post<ApplyResult>('/api/apply', { ops, expectRevision, label, opId: crypto.randomUUID() });
export const undo = (expectRevision?: number) => post<{ result: { revision: number; label: string } | null }>('/api/undo', { expectRevision });
export const redo = (expectRevision?: number) => post<{ result: { revision: number; label: string } | null }>('/api/redo', { expectRevision });
export const history = () => call<{ undo: { revision: number; label: string }[]; redo: { revision: number; label: string }[] }>('/api/history');
/** The video frame shown at a song time; the URL names the video's alignment too, so realigning it never shows a cached frame. */
export const frameUrl = (songMs: number, width: number | undefined, video: { startMs: number; rate: number; sha256: string } | null) =>
  `/api/frame?t=${songMs.toFixed(1)}${width ? `&w=${Math.round(width)}` : ''}${video ? `&v=${video.sha256.slice(0, 12)}:${video.startMs}:${video.rate}` : ''}`;
const tracking = new Map<string, Promise<TrackingData>>();
/** A tracking file, decoded once per content hash. */
export function fetchTracking(dance: Dance, id: string): Promise<TrackingData> {
  const source = dance.sources.tracking.find(t => t.id === id);
  if (!source) return Promise.reject(Error(`No tracking ${id}`));
  let found = tracking.get(source.sha256);
  if (!found) {
    found = fetch(`/api/tracking/${encodeURIComponent(id)}`).then(r => r.arrayBuffer()).then(b => decodeTracking(new Uint8Array(b)));
    tracking.set(source.sha256, found);
  }
  return found;
}
/**
 * Calls back whenever dance.json changes, from any editor (CLI, another window, a hand edit):
 * with its revision and a stamp of its content.
 */
export function watchRevisions(onChange: (revision: number, stamp: string) => void): () => void {
  const events = new EventSource('/api/events');
  events.onmessage = e => {
    const data = JSON.parse(e.data) as { revision?: number; stamp?: string };
    if (typeof data.revision === 'number') onChange(data.revision, data.stamp ?? '');
  };
  return () => events.close();
}
