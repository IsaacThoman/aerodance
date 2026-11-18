import { isObject } from '../../../../packages/pose/choreography.ts';
import { browserStorage } from '../game/bestScores.ts';
import type { BestScoreStorage } from '../game/bestScores.ts';
import type { MinigameDefinition, MinigameOption } from './types.ts';

/*
 * Each game's settings (types.ts MinigameOption): chosen on its preview or by the game itself
 * (ctx.setOption), and kept in this browser like the best scores (bestScores.ts), only the ones
 * somebody chose, so an option nobody touched follows its default if the game changes it. What's
 * read back is checked against the definition as it is now: an option it no longer has is
 * dropped, and one it doesn't offer that value for any more starts on its default.
 */

/** A game's chosen settings, by option id. */
export type MinigameOptionValues = Readonly<Record<string, string>>;
type Game = Pick<MinigameDefinition, 'options'>;

const KEY = 'aerodance-minigame-options';

// Every game's saved choices, by game id then option id (anything damaged left out).
function read(storage: BestScoreStorage): Record<string, Record<string, string>> {
  try {
    const saved: unknown = JSON.parse(storage.getItem(KEY) ?? 'null');
    const all: Record<string, Record<string, string>> = {};
    if (!isObject(saved)) return all;
    for (const [id, values] of Object.entries(saved)) {
      if (!isObject(values)) continue;
      all[id] = {};
      for (const [option, value] of Object.entries(values)) if (typeof value === 'string') all[id][option] = value;
    }
    return all;
  } catch { return {}; }
}

/**
 * A setting's key in the values: its id, or for a per-player one (MinigameOption.perPlayer) its
 * id and the player's number, "paddleHand.2" (player is 0-based, the number 1-based, as the
 * screen says Player 2).
 */
export const optionKey = (id: string, player?: number) => (player === undefined ? id : `${id}.${player + 1}`);

/** The option a key is for, and the player (0-based) for a per-player one; null for a key the game hasn't. */
export function optionOf(game: Game, key: string): { option: MinigameOption; player?: number } | null {
  const plain = game.options?.find((o) => o.id === key && !o.perPlayer);
  if (plain) return { option: plain };
  const m = /^(.+)\.([1-4])$/.exec(key);
  const option = m ? game.options?.find((o) => o.id === m[1] && o.perPlayer) : undefined;
  return option && m ? { option, player: Number(m[2]) - 1 } : null;
}

/** The game offers this value for the option (or player's option) a key names. */
export const offers = (game: Game, key: string, value: unknown): value is string =>
  !!optionOf(game, key)?.option.choices.some((c) => c.value === value);

/** Every setting the game has, by key (a per-player one for each of four players): the value given where the game offers it, else its default. */
export function resolveOptions(game: Game, values: Readonly<Record<string, unknown>> = {}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const o of game.options ?? []) {
    const keys = o.perPlayer ? [0, 1, 2, 3].map((p) => optionKey(o.id, p)) : [o.id];
    for (const key of keys) resolved[key] = offers(game, key, values[key]) ? values[key] as string : o.default;
  }
  return resolved;
}

/** A player's choice for a per-player setting (its default where there's none). */
export function playerOption(game: Game, values: MinigameOptionValues, id: string, player: number): string {
  const option = game.options?.find((o) => o.id === id);
  const value = values[optionKey(id, option?.perPlayer ? player : undefined)];
  return option?.choices.some((c) => c.value === value) ? value : option?.default ?? '';
}

/** The game's settings as last chosen in this browser (its defaults where nothing was). */
export function minigameOptions(game: Pick<MinigameDefinition, 'id' | 'options'>, storage: BestScoreStorage = browserStorage()): Record<string, string> {
  // (A game without options never asks the browser.)
  return game.options?.length ? resolveOptions(game, read(storage)[game.id]) : {};
}

/** Remembers a choice for the game (ignored unless the game offers it). */
export function saveMinigameOption(game: Pick<MinigameDefinition, 'id' | 'options'>, id: string, value: string, storage: BestScoreStorage = browserStorage()) {
  if (!offers(game, id, value)) return;
  const all = read(storage);
  // (Choices the game no longer offers go as it's saved again.)
  const kept = Object.entries(all[game.id] ?? {}).filter(([option, saved]) => offers(game, option, saved));
  all[game.id] = { ...Object.fromEntries(kept), [id]: value };
  try { storage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/** The choice before (-1) or after (1) the current one of the setting a key names, wrapping round at the ends. */
export function stepOption(game: Game, values: MinigameOptionValues, key: string, dir: -1 | 1): string | null {
  const option = optionOf(game, key)?.option;
  if (!option) return null;
  const n = option.choices.length;
  const i = option.choices.findIndex((c) => c.value === values[key]);
  return option.choices[i < 0 ? 0 : (i + dir + n) % n].value;
}

/** The settings as the canvas reports them: "assist=max|bot=medium". */
export const optionsText = (values: MinigameOptionValues) => Object.entries(values).map(([id, value]) => `${id}=${value}`).join('|');
