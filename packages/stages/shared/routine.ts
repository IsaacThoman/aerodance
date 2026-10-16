import type { SongBundle } from '../../pose/song.ts';
import type { PlayerCount } from '../../pose/choreography.ts';

/** A song's choreography for the dancers to follow. Plain types, so Node code can import it. */
export interface DancerRoutine {
  bundle: SongBundle;
  /** One player dances alone in the middle. */
  playerCount: PlayerCount;
  /** The song clock. */
  timeMs: () => number;
  /** Reveals the dancers at the first beat. */
  entranceTimeMs?: () => number;
}
