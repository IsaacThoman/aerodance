// The project's attempts for one dancer, scored against the dance as it is now. Each attempt's
// poses are replayed through the game's scorer whenever the dance changes, so an attempt danced
// before a fix shows what that fix did to its score.
import { useEffect, useMemo, useState } from 'react';
import { analyzeAttempt } from '../../../../../../packages/dance/playtest.ts';
import type { AttemptAnalysis, AttemptSample } from '../../../../../../packages/dance/playtest.ts';
import type { AttemptInfo } from '../../../../../../packages/dance/store.ts';
import { useGameBundle } from '../../core/compile.ts';
import { useProject, useSession } from '../../core/hooks.ts';
import { coveredAnalysis } from './analysis.ts';
import type { Range } from './analysis.ts';

export interface ScoredAttempt {
  info: AttemptInfo;
  /** The stretch of the song the attempt covered. */
  range: Range;
  /** Its analysis over that stretch. */
  analysis: AttemptAnalysis;
}
/** `scored` is null for an attempt whose poses can't be read. */
interface Entry { project: string; revision: number; dancer: number; scored: ScoredAttempt | null; }
// The latest analysis of each attempt, kept between visits to the station.
const cache = new Map<string, Entry>();

export interface ScoredAttempts {
  /** The dancer's attempts, newest first. */
  attempts: AttemptInfo[];
  /** Those scored so far, newest first (an attempt keeps its last score while it is scored again). */
  scored: ScoredAttempt[];
  /** Scores are being brought up to date with the dance. */
  scoring: boolean;
  /** Why the dance couldn't be scored, if it couldn't. */
  error: string | null;
}
export function useScoredAttempts(dancer: number): ScoredAttempts {
  const session = useSession(), { dance, attempts: all } = useProject();
  const id = dance.dancers[dancer]?.id;
  const attempts = useMemo(() => all.filter(a => a.dancer === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [all, id]);
  const { bundle, error } = useGameBundle(session, attempts.length > 0);
  // Counts changes to the cache, so what's read from it is the same list until it changes.
  const [version, refresh] = useState(0);
  useEffect(() => {
    if (!bundle?.choreography.tracks[dancer]) return;
    const revision = bundle.song.build.projectRevision;
    let live = true;
    void (async () => {
      for (const key of [...cache.keys()]) if (cache.get(key)!.project !== session.id) cache.delete(key);
      for (const info of attempts) {
        const hit = cache.get(info.id);
        if (hit?.revision === revision && hit.dancer === dancer) continue;
        // One attempt at a time, with a breath between, so the page stays responsive.
        await new Promise(resolve => setTimeout(resolve));
        const take = live ? await session.store.attempt(info).catch(() => null) : null;
        if (!live) return;
        let scored: ScoredAttempt | null = null;
        if (take?.times.length) {
          const samples: AttemptSample[] = [];
          for (let i = 0; i < take.times.length; i++) { const landmarks = take.poseAtFrame(0, i); if (landmarks) samples.push({ songTimeMs: take.times[i], landmarks }); }
          const range: Range = [take.times[0], take.times[take.times.length - 1]];
          try { scored = { info, range, analysis: coveredAnalysis(analyzeAttempt(bundle, dancer, samples, info.width / info.height), range) }; } catch { /* unreadable */ }
        }
        cache.set(info.id, { project: session.id, revision, dancer, scored });
        refresh(n => n + 1);
      }
    })();
    return () => { live = false; };
  }, [bundle, attempts, dancer, session]);
  return useMemo(() => {
    void version;
    const entries = attempts.map(a => cache.get(a.id)).filter((e): e is Entry => !!e && e.project === session.id && e.dancer === dancer);
    return { attempts, scored: entries.map(e => e.scored).filter((s): s is ScoredAttempt => !!s), error,
      scoring: attempts.length > 0 && !error && entries.filter(e => e.revision === dance.revision).length < attempts.length };
  }, [attempts, dancer, session, dance.revision, error, version]);
}
