import { BACKDROP_METAS, isBackdropId } from '../../../../packages/backdrops/catalog.ts';
import type { BackdropId } from '../../../../packages/backdrops/catalog.ts';

/** What's behind the menus: the Aero world's drone flight over the skyline, or a backdrop. */
export type BackgroundId = 'skyline' | BackdropId;

export const BACKGROUNDS: readonly { id: BackgroundId; name: string }[] = [
  { id: 'skyline', name: 'Skyline' },
  ...BACKDROP_METAS.map(({ id, name }) => ({ id, name })),
];

export const isBackgroundId = (id: unknown): id is BackgroundId => id === 'skyline' || isBackdropId(id);

/** Settings → Graphics → Background: one of them, or a different one each visit. */
export type BackgroundSetting = BackgroundId | 'shuffle';

// In the order the setting steps through them.
export const BACKGROUND_SETTINGS: readonly { value: BackgroundSetting; label: string }[] = [
  ...BACKGROUNDS.map(({ id, name }) => ({ value: id, label: name })),
  { value: 'shuffle', label: 'Shuffle' },
];

export const isBackgroundSetting = (value: unknown): value is BackgroundSetting => value === 'shuffle' || isBackgroundId(value);

/** Shuffle's pick: any background but `except`. */
export function shuffleBackground(except?: BackgroundId): BackgroundId {
  const pool = BACKGROUNDS.filter(({ id }) => id !== except);
  return pool[Math.floor(Math.random() * pool.length)].id;
}
