import type { Circle, Point, Rect } from './draw.ts';

/**
 * Hit testing for the canvas UI (useCanvasUI.ts), in content units: which widget a point is on.
 *
 * Every widget counts out a little past its edge. For touch, small ones also reach `min` units
 * across (MIN_TOUCH_PX at the canvas's displayed size), centred on them, so a finger finds them
 * on a phone, where the 1600x900 design is shown 667 points wide. Where those areas overlap, the
 * widget drawn nearest the point wins, so a grown area never takes a tap that is closer to its
 * neighbour.
 */

type Shape = { rect: Rect; circle?: undefined } | { circle: Circle; rect?: undefined };

/** Apple's smallest touch target, 44 points: CSS pixels in iOS WebKit. */
export const MIN_TOUCH_PX = 44;
// Hit areas are padded a little so a bubble's rim and edge count as part of it.
const PAD = 8;
const RIM = 6;

/** p is on the shape, its padding, or the `min` units across centred on it. */
export function hit(p: Point | null, shape: Shape, min = 0): p is Point {
  if (!p) return false;
  if (shape.rect) {
    const { x, y, w, h } = shape.rect;
    return Math.abs(p.x - x - w / 2) <= Math.max(w / 2 + PAD, min / 2) && Math.abs(p.y - y - h / 2) <= Math.max(h / 2 + PAD, min / 2);
  }
  const { circle } = shape;
  return Math.hypot(p.x - circle.x, p.y - circle.y) <= Math.max(circle.r + RIM, min / 2);
}

/** How far p is from the shape as drawn (0 on it). */
function gap(p: Point, shape: Shape) {
  if (shape.circle) return Math.max(0, Math.hypot(p.x - shape.circle.x, p.y - shape.circle.y) - shape.circle.r);
  const { x, y, w, h } = shape.rect;
  return Math.hypot(Math.max(x - p.x, 0, p.x - x - w), Math.max(y - p.y, 0, p.y - y - h));
}

/** The widget at p: of those it hits, the one drawn nearest it (the first, among widgets drawn on top of each other). */
export function widgetAt<W extends Shape>(widgets: readonly W[], p: Point | null, min = 0): W | undefined {
  let found: W | undefined;
  let nearest = Infinity;
  for (const wdg of widgets) {
    if (!hit(p, wdg, min)) continue;
    const d = gap(p, wdg);
    if (d < nearest) { found = wdg; nearest = d; }
  }
  return found;
}
