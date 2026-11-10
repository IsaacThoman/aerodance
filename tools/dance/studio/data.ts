// The browser side of the bridge (server.ts): the dance, its tracking and edits.
import { decodeTracking } from '../tracking.ts';
import type { TrackingData } from '../tracking.ts';
import type { Dance } from '../format.ts';
import type { ApplyResult } from '../project.ts';
import type { TrackResult } from '../server.ts';

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
/** The dance, or null while the folder has none yet. */
export const fetchCurrentDance = async () => (await call<{ dance: Dance | null }>('/api/dance')).dance;
export const fetchDance = async (revision?: number) => {
  const dance = (await call<{ dance: Dance | null }>(revision === undefined ? '/api/dance' : `/api/dance?revision=${revision}`)).dance;
  if (!dance) throw Error('There is no dance here yet');
  return dance;
};
export const applyOps = (ops: unknown[], expectRevision: number, label?: string) =>
  post<ApplyResult>('/api/apply', { ops, expectRevision, label, opId: crypto.randomUUID() });
export const undo = (expectRevision?: number) => post<{ result: { revision: number; label: string } | null }>('/api/undo', { expectRevision });
export const redo = (expectRevision?: number) => post<{ result: { revision: number; label: string } | null }>('/api/redo', { expectRevision });
export const history = () => call<{ undo: { revision: number; label: string }[]; redo: { revision: number; label: string }[] }>('/api/history');
/** Sends a file to the bridge, which keeps it for create or attach; returns its upload name. */
export const upload = async (file: Blob, name: string) =>
  (await call<{ upload: string }>(`/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })).upload;
export interface NewDanceRequest { title: string; artist: string; dancers: number; video?: string; audio?: string; audioFromVideo: boolean; }
/** Makes the dance in the folder the Studio was opened on. */
export const createDance = (request: NewDanceRequest) => post<{ dance: Dance }>('/api/create', request);
/** Adds or replaces the song audio or the video (uploads); a recording starts at its song time. */
export const attachSources = (request: { video?: string; audio?: string; recording?: { fps: number; startMs: number; durationMs: number } }) => post<{ dance: Dance }>('/api/attach', request);
export const trackVideo = (fps: number) => post<TrackResult>('/api/track', { fps });
export const projectFolder = async () => (await call<{ dir: string }>('/api/ping')).dir;
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
export interface Progress { task: string; done: number; total: number; }
/**
 * Calls back whenever dance.json changes, from any editor (CLI, another window, a hand edit):
 * with its revision and a stamp of its content; and as long work (tracking) gets on.
 */
export function watchRevisions(onChange: (revision: number, stamp: string) => void, onProgress?: (progress: Progress) => void): () => void {
  const events = new EventSource('/api/events');
  events.onmessage = e => {
    const data = JSON.parse(e.data) as { revision?: number; stamp?: string; progress?: Progress };
    if (typeof data.revision === 'number') onChange(data.revision, data.stamp ?? '');
    if (data.progress) onProgress?.(data.progress);
  };
  return () => events.close();
}
