import { isObject } from '../../../../packages/pose/choreography.ts';
import type { BestScoreStorage } from '../game/bestScores.ts';
import type { MinigameDefinition } from './types.ts';

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

/** The game offers this value for this option. */
export const offers = (game: Game, id: string, value: unknown): value is string =>
  !!game.options?.some((o) => o.id === id && o.choices.some((c) => c.value === value));

/** Every option the game has, by id: the value given where the game offers it, else its default. */
export function resolveOptions(game: Game, values: Readonly<Record<string, unknown>> = {}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const o of game.options ?? []) resolved[o.id] = offers(game, o.id, values[o.id]) ? values[o.id] as string : o.default;
  return resolved;
}

/** The game's settings as last chosen in this browser (its defaults where nothing was). */
export function minigameOptions(game: Pick<MinigameDefinition, 'id' | 'options'>, storage: BestScoreStorage = globalThis.localStorage): Record<string, string> {
  // (A game without options never asks the browser.)
  return game.options?.length ? resolveOptions(game, read(storage)[game.id]) : {};
}

/** Remembers a choice for the game (ignored unless the game offers it). */
export function saveMinigameOption(game: Pick<MinigameDefinition, 'id' | 'options'>, id: string, value: string, storage: BestScoreStorage = globalThis.localStorage) {
  if (!offers(game, id, value)) return;
  const all = read(storage);
  // (Choices the game no longer offers go as it's saved again.)
  const kept = Object.entries(all[game.id] ?? {}).filter(([option, saved]) => offers(game, option, saved));
  all[game.id] = { ...Object.fromEntries(kept), [id]: value };
  try { storage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/** The choice before (-1) or after (1) the current one, wrapping round at the ends. */
export function stepOption(game: Game, values: MinigameOptionValues, id: string, dir: -1 | 1): string | null {
  const option = game.options?.find((o) => o.id === id);
  if (!option) return null;
  const n = option.choices.length;
  const i = option.choices.findIndex((c) => c.value === values[id]);
  return option.choices[i < 0 ? 0 : (i + dir + n) % n].value;
}

/** The settings as the canvas reports them: "assist=max|bot=medium". */
export const optionsText = (values: MinigameOptionValues) => Object.entries(values).map(([id, value]) => `${id}=${value}`).join('|');
