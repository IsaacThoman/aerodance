import type { PlayerResult } from '../../../packages/score/scorer.ts';
import type { BestScoreRecord } from './bestScores.ts';
import { PLAYER_COLORS } from '../menu/layout.ts';

/*
 * Round outcomes for the results screens: one entry per
 * dancer, seats 0-3 the blue, purple, green and pink dancers, each with its score.
 */

/** A seat's name and colours (the dancers' gel colours, lighter and darker). */
export interface PlayerLook { name: string; color: string; light: string; dark: string; }
/** One dancer's result as the results screens show it. */
export type SeatResult = PlayerResult & PlayerLook;
/** The results reveal: shared by the 2D overlay (ResultsScreen) and the stage (ResultsDancers). */
export interface ResultsShow {
  key: string;
  /** Seconds on the performance.now() clock when the reveal starts. */
  start: number;
  results: SeatResult[];
  /** The winning seat, or null for a tie or a solo round. */
  winner: number | null;
  best: BestScoreRecord;
}

export const PLAYERS: readonly PlayerLook[] = [
  { name: 'Player 1', color: PLAYER_COLORS[0], light: '#7fd0ff', dark: '#0558b0' },
  { name: 'Player 2', color: PLAYER_COLORS[1], light: '#dcb8ff', dark: '#6a2bc0' },
  { name: 'Player 3', color: PLAYER_COLORS[2], light: '#a3f5c6', dark: '#0e8a48' },
  { name: 'Player 4', color: PLAYER_COLORS[3], light: '#ffbfe0', dark: '#c02a7c' },
];

/** Index of the single highest score; null for a tie or a solo round. */
export function winnerOf(results: readonly { score: number }[]) {
  if (results.length < 2) return null;
  const top = Math.max(...results.map((r) => r.score));
  const leaders = results.filter((r) => r.score === top);
  return leaders.length === 1 ? results.indexOf(leaders[0]) : null;
}

// Reveal timeline (seconds after the screen appears).
export const COUNT = [0.5, 1.9];
// The winner is announced the moment the scores finish counting up.
export const REVEAL = COUNT[1];
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const easeOut = (t: number) => 1 - (1 - t) ** 3;
// Starts and ends at rest, so a move glides instead of jolting off the mark.
export const easeInOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
export const backOut = (t: number, s = 1.8) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
// Seconds the dancers take to walk to their result spots.
export const STEP = 1.6;

export function timeline(show: Pick<ResultsShow, 'start'>, now: number) {
  const t = now - show.start;
  return {
    t,
    count: easeOut(clamp01((t - COUNT[0]) / (COUNT[1] - COUNT[0]))),
    reveal: clamp01((t - REVEAL) / 0.6),
    step: easeInOut(clamp01((t - REVEAL) / STEP)),
  };
}
