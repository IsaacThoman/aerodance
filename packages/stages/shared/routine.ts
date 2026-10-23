import type { Cast, SongBundle } from '../../pose/song.ts';

/** A song's choreography for the dancers to follow. Plain types, so Node code can import it. */
export interface DancerRoutine {
  bundle: SongBundle;
  /** The dancer each player follows: every dancer dances, in the colour of the first player following them. */
  cast: Cast;
  /** The song clock. */
  timeMs: () => number;
  /** Reveals the dancers at the first beat. */
  entranceTimeMs?: () => number;
}
