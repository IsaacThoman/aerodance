// The keyboard focus ring: useCanvasUI draws it around the widget the keyboard cursor is on.
// A soap-bubble rim of pastel mint, sky and lilac that turns slowly round the widget.
import type { CanvasUI, Widget } from './useCanvasUI.ts';

type Ctx = CanvasRenderingContext2D;

/** A widget's outline as a rounded rect (a circle is a square with r = w / 2). */
interface Shape { x: number; y: number; w: number; h: number; r: number; }

// Pills lift 3 units while hovered (drawPill); tall rects are previews, near-square rects discs.
function shapeOf(wdg: Widget, hover: number): Shape {
  if (wdg.circle) {
    const { x, y, r } = wdg.circle;
    return { x: x - r, y: y - r, w: r * 2, h: r * 2, r };
  }
  const { x, y, w, h } = wdg.rect;
  if (h > 200) return { x, y, w, h, r: 18 };
  if (w < h * 2) {
    const r = Math.min(w, h) / 2;
    return { x: x + w / 2 - r, y: y + h / 2 - r, w: r * 2, h: r * 2, r };
  }
  return { x, y: y - hover * 3, w, h, r: h / 2 };
}

// The ring sits this far outside the widget.
const GAP = 8;
// Seconds per turn of the colours.
const TURN = 12;
const FILM = ['#9ff5e4', '#9fdcff', '#d6c8ff', '#ffffff', '#9ff5e4', '#9fdcff', '#ffd6f0', '#ffffff', '#9ff5e4'];

/** Per-overlay ring state: how far it has faded in and the outline it is drawn on. */
export interface FocusRing { k: number; shape: Shape | null; }
export const createFocusRing = (): FocusRing => ({ k: 0, shape: null });

/** Fades the ring in on the keyboard cursor's widget (or out without one). */
export function updateFocusRing(ring: FocusRing, wdg: Widget | undefined, ui: CanvasUI) {
  if (wdg) ring.shape = shapeOf(wdg, ui.hover[wdg.id] ?? 0);
  ring.k = ui.ease(ring.k, wdg ? 1 : 0, wdg ? 14 : 10);
  if (!wdg && ring.k === 0) ring.shape = null;
  // The colours keep turning: keep frames coming while the ring shows.
  if (ring.shape) ui.dirty = true;
}

export function drawFocusRing(g: Ctx, ring: FocusRing, ui: CanvasUI) {
  if (!ring.shape || ring.k < 0.005) return;
  const s = ring.shape;
  const o = { x: s.x - GAP, y: s.y - GAP, w: s.w + GAP * 2, h: s.h + GAP * 2, r: s.r + GAP };
  const outline = () => { g.beginPath(); g.roundRect(o.x, o.y, o.w, o.h, Math.min(o.r, o.w / 2, o.h / 2)); };
  g.save();
  g.globalAlpha *= ring.k;
  // A faint aqua base with a soft navy shadow, so the ring reads over bright sky and grass.
  g.save();
  g.shadowColor = 'rgba(0, 34, 84, 0.45)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  outline();
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(79, 216, 232, 0.55)';
  g.stroke();
  g.restore();
  // The film over it.
  const film = g.createConicGradient((ui.time / TURN) * Math.PI * 2, o.x + o.w / 2, o.y + o.h / 2);
  FILM.forEach((c, i) => film.addColorStop(i / (FILM.length - 1), c));
  outline();
  g.lineWidth = 5;
  g.globalAlpha *= 0.9;
  g.strokeStyle = film;
  g.stroke();
  g.restore();
}
