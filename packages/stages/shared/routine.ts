import type { SongBundle } from '../../pose/song.ts';
import { autoCast } from '../../pose/choreography.ts';
import type { Cast, PlayerCount } from '../../pose/choreography.ts';

/** A song's choreography for the dancers to follow. Plain types, so Node code can import it. */
export interface DancerRoutine {
  bundle: SongBundle;
  playerCount: PlayerCount;
  /** The dancer each player dances; the automatic one (autoCast) when missing. */
  cast?: Cast;
  /** The song clock. */
  timeMs: () => number;
  /** Reveals the dancers at the first beat. */
  entranceTimeMs?: () => number;
}

/** A coach on the stage: a dancer of the song, and the player following them (null: nobody). */
export interface Coach { dancer: number; player: number | null; }

/** The routine's cast: its own, or the automatic one for its player count. */
export const routineCast = (routine: DancerRoutine): Cast =>
  routine.cast ?? autoCast(routine.playerCount, routine.bundle.choreography.tracks.length);

/**
 * The coaches dancing a routine, left to right: every dancer of the song, in their order, once
 * for each player dancing them (so every player has a coach in their own colour, and players
 * sharing a dancer stand side by side), or once for nobody. One player of a duet sees both
 * dancers; four players of a duet see it danced in pairs.
 */
export function coachesFor(cast: Cast, dancers: number): Coach[] {
  return Array.from({ length: dancers }, (_, dancer) => {
    const players = cast.flatMap((d, player) => (d === dancer ? [player] : []));
    return players.length ? players.map((player) => ({ dancer, player })) : [{ dancer, player: null }];
  }).flat();
}
