import { isObject } from '../../../../packages/pose/choreography.ts';
import type { DisplayMode } from '../display.ts';
import { isBackgroundId } from '../backdrop/backgrounds.ts';
import type { BackgroundId } from '../backdrop/backgrounds.ts';

const KEY = 'aerodance.graphics';

/** Settings → Graphics: the display shape, or 'auto' to fit the screen (App.tsx applies it). */
export type AspectSetting = 'auto' | DisplayMode;
/** Settings → Graphics: the performance stats in the top left (stats/StatsOverlay.tsx). */
export type StatsSetting = 'off' | 'basic' | 'full';
/** Settings → Graphics: what's behind the menus (Scene.tsx). */
export type BackgroundSetting = BackgroundId;
export interface GraphicsSettings { aspect: AspectSetting; stats: StatsSetting; background: BackgroundSetting; }

export const DEFAULT_GRAPHICS: GraphicsSettings = { aspect: 'auto', stats: 'off', background: 'skyline' };
const ASPECTS: readonly AspectSetting[] = ['auto', 'standard', 'widescreen'];
const STATS: readonly StatsSetting[] = ['off', 'basic', 'full'];

// Saved settings come from storage: keep only the fields that have the right type.
function savedGraphics(saved: unknown): Partial<GraphicsSettings> {
  const graphics: Partial<GraphicsSettings> = {};
  if (!isObject(saved)) return graphics;
  const aspect = ASPECTS.find((a) => a === saved.aspect);
  if (aspect) graphics.aspect = aspect;
  const stats = STATS.find((v) => v === saved.stats);
  if (stats) graphics.stats = stats;
  if (isBackgroundId(saved.background)) graphics.background = saved.background;
  return graphics;
}

export function loadGraphics(): GraphicsSettings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return saved ? { ...DEFAULT_GRAPHICS, ...savedGraphics(saved) } : DEFAULT_GRAPHICS;
  } catch {
    return DEFAULT_GRAPHICS;
  }
}

export function saveGraphics(graphics: GraphicsSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(graphics)); } catch { /* storage unavailable */ }
}
