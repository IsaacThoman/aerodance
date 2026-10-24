import { BACKDROP_METAS, isBackdropId } from '../../../../packages/backdrops/catalog.ts';
import type { BackdropId } from '../../../../packages/backdrops/catalog.ts';

/** What's behind the menus: the Aero world's drone flight over the skyline, or a backdrop. */
export type BackgroundId = 'skyline' | BackdropId;

// In the order Settings → Graphics → Background steps through them.
export const BACKGROUNDS: readonly { id: BackgroundId; name: string }[] = [
  { id: 'skyline', name: 'Skyline' },
  ...BACKDROP_METAS.map(({ id, name }) => ({ id, name })),
];

export const isBackgroundId = (id: unknown): id is BackgroundId => id === 'skyline' || isBackdropId(id);
