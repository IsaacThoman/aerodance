import {
  FONT, dancerWidth, drawCaps, drawDancer, drawGlassButton, drawShadowText, ellipsize, roundRect,
} from '../ui/draw.ts';
import type { Face, IconDraw, Point, Rect } from '../ui/draw.ts';
import { dancerFeet } from '../../../../packages/stages/shared/hooks.ts';
import { PLAYERS } from './results.ts';
import type { CastLayout } from './layout.ts';

/**
 * Song Select's dancers screen, laid out like the results (layout.ts): a glass row per player
 * down the left, each with the song's dancers to tap, the one they follow in their colour;
 * Auto stacked over Dance! bottom right; and on the stage, pushed right, each dancer's number
 * and the players following them under their feet.
 */

export interface CastView {
  layout: CastLayout;
  title: string;
  /** The dancer each player follows. */
  cast: readonly number[];
  dancers: number;
  /** Design width (1600 or 1200), and the back button's x for the title. */
  width: number;
  left: number;
  /** Hover and press (0..1) by widget id: cast-<player>, auto and dance. */
  hover: (id: string) => number;
  press: (id: string) => number;
  /** The dancer under the pointer on each player's row, or -1. */
  hovered: readonly number[];
  /** Name the dancers on the stage (it's in, and they're placed). */
  tags: boolean;
  playerCount: string;
}

// A player's colours, light to dark: the dancer they follow.
export const playerFace = (id: number): Face => [PLAYERS[id].light, PLAYERS[id].color, PLAYERS[id].dark];
export function faceFill(g: CanvasRenderingContext2D, face: Face, top: number, bottom: number) {
  const fill = g.createLinearGradient(0, top, 0, bottom);
  face.forEach((color, i) => fill.addColorStop(i / 2, color));
  return fill;
}
// A dancer the player doesn't follow: an empty spot on the glass, brighter under the pointer.
const SPARE = 'rgba(255, 255, 255, 0.3)';
const SPARE_HOVER = 'rgba(255, 255, 255, 0.6)';
const inside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

// The dancers on a player's row, ending at its right: where each can be picked, and drawn on its spot.
function castSlots(row: Rect, dancers: number): Rect[] {
  const h = row.h - 14, w = Math.round(dancerWidth(h * 0.8) + 18);
  const end = row.x + row.w - row.h * 0.3;
  return Array.from({ length: dancers }, (_, d) => ({ x: end - (dancers - d) * w - (dancers - 1 - d) * 4, y: row.y + 7, w, h }));
}
/** The dancer under `p` on a player's row, or -1 (a press elsewhere on it steps to the next dancer). */
export const castHit = (row: Rect, dancers: number, p: Point) => castSlots(row, dancers).findIndex((slot) => inside(p, slot));

// The player's number where a glass row has its icon: plain white, like the rest of its label.
const numberGlyph = (player: number): IconDraw => (g, cx, cy, r) => {
  g.font = `800 ${Math.round(r * 1.5)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(player + 1), cx, cy + r * 0.06);
};

function drawRow(g: CanvasRenderingContext2D, v: CastView, player: number) {
  const row = v.layout.rows[player], id = `cast-${player}`, dancer = v.cast[player];
  const sharing = v.cast.flatMap((d, other) => (d === dancer && other !== player ? [`Player ${other + 1}`] : []));
  const face = playerFace(player);
  drawGlassButton(g, row, {
    label: `Player ${player + 1}`,
    sub: `Dancer ${dancer + 1}${sharing.length ? ` · with ${sharing.join(' & ')}` : ''}`,
    icon: numberGlyph(player),
    // The text stops short of the dancers.
    reserve: row.x + row.w - row.h * 0.3 - castSlots(row, v.dancers)[0].x + 10,
    hover: v.hover(id), press: v.press(id),
    content: (c, r) => castSlots(r, v.dancers).forEach((slot, d) => {
      const tall = slot.h * 0.8, floor = slot.y + (slot.h + tall) / 2, picked = d === dancer;
      // Their pick: a lit spot behind the dancer, rimmed in their colour.
      if (picked) {
        c.save();
        roundRect(c, slot.x, slot.y, slot.w, slot.h, 14);
        c.fillStyle = 'rgba(255, 255, 255, 0.2)';
        c.fill();
        c.lineWidth = 3;
        c.strokeStyle = face[0];
        c.stroke();
        c.restore();
      }
      c.save();
      c.shadowColor = 'rgba(0, 30, 50, 0.45)';
      c.shadowBlur = 6;
      c.shadowOffsetY = 2;
      drawDancer(c, slot.x + slot.w / 2, floor, tall, picked ? faceFill(c, face, floor - tall, floor) : d === v.hovered[player] ? SPARE_HOVER : SPARE);
      c.restore();
    }),
  });
}

// Under each dancer on the stage: who follows them, in the results' caps, and their number.
function drawStageTags(g: CanvasRenderingContext2D, v: CastView) {
  if (!v.tags || dancerFeet.length < v.dancers) return;
  const crowd = v.dancers > 2;
  for (let d = 0; d < v.dancers; d++) {
    const feet = dancerFeet[d];
    if (!feet) continue;
    const x = feet.x * v.width, y = feet.y * 900 + 24;
    const followers = v.cast.flatMap((c, p) => (c === d ? [p + 1] : []));
    if (followers.length) {
      const label = followers.length === 1 ? `PLAYER ${followers[0]}` : `P${followers.join(' & P')}`;
      drawCaps(g, label, x, y, { size: crowd ? 17 : 21, align: 'center' });
    }
    drawShadowText(g, `Dancer ${d + 1}`, x, y + (crowd ? 24 : 28), { size: crowd ? 15 : 18, weight: 700, align: 'center', alpha: followers.length ? 0.85 : 0.6 });
  }
}

/** The dancers screen below its back button: the title, the players' rows, Auto, Dance! and the stage's tags. */
export function drawCastScreen(g: CanvasRenderingContext2D, v: CastView) {
  const { layout } = v;
  const x = v.left - 38, maxW = layout.rows[0].w + 120;
  g.font = `800 64px ${FONT}`;
  drawShadowText(g, ellipsize(g, v.title, maxW), x, 234, { size: 64, weight: 800 });
  g.font = `700 28px ${FONT}`;
  drawShadowText(g, ellipsize(g, 'Pick who each player follows', maxW), x + 2, 288, { size: 28, color: '#d8f6ff' });
  v.cast.forEach((_, player) => drawRow(g, v, player));
  drawGlassButton(g, layout.auto, { label: 'Auto', sub: 'Take turns', icon: 'replay', hover: v.hover('auto'), press: v.press('auto') });
  drawGlassButton(g, layout.dance, { label: 'Dance!', sub: v.playerCount, icon: 'play', hover: v.hover('dance'), press: v.press('dance') });
  drawStageTags(g, v);
}
