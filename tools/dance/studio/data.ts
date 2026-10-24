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
export const fetchDance = async () => (await call<{ dance: Dance }>('/api/dance')).dance;
export const applyOps = (ops: unknown[], expectRevision: number, label?: string) =>
  post<ApplyResult>('/api/apply', { ops, expectRevision, label, opId: crypto.randomUUID() });
export const undo = (expectRevision?: number) => post<{ result: { revision: number; label: string } | null }>('/api/undo', { expectRevision });
export const redo = (expectRevision?: number) => post<{ result: { revision: number; label: string } | null }>('/api/redo', { expectRevision });
export const history = () => call<{ undo: { revision: number; label: string }[]; redo: { revision: number; label: string }[] }>('/api/history');
export const frameUrl = (songMs: number, width?: number) => `/api/frame?t=${songMs.toFixed(1)}${width ? `&w=${Math.round(width)}` : ''}`;
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
/** Calls back with each new revision of dance.json, from any editor (CLI, another window). */
export function watchRevisions(onRevision: (revision: number) => void): () => void {
  const events = new EventSource('/api/events');
  events.onmessage = e => {
    const data = JSON.parse(e.data) as { revision?: number };
    if (typeof data.revision === 'number') onRevision(data.revision);
  };
  return () => events.close();
}
