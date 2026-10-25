import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { newDance } from '../format.ts';
import type { Dance } from '../format.ts';
import { applyOps } from '../ops.ts';
import type { OpContext } from '../ops.ts';
import { createEvaluator } from '../evaluate.ts';
import { encodeTracking, decodeTracking } from '../tracking.ts';
import type { TrackingData, TrackedFrame } from '../tracking.ts';

export async function tempDir(t: TestContext, prefix = 'dance-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A dance with ops applied, throwing on failure. */
export function danceWith(ops: unknown[], { dancers = 1, durationMs = 10_000 } = {}, ctx: OpContext = {}): Dance {
  return ops.length ? applyOps(newDance({ dancers, durationMs, now: '2026-01-01T00:00:00.000Z' }), ops, ctx).dance : newDance({ dancers, durationMs, now: '2026-01-01T00:00:00.000Z' });
}
export const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
export const dist = (a: readonly number[], b: readonly number[], aspect = 16 / 9) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);
/** Tracking made from a dance's own poses (or `transform` of them), on the video clock = song clock. */
export function trackingOf(dance: Dance, { everyMs = 1000 / 15, transform }: { everyMs?: number; transform?: (dancer: number, t: number, d: Dance) => import('../../../packages/pose/choreography.ts').Landmark[] } = {}): TrackingData {
  const frames: TrackedFrame[] = [];
  const evaluators = dance.dancers.map(d => createEvaluator(dance, d));
  for (let t = dance.song.playableStartMs; t <= dance.song.playableEndMs; t += everyMs)
    frames.push({ videoMs: Math.round(t * 10) / 10, poses: evaluators.map((e, i) => transform ? transform(i, t, dance) : e.landmarks(t)) });
  return decodeTracking(encodeTracking(frames, { width: dance.frame.width, height: dance.frame.height, slots: dance.dancers.length }));
}
/** Registers tracking on a dance (slot n follows dancer n) and returns the op context to read it. */
export function withTracking(dance: Dance, data: TrackingData, id = 't1'): { dance: Dance; ctx: OpContext } {
  const next = structuredClone(dance);
  next.sources.tracking.push({ id, path: `sources/tracking-${id}.adpose`, sha256: 'a'.repeat(64), bytes: 1, mimeType: 'application/octet-stream',
    model: 'lite', createdAt: '2026-01-01T00:00:00.000Z', fps: 15, dancers: dance.dancers.map(d => d.id) });
  return { dance: next, ctx: { tracking: () => data } };
}
