import { minigameOptions, saveMinigameOption } from '../minigames/options.ts';
import type { BestScoreStorage } from '../game/bestScores.ts';
import type { MinigameOption } from '../minigames/types.ts';
import { SHARED_OPTIONS, SHUFFLE_ID, SHUFFLE_OPTIONS, clockChoices, ownOptions } from './definition.ts';
import type { ScreensaverDefinition } from './types.ts';

/*
 * The screensavers' settings, kept in the browser as the minigames' are (minigames/options.ts,
 * whose checks they go through: a choice a screensaver no longer offers is back at its default):
 * each screensaver's View and Scene under its id, the shared Time, Weather and Clock under
 * 'shared', and Shuffle's under 'shuffle', all in their own entry.
 */

const KEY = 'aerodance-screensaver-options';
// The minigames' functions read and write their own key: point them at the screensavers'.
const store = (storage: BestScoreStorage | undefined): BestScoreStorage => ({
  getItem: () => { try { return storage?.getItem(KEY) ?? null; } catch { return null; } },
  setItem: (_key, value) => { try { storage?.setItem(KEY, value); } catch { /* storage unavailable */ } },
});
const local = (): BestScoreStorage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

export type SaverValues = Readonly<Record<string, string>>;
type Rows = { id: string; options: readonly MinigameOption[] };

const SHARED: Rows = { id: 'shared', options: SHARED_OPTIONS };
const SHUFFLE: Rows = { id: SHUFFLE_ID, options: SHUFFLE_OPTIONS };
const rowsOf = (saver: ScreensaverDefinition | null): Rows => (saver ? { id: saver.id, options: ownOptions(saver) } : SHUFFLE);

/** A screensaver's own settings (Shuffle's for null), as last chosen here. */
export const saverValues = (saver: ScreensaverDefinition | null, storage = local()) => minigameOptions(rowsOf(saver), store(storage));
/** The shared Time, Weather and Clock, as last chosen here. */
export const sharedValues = (storage = local()) => minigameOptions(SHARED, store(storage));

/** Remembers a choice: a shared one (time, weather, clock) for all, any other for the screensaver (Shuffle for null). */
export function saveSaverValue(saver: ScreensaverDefinition | null, id: string, value: string, storage = local()) {
  if (SHARED_OPTIONS.some((o) => o.id === id)) saveMinigameOption(SHARED, id, value, store(storage));
  else saveMinigameOption(rowsOf(saver), id, value, store(storage));
}

/**
 * Every row a preview shows, in order: the screensaver's own (or Shuffle's), then the shared ones
 * (the Clock row offering In scene only where there's a clock in the scene).
 */
export const previewRows = (saver: ScreensaverDefinition | null): MinigameOption[] => [
  ...rowsOf(saver).options,
  ...SHARED_OPTIONS.map((o) => (o.id === 'clock' ? { ...o, choices: clockChoices(saver) } : o)),
];
