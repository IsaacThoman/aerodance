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
export const PLAYERS_GO = { x: 128, y: 726, w: 370, h: 92 };
const DIAL_Y = Math.round((PLAYERS_BACK.y + PLAYERS_BACK.r + PLAYERS_GO.y) / 2);
export const COUNT_X = 426;
export const MINUS = { x: COUNT_X - 112, y: DIAL_Y, r: 40 };
export const PLUS = { x: COUNT_X + 112, y: DIAL_Y, r: 40 };
// The menu dancers' blue and purple, then green and pink for players three and four.
export const PLAYER_COLORS = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4'] as const;

// Imported songs listed a page at a time in Settings → Songs.
export const SONGS_PER_PAGE = 7;

// Settings rows: the first row's centre below its panel's top, the spacing, and the room under
// the last row.
const ROWS_TOP = 88;
const ROW_H = 48;
const ROWS_BOTTOM = 44;
// Graphics rows hold segmented switches, whose tracks are 50 tall, so they sit further apart.
const GRAPHICS_ROW_H = ROW_H + 10;

/**
 * Compact menus leave a separate area for the dancers on the right. Graphics has a Fullscreen
 * row only where the page can go fullscreen.
 */
export function menuLayout(width = 1600, fullscreen = true) {
  const compact = width === 1200;
  const x = compact ? 72 : 128;
  // Shapes from the left edge of the 16:9 layout, moved to this one's.
  const left = <T extends { x: number }>(shape: T): T => ({ ...shape, x: shape.x - 128 + x });
  // Each settings panel has its heading, then rows ROW_H apart.
  const w = compact ? 540 : 600;
  const rowsHeight = (rows: number, rowH = ROW_H) => ROWS_TOP + (rows - 1) * rowH + ROWS_BOTTOM;
  const SOUND = { x, y: 222, w, h: rowsHeight(5) };
  const GRAPHICS = { x, y: SOUND.y + SOUND.h + 24, w, h: rowsHeight(fullscreen ? 4 : 3, GRAPHICS_ROW_H) };
  const graphicsRowY = (row: number) => GRAPHICS.y + ROWS_TOP + row * GRAPHICS_ROW_H;
  // Right of each row's label: the Background picker (the one showing, between back and next
  // arrows), then three options side by side, Aspect ratio Auto / 4:3 / 16:9 and Stats Off /
  // Basic / Full. Then a Fullscreen switch like Sound's.
  const options = { x0: x + 240, x1: x + w - 32, gap: 6 };
  const optionW = (options.x1 - options.x0 - 2 * options.gap) / 3;
  const option = (row: number, i: number) => ({ x: options.x0 + i * (optionW + options.gap), y: graphicsRowY(row) - 21, w: optionW, h: 42 });
  const BACKGROUND = { x: options.x0, y: graphicsRowY(0) - 21, w: options.x1 - options.x0, h: 42 };
  // Songs (where the browser can import them): beside Sound and Graphics and as tall as both,
  // SONGS_PER_PAGE imported songs a page under the heading, then Import song at the bottom.
  const SONGS = { x: x + w + 24, y: SOUND.y, w: compact ? 1200 - x - (x + w + 24) : 520, h: GRAPHICS.y + GRAPHICS.h - SOUND.y };
  const songRow = (i: number) => ({ x: SONGS.x + 28, y: SONGS.y + 74 + i * 46, w: SONGS.w - 56, h: 44 });
  // Import song and Transfer songs side by side at the bottom (Transfer songs alone, across the
  // row, where there's no file picker: SONG_ACTIONS).
  const SONG_ACTIONS = { x: SONGS.x + 28, y: SONGS.y + SONGS.h - 72, w: SONGS.w - 56, h: 48 };
  const importW = 200;
  // Transfer songs: where the other device connects (left, where Sound and Graphics are), and
  // this device's songs to send (right, where Songs is), each song's send button at its row's end.
  const CONNECT = { x, y: SOUND.y, w, h: SONGS.h };
  const keyW = (CONNECT.w - 80 - 24) / 3;
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
    BACKGROUND_ROW_Y: graphicsRowY(0),
    /** The Background picker: pressing its left half goes back, its right half (or Enter) on. */
    BACKGROUND,
    BACKGROUND_PREV: { x: BACKGROUND.x + BACKGROUND.h / 2, y: BACKGROUND.y + BACKGROUND.h / 2, r: BACKGROUND.h / 2 - 4 },
    BACKGROUND_NEXT: { x: BACKGROUND.x + BACKGROUND.w - BACKGROUND.h / 2, y: BACKGROUND.y + BACKGROUND.h / 2, r: BACKGROUND.h / 2 - 4 },
    ASPECT_ROW_Y: graphicsRowY(1),
    ASPECT: (i: number) => option(1, i),
    STATS_ROW_Y: graphicsRowY(2),
    STATS: (i: number) => option(2, i),
    /** The Fullscreen row, which toggles from anywhere along it like Sound's switches. */
    FULLSCREEN: fullscreen ? { x: x + 16, y: graphicsRowY(3) - 24, w: w - 32, h: 48 } : null,
    SONGS,
    SONG_ROW: songRow,
    /** Each song's remove button, at its row's right end. */
    SONG_TRASH: (i: number) => { const row = songRow(i); return { x: row.x + row.w - 22, y: row.y + row.h / 2, r: 20 }; },
    /** Page arrows, right of the heading. */
    SONGS_UP: { x: SONGS.x + SONGS.w - 96, y: SONGS.y + 44, r: 20 },
    SONGS_DOWN: { x: SONGS.x + SONGS.w - 50, y: SONGS.y + 44, r: 20 },
    /** What the last import or removal did: two lines above Import song (the first line's middle). */
    SONGS_NOTE_Y: songRow(SONGS_PER_PAGE).y + 18,
    SONG_ACTIONS,
    SONG_IMPORT: { ...SONG_ACTIONS, w: importW },
    SONG_TRANSFER: { ...SONG_ACTIONS, x: SONG_ACTIONS.x + importW + 16, w: SONG_ACTIONS.w - importW - 16 },
    TRANSFER_CONNECT: CONNECT,
    /** The code or QR code's box, the code's digits typed so far, and the keypad (1-9, delete, 0, join). */
    TRANSFER_QR: { x: CONNECT.x + 40, y: CONNECT.y + 84, w: 236, h: 236 },
    TRANSFER_DIGITS: { x: CONNECT.x + 40, y: CONNECT.y + 84, w: CONNECT.w - 80, h: 72 },
    TRANSFER_KEY: (i: number) => ({ x: CONNECT.x + 40 + (i % 3) * (keyW + 12), y: CONNECT.y + 180 + Math.floor(i / 3) * 70, w: keyW, h: 58 }),
    /** A link at the bottom: enter a code instead, show this device's code, try again or disconnect. */
    TRANSFER_LINK: { x: CONNECT.x + 28, y: CONNECT.y + CONNECT.h - 72, w: CONNECT.w - 56, h: 48 },
  };
}
