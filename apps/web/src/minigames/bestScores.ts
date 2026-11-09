import { finite, isObject } from '../../../../packages/pose/choreography.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import type { BestScoreStorage } from '../game/bestScores.ts';

/*
 * Best scores per minigame and player count, kept in this browser like the songs' (game/bestScores.ts).
 * A round's best is its top player's score; a game whose scores are better lower (times, misses)
 * says so, and its best is the lowest.
 */

/** A saved best: the score and when it was set (ISO time). */
export interface MinigameBest { score: number; at: string; }
export interface MinigameBestRecord { previous: MinigameBest | null; best: MinigameBest | null; isNewBest: boolean; }

const KEY = 'aerodance-minigame-bests';
const keyFor = (id: string, playerCount: PlayerCount) => `${id}|${playerCount}p`;

function read(storage: BestScoreStorage): Record<string, MinigameBest> {
  try {
    const saved: unknown = JSON.parse(storage.getItem(KEY) ?? 'null');
    const all: Record<string, MinigameBest> = {};
    if (!isObject(saved)) return all;
    for (const [key, value] of Object.entries(saved)) {
      if (isObject(value) && finite(value.score) && typeof value.at === 'string') all[key] = { score: value.score, at: value.at };
    }
    return all;
  } catch { return {}; }
}

export function minigameBest(id: string, playerCount: PlayerCount, storage: BestScoreStorage = globalThis.localStorage): MinigameBest | null {
  return read(storage)[keyFor(id, playerCount)] ?? null;
}

/** The best of a round's scores, which way is better. */
export const topScore = (scores: readonly number[], better: 'higher' | 'lower' = 'higher') =>
  (better === 'lower' ? Math.min(...scores) : Math.max(...scores));

/**
 * Saves a round's top score if it beats the best for this game and player count; returns
 * { previous, best, isNewBest }. A round that scored nothing (higher is better and the top is 0)
 * never sets a best.
 */
export function recordMinigameBest(id: string, playerCount: PlayerCount, scores: readonly number[], better: 'higher' | 'lower' = 'higher', storage: BestScoreStorage = globalThis.localStorage): MinigameBestRecord {
  const top = topScore(scores, better);
  const all = read(storage), key = keyFor(id, playerCount);
  const previous = all[key] ?? null;
  const beats = !previous || (better === 'lower' ? top < previous.score : top > previous.score);
  const isNewBest = finite(top) && (better === 'lower' || top > 0) && beats;
  if (isNewBest) {
    all[key] = { score: top, at: new Date().toISOString() };
    try { storage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
  }
  return { previous, best: isNewBest ? all[key] : previous, isNewBest };
}
