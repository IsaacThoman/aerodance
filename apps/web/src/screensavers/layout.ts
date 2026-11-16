// Screensavers layouts in 1600x900 (16:9) or 1200x900 (4:3) design units, beside the minigames'
// (minigames/layout.ts): the list's back button, heading and the preview's setting rows sit where
// Experiments has its own, so the two read as one place.
import type { Circle, Rect } from '../ui/draw.ts';
import { minigameLayout } from '../minigames/layout.ts';

/** The list: buttons in a column on the left, the screensaver under the cursor showing behind. */
export const SV_PER_PAGE = 6;
const LIST = { y: 226, h: 76, gap: 12 };
const listX = (width: number) => (width === 1200 ? 72 : 128);
const listW = (width: number) => (width === 1200 ? 400 : 440);

/** The ith button on the page in view. */
export const svTile = (i: number, width = 1600): Rect => ({ x: listX(width), y: LIST.y + i * (LIST.h + LIST.gap), w: listW(width), h: LIST.h });

/**
 * The list, the preview and the full-screen overlay, laid out for a display's width; the preview
 * makes room for `rows` setting rows (as Experiments' previews do).
 */
export function screensaverLayout(width = 1600, rows = 0) {
  const mg = minigameLayout(width, rows);
  const compact = width === 1200;
  const left = listX(width);
  const listBottom = LIST.y + SV_PER_PAGE * LIST.h + (SV_PER_PAGE - 1) * LIST.gap;
  // The preview's note (where the live weather is for) and Use my location, under the rows.
  const rowsBottom = mg.MG_OPTIONS ? mg.MG_OPTIONS.y + mg.MG_OPTIONS.h : 310;
  return {
    SV_BACK: mg.MG_BACK as Circle,
    svTile: (i: number) => svTile(i, width),
    SV_PAGE_PREV: { x: left + 30, y: listBottom + 44, r: 26 } as Circle,
    SV_PAGE_NEXT: { x: left + listW(width) - 30, y: listBottom + 44, r: 26 } as Circle,
    SV_PAGE_DOTS: { x: left + listW(width) / 2, y: listBottom + 44 },
    /** The preview: its title's left and width, the subtitle's middle, the rows, and Start. */
    SV_TEXT: mg.MG_TEXT,
    SV_TITLE_Y: mg.MG_BACK.y + 84,
    SV_SUBTITLE_Y: mg.MG_BEST_Y,
    SV_OPTIONS: mg.MG_OPTIONS,
    svOption: mg.mgOption,
    svOptionPrev: mg.mgOptionPrev,
    svOptionNext: mg.mgOptionNext,
    SV_NOTE_Y: rowsBottom + 36,
    /** Use my location, a small glass pill under the note. */
    SV_LOCATE: { x: left, y: rowsBottom + 64, w: compact ? 260 : 290, h: 52 } as Rect,
    SV_START: { ...mg.MG_PLAY, w: compact ? 340 : 370 } as Rect,
    /** Full screen: the clock in the bottom right corner, the large clock bottom left, the caption over it. */
    SV_CLOCK_RIGHT: width - (compact ? 56 : 72),
    SV_CLOCK_BOTTOM: 900 - 60,
    SV_LARGE_CLOCK: { x: compact ? 72 : 112, y: 700 },
    SV_CAPTION: { x: compact ? 56 : 72, y: 900 - 74 },
  };
}
