import { PLAYERS } from '../game/results.ts';
import { topScore } from './bestScores.ts';
import type { MinigameDefinition, MinigameOutcome } from './types.ts';

/*
 * What a minigame round's results board (MinigameResults.tsx) lists, without the drawing: the
 * players in finishing order (a co-op team as one), and a solo player's opponent under them
 * (MinigameOutcome.opponent: Table Tennis's robot).
 */

/** Players in finishing order, best first (ties in player order). */
export function finishingOrder(scores: readonly number[], better: 'higher' | 'lower' = 'higher') {
  return scores.map((_, i) => i).sort((a, b) => (better === 'lower' ? scores[a] - scores[b] : scores[b] - scores[a]) || a - b);
}
/** The scores the board shows: a co-op game's (or round's) players are one team, with the team's score. */
export function resultSeats(game: Pick<MinigameDefinition, 'coop' | 'score'>, scores: readonly number[], outcome?: MinigameOutcome | null) {
  return (game.coop || outcome?.coop) && scores.length > 1 ? [topScore(scores, game.score?.better)] : scores;
}
/** The single winner, or null for a tie or a solo round. */
export function minigameWinner(scores: readonly number[], better: 'higher' | 'lower' = 'higher') {
  if (scores.length < 2) return null;
  const [first, second] = finishingOrder(scores, better);
  return scores[first] === scores[second] ? null : first;
}

/** A row of the board: its name and score, and the player it is (from 0), or null for a solo player's opponent. */
export interface BoardRow { name: string; score: number; player: number | null; }

/**
 * The board's rows, top first: the best player (the team, or the solo player's score) large, then
 * everyone else in finishing order, then a solo player's opponent. Its length is the board's
 * rows, as minigameLayout's mgResultsBoard counts them.
 */
export function boardRows(game: Pick<MinigameDefinition, 'coop' | 'score'>, scores: readonly number[], outcome?: MinigameOutcome | null): BoardRow[] {
  const seats = resultSeats(game, scores, outcome), team = seats.length < scores.length;
  const rows = finishingOrder(seats, game.score?.better).map((seat, i): BoardRow => ({
    name: i > 0 ? PLAYERS[seat].name : team ? 'Your team' : seats.length === 1 ? 'Your score' : PLAYERS[seat].name,
    score: seats[seat],
    player: seat,
  }));
  const against = outcome?.opponent;
  if (against && seats.length === 1) rows.push({ name: against.name, score: against.score, player: null });
  return rows;
}
