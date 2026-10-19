import type { AeroQuality } from '../aero/types.ts';

const KEY = 'aerodance.graphics';

/**
 * Settings → Graphics: the Aero world's quality. 'low' builds fewer grass blades, flowers,
 * trees, cars and clouds, simpler tree crowns and smaller shadow and lake reflection maps;
 * 'auto' picks low on touch screens and high elsewhere (aero/context.ts).
 */
export type GraphicsQuality = AeroQuality;

export const GRAPHICS_OPTIONS: readonly { id: GraphicsQuality; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
];

export const DEFAULT_GRAPHICS: GraphicsQuality = 'auto';

export function loadGraphics(): GraphicsQuality {
  try {
    const saved = localStorage.getItem(KEY);
    return GRAPHICS_OPTIONS.find((o) => o.id === saved)?.id ?? DEFAULT_GRAPHICS;
  } catch {
    return DEFAULT_GRAPHICS;
  }
}

export function saveGraphics(graphics: GraphicsQuality) {
  try { localStorage.setItem(KEY, graphics); } catch { /* storage unavailable */ }
}
