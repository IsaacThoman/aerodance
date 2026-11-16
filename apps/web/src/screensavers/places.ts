import { BACKDROP_METAS } from '../../../../packages/backdrops/catalog.ts';
import type { BackdropId } from '../../../../packages/backdrops/catalog.ts';
import type { IconDraw } from '../ui/draw.ts';
import type { ScreensaverDefinition } from './types.ts';

/*
 * A screensaver of one of the menu backdrops (packages/backdrops), named as Settings names it:
 * the menus' Scene draws it, and its folder's Saver.tsx (if it has one) flies the backdrop's own
 * camera through its views (kit.ts useCameraViews).
 */
export function backdropSaver(id: BackdropId, icon: IconDraw, patch: Partial<ScreensaverDefinition> = {}): ScreensaverDefinition {
  const meta = BACKDROP_METAS.find((m) => m.id === id);
  if (!meta) throw Error(`No backdrop "${id}"`);
  return { id, title: meta.name, subtitle: meta.subtitle, icon, views: [{ value: 'drift', label: 'Drift' }], scene: { background: id }, order: 50, ...patch };
}
