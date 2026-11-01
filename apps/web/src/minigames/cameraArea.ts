import type { Point, Rect } from '../ui/draw.ts';
import type { ScreenPoint } from './pose/body.ts';

/*
 * Where the camera's picture is on the screen. The pose API's screen space (pose/body.ts) is the
 * mirrored camera picture, 0-1 across and down; the picture is 4:3 and the screen 16:9 or 4:3, so
 * a game fits one to the other: cover fills the screen (cropping the picture's top and bottom on
 * 16:9, so hands reach the edges), contain shows all of it. MirrorCharacters (scene.tsx) draws the
 * players' characters with the same fit, so what a game maps lines up with them.
 */

/** Where the mirrored camera picture lands on a w x h screen (design units). */
export function cameraArea(w: number, h: number, aspect = 4 / 3, fit: 'cover' | 'contain' = 'cover'): Rect {
  const scale = fit === 'cover' ? Math.max(w / aspect, h) : Math.min(w / aspect, h);
  const pw = scale * aspect, ph = scale;
  return { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph };
}
/** A point on the mirrored camera picture (0-1) in design units, for a cameraArea. */
export const toDesign = (p: ScreenPoint, area: Rect): Point => ({ x: area.x + p.x * area.w, y: area.y + p.y * area.h });
/** A design-unit point on the camera picture (0-1), for a cameraArea. */
export const fromDesign = (p: Point, area: Rect): ScreenPoint => ({ x: (p.x - area.x) / area.w, y: (p.y - area.y) / area.h });
