// Title menu layouts in 1600x900 (16:9) or 1200x900 (4:3) design units.
export const TITLE = { x: 124, y: 418, size: 156 };
// On the players screen the title rises to make room for the dial.
export const PLAYERS_TITLE_Y = 210;

// Main screen.
export const START = { x: 128, y: 482, w: 440, h: 104 };
export const SETTINGS = { x: 128, y: 602, w: 440, h: 104 };

// Settings: back button + small caps heading top left, where Song Select has its own
// (game/layout.ts); the title fades out to make room for the Sound and Graphics panels.
export const BACK = { x: 166, y: 150, r: 30 };

// Players screen: the header sits under the raised title, Let's dance sits bottom left, and
// a big-number dial (minus, count, plus) is centered vertically between them. The dancers on
// the puck (menu/MenuDancers.tsx) show the count.
export const PLAYERS_BACK = { x: 166, y: 292, r: 30 };
// Wide enough for "Let's dance" with room to spare at the pill's rounded end.
export const PLAYERS_GO = { x: 128, y: 766, w: 370, h: 92 };
const DIAL_Y = Math.round((PLAYERS_BACK.y + PLAYERS_BACK.r + PLAYERS_GO.y) / 2);
export const COUNT_X = 426;
export const MINUS = { x: COUNT_X - 112, y: DIAL_Y, r: 40 };
export const PLUS = { x: COUNT_X + 112, y: DIAL_Y, r: 40 };
// The menu dancers' blue and purple, then green and pink for players three and four.
export const PLAYER_COLORS = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4'] as const;

// Settings rows: the first row's centre below its panel's top, and the spacing.
const ROWS_TOP = 98;
const ROW_H = 50;

/** Compact menus leave a separate area for the dancers on the right. */
export function menuLayout(width = 1600) {
  const compact = width === 1200;
  const x = compact ? 72 : 128;
  // Shapes from the left edge of the 16:9 layout, moved to this one's.
  const left = <T extends { x: number }>(shape: T): T => ({ ...shape, x: shape.x - 128 + x });
  // Each settings panel has its heading, then rows ROW_H apart.
  const w = compact ? 540 : 600;
  const rowsHeight = (rows: number) => ROWS_TOP + (rows - 1) * ROW_H + 48;
  const SOUND = { x, y: 222, w, h: rowsHeight(5) };
  const GRAPHICS = { x, y: SOUND.y + SOUND.h + 24, w, h: rowsHeight(2) };
  const graphicsRowY = (row: number) => GRAPHICS.y + ROWS_TOP + row * ROW_H;
  // Three options side by side, right of the row's label: Aspect ratio Auto / 4:3 / 16:9, then
  // Stats Off / Basic / Full.
  const options = { x0: x + 240, x1: x + w - 32, gap: 6 };
  const optionW = (options.x1 - options.x0 - 2 * options.gap) / 3;
  const option = (row: number, i: number) => ({ x: options.x0 + i * (optionW + options.gap), y: graphicsRowY(row) - 21, w: optionW, h: 42 });
  return {
    TITLE: { ...TITLE, x: x - 4, size: compact ? 122 : TITLE.size },
    START: { ...START, x, w: compact ? 400 : START.w },
    SETTINGS: { ...SETTINGS, x, w: compact ? 400 : SETTINGS.w },
    BACK: { ...BACK, x: x + 38 },
    PLAYERS_BACK: left(PLAYERS_BACK),
    PLAYERS_GO: left(PLAYERS_GO),
    COUNT_X: COUNT_X - 128 + x,
    MINUS: left(MINUS),
    PLUS: left(PLUS),
    SOUND,
    GRAPHICS,
    TRACK: { x0: x + 190, x1: x + w - 110 },
    SWITCH: { w: 84, h: 42, x: x + w - 124 },
    ROW_Y: (i: number) => SOUND.y + ROWS_TOP + i * ROW_H,
    ASPECT_ROW_Y: graphicsRowY(0),
    ASPECT: (i: number) => option(0, i),
    STATS_ROW_Y: graphicsRowY(1),
    STATS: (i: number) => option(1, i),
  };
}
