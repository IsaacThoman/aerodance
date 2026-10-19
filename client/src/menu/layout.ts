// Title menu layout in 1600x900 design units, shared with the browser flow test.
export const TITLE = { x: 124, y: 418, size: 156 };

// Main screen.
export const START = { x: 128, y: 482, w: 440, h: 104 };
export const SETTINGS = { x: 128, y: 602, w: 440, h: 104 };

// Submenus share a header row: back button + small caps heading.
export const BACK = { x: 166, y: 500, r: 30 };
export const ONE_PLAYER = { x: 128, y: 550, w: 530, h: 96 };
export const TWO_PLAYERS = { x: 128, y: 666, w: 530, h: 96 };

// Settings: one glass panel of rows (sound sliders and switches, then Graphics), with the
// Graphics choices (Auto / High / Low) side by side on the last row.
export const SETTINGS_PANEL = { x: 128, y: 540, w: 600, h: 334, rowH: 48, rows: 6 };
export const settingsRowY = (i: number) => SETTINGS_PANEL.y + 46 + i * SETTINGS_PANEL.rowH;
const CHOICES = { x0: SETTINGS_PANEL.x + 230, x1: SETTINGS_PANEL.x + SETTINGS_PANEL.w - 40, h: 42 };
export const GRAPHICS_CHOICES = [0, 1, 2].map((i) => {
  const w = (CHOICES.x1 - CHOICES.x0) / 3;
  return { x: CHOICES.x0 + i * w, y: settingsRowY(SETTINGS_PANEL.rows - 1) - CHOICES.h / 2, w, h: CHOICES.h };
});
