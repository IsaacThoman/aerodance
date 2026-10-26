import type { Dance } from './format.ts';
import type { Performance } from '../../packages/pose/performance.ts';

/** Export direct character keys on the song clock. Projects keep them on each dancer's clock. */
export function performanceOf(dance: Dance): Performance | undefined {
  if (!dance.dancers.some(d => d.performance?.length)) return undefined;
  return { schema: 'aerodance.performance', schemaVersion: 1, tracks: dance.dancers.map(d => ({
    clips: (d.performance ?? []).map(c => ({ ...c, startMs: c.startMs + d.timeOffsetMs, endMs: c.endMs + d.timeOffsetMs,
      keys: c.keys.map(k => ({ ...k, t: k.t + d.timeOffsetMs })) })),
  })) };
}
