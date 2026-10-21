import { GRADES } from '../../../../packages/score/scorer.ts';
import type { Grade, PlayerResult } from '../../../../packages/score/scorer.ts';
import { finite, isObject, oneOf } from '../../../../packages/pose/choreography.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';

/*
 * Best scores per song and player mode, kept in this browser. Keyed by scorer version too:
 * a new scorer can score differently, and an old best shouldn't block or flatter a new one.
 */

/** A saved best: the top player's score and when it was set (ISO time). */
export interface BestScore { score: number; grade: Grade; accuracy: number; at: string; }
export interface BestScoreRecord { previous: BestScore | null; best: BestScore | null; isNewBest: boolean; }
export type BestScoreStorage = Pick<Storage, 'getItem' | 'setItem'>;
/** What a finished song's result needs for a best score. */
export type ScoredResult = Pick<PlayerResult, 'score' | 'grade' | 'accuracy' | 'scorerVersion'>;

const KEY = 'aerodance-best-scores';
const GRADE_NAMES = GRADES.map(([grade]) => grade);

const keyFor = (songId: string, playerCount: PlayerCount, scorerVersion: number) => `${songId}|${playerCount}p|v${scorerVersion}`;

// Saved bests come from storage: keep the well-formed ones.
function savedBest(best: unknown): BestScore | null {
  if (!isObject(best) || !finite(best.score) || !finite(best.accuracy) || typeof best.at !== 'string') return null;
  // F replaces the old failing label; point totals and scorer version are unchanged.
  const grade = best.grade === 'D' ? 'F' : best.grade;
  return oneOf(GRADE_NAMES, grade) ? { ...best, score: best.score, accuracy: best.accuracy, at: best.at, grade } : null;
}

function read(storage: BestScoreStorage): Record<string, BestScore> {
  try {
    const scores: unknown = JSON.parse(storage.getItem(KEY) ?? 'null');
    const all: Record<string, BestScore> = {};
    if (!isObject(scores)) return all;
    for (const [key, value] of Object.entries(scores)) {
      const best = savedBest(value);
      if (best) all[key] = best;
    }
    return all;
  } catch { return {}; }
}

export function bestScore(songId: string, playerCount: PlayerCount, scorerVersion: number, storage: BestScoreStorage = globalThis.localStorage): BestScore | null {
  return read(storage)[keyFor(songId, playerCount, scorerVersion)] ?? null;
}

/**
 * Saves a finished song's results (one per player) if any beats the best; returns
 * { previous, best, isNewBest }.
 */
export function recordResults(songId: string, playerCount: PlayerCount, results: readonly ScoredResult[], storage: BestScoreStorage = globalThis.localStorage): BestScoreRecord {
  const top = results.reduce((a, b) => (b.score > a.score ? b : a));
  const key = keyFor(songId, playerCount, top.scorerVersion);
  const all = read(storage);
  const previous = all[key] ?? null;
  const isNewBest = top.score > 0 && (!previous || top.score > previous.score);
  if (isNewBest) {
    all[key] = { score: top.score, grade: top.grade, accuracy: top.accuracy, at: new Date().toISOString() };
    try { storage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
  }
  return { previous, best: isNewBest ? all[key] : previous, isNewBest };
}
