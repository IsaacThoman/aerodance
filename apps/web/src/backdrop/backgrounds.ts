import { isBackdropId } from '../../../../packages/backdrops/catalog.ts';
import type { BackdropId } from '../../../../packages/backdrops/catalog.ts';

/** What's behind the menus: the Aero world's drone flight over the skyline, or a backdrop. */
export type BackgroundId = 'skyline' | BackdropId;

export const isBackgroundId = (id: unknown): id is BackgroundId => id === 'skyline' || isBackdropId(id);
