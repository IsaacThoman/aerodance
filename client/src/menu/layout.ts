// Title menu layout in 1600x900 design units, shared with the browser flow test.
export const TITLE = { x: 124, y: 418, size: 156 };
// On the players screen the title rises to make room for the dial and the characters.
export const PLAYERS_TITLE_Y = 210;

// Main screen.
export const START = { x: 128, y: 482, w: 440, h: 104 };
export const SETTINGS = { x: 128, y: 602, w: 440, h: 104 };

// Submenus share a header row: back button + small caps heading.
export const BACK = { x: 166, y: 500, r: 30 };

// Players screen: the header sits under the raised title, Let's dance sits bottom left, and
// a big-number dial (minus, count, plus) is centered vertically between them. The dancers on
// the puck (menu/MenuDancers.tsx) show the count.
export const MAX_PLAYERS = 4;
export const PLAYERS_BACK = { x: 166, y: 292, r: 30 };
// Wide enough for "Let's dance" with room to spare at the pill's rounded end.
export const PLAYERS_GO = { x: 128, y: 766, w: 370, h: 92 };
const DIAL_Y = Math.round((PLAYERS_BACK.y + PLAYERS_BACK.r + PLAYERS_GO.y) / 2);
export const COUNT_X = 426;
export const MINUS = { x: COUNT_X - 112, y: DIAL_Y, r: 40 };
export const PLUS = { x: COUNT_X + 112, y: DIAL_Y, r: 40 };
// The menu dancers' blue and purple, then green and pink for players three and four.
export const PLAYER_COLORS = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4'] as const;
