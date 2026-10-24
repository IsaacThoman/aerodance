// The keyboard focus ring: useCanvasUI draws it around the widget the keyboard cursor is on.
// A soap-bubble rim of pastel mint, sky and lilac that turns slowly round the widget.
import type { CanvasUI, Widget } from './useCanvasUI.ts';

type Ctx = CanvasRenderingContext2D;

/** A widget's outline as a rounded rect (a circle is a square with r = w / 2). */
interface Shape { x: number; y: number; w: number; h: number; r: number; }

// Pills and glass buttons lift 3 units while hovered (drawPill, drawGlassButton: widget.corner
// gives the latter's corners); tall rects are previews, near-square rects discs,
// short wide ones settings rows (they don't lift).
const ROW_H = 60;
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
  return { x, y: h < ROW_H ? y : y - hover * 3, w, h, r: wdg.corner ?? h / 2 };
}

// The ring sits this far outside the widget, closer round short rows (settings) so it
// stays clear of the rows beside them.
const GAP = 8;
const ROW_GAP = 2;
// Seconds per turn of the colours.
const TURN = 12;
const FILM = ['#9ff5e4', '#9fdcff', '#d6c8ff', '#ffffff', '#9ff5e4', '#9fdcff', '#ffd6f0', '#ffffff', '#9ff5e4'];

/** Per-overlay ring state: how far it has faded in, the outline it is drawn on, the last turn step drawn. */
export interface FocusRing { k: number; shape: Shape | null; step: number; }
export const createFocusRing = (): FocusRing => ({ k: 0, shape: null, step: -1 });
// The colours turn in steps of 1/15 s, so the ring alone redraws its overlay 15 times a second.
const STEPS_PER_S = 15;

/** Fades the ring in on the keyboard cursor's widget (or out without one). */
export function updateFocusRing(ring: FocusRing, wdg: Widget | undefined, ui: CanvasUI) {
  if (wdg) ring.shape = shapeOf(wdg, ui.hover[wdg.id] ?? 0);
  ring.k = ui.ease(ring.k, wdg ? 1 : 0, wdg ? 14 : 10);
  if (!wdg && ring.k === 0) ring.shape = null;
  // The colours keep turning: keep redrawing while the ring shows.
  const step = Math.floor(ui.time * STEPS_PER_S);
  if (ring.shape && step !== ring.step) {
    ring.step = step;
    ui.dirty = true;
  }
  if (ring.shape) ui.requestFrame();
}

export function drawFocusRing(g: Ctx, ring: FocusRing) {
  if (!ring.shape || ring.k < 0.005) return;
  const s = ring.shape;
  const gap = s.h < ROW_H && s.w > s.h * 2 ? ROW_GAP : GAP;
  const o = { x: s.x - gap, y: s.y - gap, w: s.w + gap * 2, h: s.h + gap * 2, r: s.r + gap };
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
  const film = g.createConicGradient((ring.step / STEPS_PER_S / TURN) * Math.PI * 2, o.x + o.w / 2, o.y + o.h / 2);
  FILM.forEach((c, i) => film.addColorStop(i / (FILM.length - 1), c));
  outline();
  g.lineWidth = 5;
  g.globalAlpha *= 0.9;
  g.strokeStyle = film;
  g.stroke();
  g.restore();
}
