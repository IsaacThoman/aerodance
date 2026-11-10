import { listMinigames } from './definition.ts';
import type { MinigameDefinition } from './types.ts';

/*
 * Every minigame: each folder here with an index.ts default-exporting a MinigameDefinition
 * (types.ts) is found at build time, so a new game needs no line anywhere else. Ones whose
 * definition is broken are left out (the console says why); devOnly ones are listed in
 * development, or with ?devgames. Ordered by `order`, then title.
 */

const found = import.meta.glob<MinigameDefinition>('./*/index.ts', { eager: true, import: 'default' });

export const MINIGAMES: readonly MinigameDefinition[] = listMinigames(
  Object.entries(found).map(([path, def]) => ({ folder: path.split('/')[1], def })),
  { dev: import.meta.env.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('devgames')) },
);

export const minigameById = (id: string) => MINIGAMES.find((game) => game.id === id) ?? null;
