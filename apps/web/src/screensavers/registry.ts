import { listScreensavers } from './definition.ts';
import type { ScreensaverDefinition } from './types.ts';

/*
 * Every screensaver: each folder here with an index.ts default-exporting a ScreensaverDefinition
 * (types.ts) is found at build time, so a new one needs no line anywhere else. Ones whose
 * definition is broken are left out (the console says why); devOnly ones are listed in
 * development. Ordered by `order`, then title.
 */

const found = import.meta.glob<ScreensaverDefinition>('./*/index.ts', { eager: true, import: 'default' });

export const SCREENSAVERS: readonly ScreensaverDefinition[] = listScreensavers(
  Object.entries(found).map(([path, def]) => ({ folder: path.split('/')[1], def })),
  { dev: import.meta.env.DEV },
);

export const screensaverById = (id: string | null | undefined) => SCREENSAVERS.find((saver) => saver.id === id) ?? null;
