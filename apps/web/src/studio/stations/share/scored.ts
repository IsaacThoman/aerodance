// Where the game will score each dancer of a song: the moments its pose shows enough of the body
// for the scorer to compare (at least half the limb weight on joints it may score, as
// packages/score/scorer.ts decides) outside the stretches left unscored. Worked out once per
// compiled song.
import { sampleDancers } from '../../../../../../packages/pose/song.ts';
import type { SongBundle } from '../../../../../../packages/pose/song.ts';
import { LIMBS, TOTAL_WEIGHT, limbDirections } from '../../../../../../packages/score/features.ts';

export interface ScoredPart {
  /** The share of the playable song this dancer is scored for, 0 to 1. */
  share: number;
  /** The stretches that are scored, in song ms. */
  spans: (readonly [number, number])[];
}
/** The scorer's interval: one score per 100 ms, compared at its middle. */
const STEP_MS = 100;
const cache = new WeakMap<SongBundle, ScoredPart[]>();

/** Each dancer's scored stretches over the playable part of the song. */
export function scoredParts(bundle: SongBundle): ScoredPart[] {
  const known = cache.get(bundle);
  if (known) return known;
  const { song, choreography } = bundle, start = song.playableStartMs;
  const steps = Math.floor((song.playableEndMs - start) / STEP_MS);
  const dancers = choreography.tracks.map(track => ({ track, aspect: track.calibration.inputWidth / track.calibration.inputHeight, scored: 0, spans: [] as [number, number][] }));
  for (let k = 0; k < steps; k++) {
    const from = start + k * STEP_MS, t = from + STEP_MS / 2, { poses, quality } = sampleDancers(bundle, t);
    for (const dancer of dancers) {
      const id = dancer.track.playerId, pose = poses.find(p => p.playerId === id), q = quality.find(p => p.playerId === id);
      if (!pose || !q || dancer.track.exclusions.some(x => t >= x.startMs && t < x.endMs)) continue;
      const weight = limbDirections(pose.landmarks, dancer.aspect, q.scoreEligible).reduce((n, direction, i) => n + (direction ? LIMBS[i].weight : 0), 0);
      if (weight < TOTAL_WEIGHT / 2) continue;
      dancer.scored++;
      // Consecutive scored steps are one stretch.
      const last = dancer.spans[dancer.spans.length - 1];
      if (last && Math.abs(last[1] - from) < 1e-6) last[1] = from + STEP_MS; else dancer.spans.push([from, from + STEP_MS]);
    }
  }
  const parts = dancers.map(d => ({ share: steps ? d.scored / steps : 0, spans: d.spans }));
  cache.set(bundle, parts);
  return parts;
}
