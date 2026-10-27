import { WALK_SCENES } from './scenes.ts';
import type { WalkScene } from './scenes.ts';

// Walk mode's overlay (walk/WalkHud.tsx) in 1600x900 (16:9) or 1200x900 (4:3) design units.

/** Top left: the scene's name and the walker's mode, on a chip as wide as they need. */
export const CHIP = { x: 40, y: 34, h: 60 };

const PAD = 36;
const HEADER_H = 84;
const CAPS_H = 40;
const BUTTON_H = 54;
const COLS = 3;
const GAP_X = 16;
const GAP_Y = 12;
const SECTION_GAP = 22;
export const LEGEND_LINE = 32;
const LEGEND_LINES = 2;

/** The menu's two lists: what can stand behind the menus, and the dance stages. */
export const SECTIONS: readonly { label: string; scenes: readonly WalkScene[] }[] = [
  { label: 'Menu backgrounds', scenes: WALK_SCENES.filter(({ kind }) => kind !== 'stage') },
  { label: 'Stages', scenes: WALK_SCENES.filter(({ kind }) => kind === 'stage') },
];

/**
 * The paused menu, centred: the scene's name and the Walk button, a button for every scene in
 * three columns under each section's heading, and the controls along the bottom.
 */
export function walkLayout(width = 1600) {
  const w = Math.min(1240, width - 80);
  const x = Math.round((width - w) / 2);
  const inner = x + PAD;
  const colW = (w - 2 * PAD - (COLS - 1) * GAP_X) / COLS;
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  let y = PAD + HEADER_H + 10;
  const sections = SECTIONS.map(({ label, scenes }) => {
    const caps = y + CAPS_H / 2;
    y += CAPS_H;
    scenes.forEach((scene, i) => {
      rects.set(scene.key, { x: Math.round(inner + (i % COLS) * (colW + GAP_X)), y: y + Math.floor(i / COLS) * (BUTTON_H + GAP_Y), w: Math.round(colW), h: BUTTON_H });
    });
    const rows = Math.ceil(scenes.length / COLS);
    y += rows * BUTTON_H + (rows - 1) * GAP_Y + SECTION_GAP;
    return { label, caps, scenes };
  });
  const legend = y + LEGEND_LINE / 2;
  const h = y + LEGEND_LINES * LEGEND_LINE + PAD - 12;
  // Everything above was laid out from the panel's top; centre it.
  const top = Math.round((900 - h) / 2);
  const down = <T extends { y: number }>(shape: T): T => ({ ...shape, y: shape.y + top });
  const PANEL = { x, y: top, w, h };
  const RESUME = down({ x: x + w - PAD - 230, y: PAD + (HEADER_H - BUTTON_H) / 2, w: 230, h: BUTTON_H });
  const sceneRect = (i: number) => {
    const rect = rects.get(WALK_SCENES[i]?.key ?? '');
    return rect ? down(rect) : null;
  };
  return {
    PANEL,
    RESUME,
    /** The scene's name and subtitle, left of RESUME. */
    TITLE: { x: inner, y: top + PAD + HEADER_H / 2 },
    sections: sections.map((s) => ({ ...s, caps: s.caps + top })),
    LEGEND: { x: inner, y: legend + top, w: w - 2 * PAD },
    /** WALK_SCENES[i]'s button. */
    sceneRect,
  };
}
