// Development only: attempts by the stand-in performer (core/demo.ts), to try the playtest's
// analysis without dancing. The page gets window.studioPlaytest.fake({ lateMs, seed, lost }).
import type { AttemptInfo } from '../../../../../../packages/dance/store.ts';
import { demoFrames } from '../../core/demo.ts';
import type { ProjectSession } from '../../core/session.ts';
import type { Range } from './analysis.ts';

export interface FakeOptions {
  /** Dances this far behind the beat. */
  lateMs?: number;
  /** A different routine from the demo take's (which uses the dancer's index). */
  seed?: number;
  /** A stretch of the song (ms) in which the camera lost the performer. */
  lost?: Range | null;
  /** The stretch danced (default: the whole playable part). */
  range?: Range;
  player?: string;
}
/** Puts the helper on the page; returns how to take it off again. */
export function installFake(session: ProjectSession, dancer: () => number): () => void {
  const page = window as unknown as { studioPlaytest?: unknown };
  const fake = async ({ lateMs = 0, seed, lost = null, range, player = 'Stand-in' }: FakeOptions = {}): Promise<AttemptInfo | null> => {
    const { dance } = session.state, index = dancer(), { song } = dance;
    const [from, to] = range ?? [song.playableStartMs, song.playableEndMs];
    const { frames, width, height } = demoFrames(from, to, song.bpm ?? 120, song.beatOffsetMs, { lateMs, lost, seed: seed ?? index });
    return session.addAttempt(frames, { dancer: dance.dancers[index].id, revision: dance.revision, player, width, height });
  };
  page.studioPlaytest = { fake };
  return () => { delete page.studioPlaytest; };
}
