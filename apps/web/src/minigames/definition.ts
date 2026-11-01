import { isPlayerCount } from '../../../../packages/pose/choreography.ts';
import type { MinigameDefinition } from './types.ts';

/*
 * Checks a game's definition (types.ts) and puts the list in order: registry.ts runs every game
 * it finds through these, and the unit tests do the same for each game's folder.
 */

export const MINIGAME_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** What's wrong with a definition, if anything ('' when it's fine). */
export function definitionProblem(def: unknown, folder?: string): string {
  if (typeof def !== 'object' || def === null) return 'its index.ts must default-export a MinigameDefinition';
  const d = def as Partial<MinigameDefinition>;
  if (typeof d.id !== 'string' || !MINIGAME_ID.test(d.id)) return 'id must be lower-case words joined by hyphens';
  if (folder !== undefined && d.id !== folder) return `id "${d.id}" must match its folder "${folder}"`;
  for (const key of ['title', 'blurb', 'description'] as const) if (typeof d[key] !== 'string' || !d[key]) return `${key} is missing`;
  if (!Array.isArray(d.players) || !d.players.length || !d.players.every(isPlayerCount)) return 'players must list player counts from 1 to 4';
  if (!Array.isArray(d.howTo) || !d.howTo.length || d.howTo.length > 4 || !d.howTo.every((s) => typeof s?.text === 'string')) return 'howTo needs one to four steps';
  if (typeof d.art !== 'function') return 'art must draw the tile';
  if (typeof d.load !== 'function') return 'load must import the game';
  if (d.durationMs !== undefined && !(d.durationMs > 0)) return 'durationMs must be positive';
  return '';
}

/** The games to list: valid ones (a broken one is left out and said in the console), dev-only ones only in development, in order. */
export function listMinigames(found: readonly { folder: string; def: unknown }[], { dev = false } = {}): MinigameDefinition[] {
  const games: MinigameDefinition[] = [];
  for (const { folder, def } of found) {
    const problem = definitionProblem(def, folder);
    if (problem) { console.error(`[minigames] ${folder}: ${problem}`); continue; }
    const game = def as MinigameDefinition;
    if (game.devOnly && !dev) continue;
    games.push(game);
  }
  return games.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
}

/** Supported counts, in order: "1 player", "1-2 players", "2 or 4 players". */
export function playersLabel(players: readonly number[]) {
  const sorted = [...new Set(players)].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => !i || n === sorted[i - 1] + 1);
  const span = sorted.length === 1 ? String(sorted[0]) : contiguous ? `${sorted[0]}–${sorted.at(-1)}` : `${sorted.slice(0, -1).join(', ')} or ${sorted.at(-1)}`;
  return `${span} player${sorted.length === 1 && sorted[0] === 1 ? '' : 's'}`;
}

/** A score as the game writes it (types.ts ScoreFormat), with its unit if asked. */
export function formatScore(game: Pick<MinigameDefinition, 'score'>, score: number, { unit = false } = {}) {
  const text = game.score?.format?.(score) ?? Math.round(score).toLocaleString('en-US');
  return unit && game.score?.unit ? `${text} ${game.score.unit}` : text;
}
