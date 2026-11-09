import { isPlayerCount } from '../../../../packages/pose/choreography.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import { isPoseDetail } from '../../../../packages/pose/webcamRecord.ts';
import type { PoseDetail } from '../../../../packages/pose/webcamRecord.ts';
import { MG_MAX_OPTIONS } from './layout.ts';
import type { HowToStep, MinigameDefinition, MinigameOption } from './types.ts';

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
  if (typeof d.title !== 'string' || !d.title) return 'title is missing';
  if (!Array.isArray(d.players) || !d.players.length || !d.players.every(isPlayerCount)) return 'players must list player counts from 1 to 4';
  if (!Array.isArray(d.howTo) || !d.howTo.every((s) => typeof s?.text === 'string' && countsProblem(s.players, d.players!) === '')) return 'howTo steps need text, and player counts the game plays with';
  for (const count of d.players) {
    const steps = howToFor(d as Pick<MinigameDefinition, 'howTo'>, count).length;
    if (steps < 1 || steps > 4) return d.players.length > 1 ? `howTo needs one to four steps with ${count} player${count > 1 ? 's' : ''}` : 'howTo needs one to four steps';
  }
  if (typeof d.icon !== 'function') return 'icon must draw the game icon';
  if (typeof d.load !== 'function') return 'load must import the game';
  if (d.durationMs !== undefined && !(d.durationMs > 0)) return 'durationMs must be positive';
  if (d.tracking !== undefined && typeof d.tracking !== 'function' && !isPoseDetail(d.tracking)) return "tracking must be 'world', 'hands' or a function choosing per round (or left out)";
  if (d.best !== undefined && d.best !== false) return 'best can only be false (a game that keeps no best)';
  return d.options === undefined ? '' : optionsProblem(d.options, d.players);
}

// What's wrong with a step's or an option's player counts: some of the game's, if given.
function countsProblem(players: unknown, game: readonly PlayerCount[]): string {
  if (players === undefined) return '';
  return Array.isArray(players) && players.length && players.every((n) => game.includes(n)) ? '' : 'its players must be some of the counts the game plays with';
}

/** The tracking a round asks the camera for (MinigameDefinition.tracking), with this many players and these settings. */
export function trackingFor(game: Pick<MinigameDefinition, 'tracking'>, playerCount: PlayerCount, options: Readonly<Record<string, string>>): PoseDetail | null {
  const asked = typeof game.tracking === 'function' ? game.tracking({ playerCount, options }) : game.tracking;
  return isPoseDetail(asked) ? asked : null;
}

/** Which a step or an option is for: this many players, unless it says otherwise. */
export const forPlayers = (item: { players?: readonly PlayerCount[] }, count: PlayerCount) => !item.players || item.players.includes(count);

/** The how-to card's steps with this many players. */
export function howToFor(game: Pick<MinigameDefinition, 'howTo'>, count: PlayerCount): readonly HowToStep[] {
  return game.howTo.filter((step) => forPlayers(step, count));
}

/** An option's id and its choices' values: letters, digits, hyphens and underscores (data-minigame-options lists them as id=value|…). */
export const OPTION_KEY = /^[A-Za-z0-9_-]+$/;

// What's wrong with a game's options: as many as its preview has rows for, each with its own id,
// a label, two or more choices of their own, and a default among them.
function optionsProblem(options: unknown, players: readonly PlayerCount[]): string {
  if (!Array.isArray(options) || options.length > MG_MAX_OPTIONS) return `options must list at most ${MG_MAX_OPTIONS} settings`;
  const ids = new Set<string>();
  for (const option of options as Partial<MinigameOption>[]) {
    const id = option?.id;
    if (typeof id !== 'string' || !OPTION_KEY.test(id)) return 'each option needs an id of letters, digits, hyphens or underscores';
    if (ids.has(id)) return `option "${id}" is listed twice`;
    ids.add(id);
    if (typeof option.label !== 'string' || !option.label) return `option "${id}" needs a label`;
    if (!Array.isArray(option.choices) || option.choices.length < 2) return `option "${id}" needs two or more choices`;
    const values = new Set<string>();
    for (const choice of option.choices as Partial<MinigameOption['choices'][number]>[]) {
      if (typeof choice?.value !== 'string' || !OPTION_KEY.test(choice.value)) return `option "${id}": each choice needs a value of letters, digits, hyphens or underscores`;
      if (typeof choice.label !== 'string' || !choice.label) return `option "${id}": choice "${choice.value}" needs a label`;
      if (values.has(choice.value)) return `option "${id}" offers "${choice.value}" twice`;
      values.add(choice.value);
    }
    if (typeof option.default !== 'string' || !values.has(option.default)) return `option "${id}"'s default must be one of its choices`;
    if (countsProblem(option.players, players)) return `option "${id}": ${countsProblem(option.players, players)}`;
  }
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
