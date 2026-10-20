// Title menu layouts in 1600x900 (16:9) or 1200x900 (4:3) design units.
export const TITLE = { x: 124, y: 418, size: 156 };

// Main screen.
export const START = { x: 128, y: 482, w: 440, h: 104 };
export const SETTINGS = { x: 128, y: 602, w: 440, h: 104 };

// Submenus share a header row: back button + small caps heading.
export const BACK = { x: 166, y: 500, r: 30 };
export const ONE_PLAYER = { x: 128, y: 550, w: 530, h: 96 };
export const TWO_PLAYERS = { x: 128, y: 666, w: 530, h: 96 };

/** Compact menus leave a separate area for the dancers on the right. */
export function menuLayout(width = 1600) {
  const compact = width === 1200;
  const x = compact ? 72 : 128;
  const PANEL = { x, y: 540, w: compact ? 540 : 600, h: 294 };
  return {
    TITLE: { ...TITLE, x: x - 4, size: compact ? 122 : TITLE.size },
    START: { ...START, x, w: compact ? 400 : START.w },
    SETTINGS: { ...SETTINGS, x, w: compact ? 400 : SETTINGS.w },
    BACK: { ...BACK, x: x + 38 },
    ONE_PLAYER: { ...ONE_PLAYER, x, w: compact ? 480 : ONE_PLAYER.w },
    TWO_PLAYERS: { ...TWO_PLAYERS, x, w: compact ? 480 : TWO_PLAYERS.w },
    PANEL,
    TRACK: { x0: x + 190, x1: x + PANEL.w - 110 },
    SWITCH: { w: 84, h: 42, x: x + PANEL.w - 124 },
    ROW_Y: (i: number) => PANEL.y + 46 + i * 50,
  };
}
