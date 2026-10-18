// Title menu layout in 1600x900 design units, shared with the browser flow test.
export const TITLE = { x: 124, y: 418, size: 156 };
// On the players screen the title rises to make room for the dial and the characters.
export const PLAYERS_TITLE_Y = 300;

// Main screen.
export const START = { x: 128, y: 482, w: 440, h: 104 };
export const SETTINGS = { x: 128, y: 602, w: 440, h: 104 };

// Submenus share a header row: back button + small caps heading.
export const BACK = { x: 166, y: 500, r: 30 };

// Players screen: the header sits higher, a big-number dial (minus, count, plus) is centered
// over the row of player characters (menu/PlayerCrew.tsx), and Let's dance sits bottom left.
export const MAX_PLAYERS = 4;
export const PLAYERS_BACK = { x: 166, y: 378, r: 30 };
// One slot per player; a character's feet stand on its slot's bottom edge.
export const CREW = Array.from({ length: MAX_PLAYERS }, (_, i) => ({ x: 128 + i * 152, y: 540, w: 140, h: 220 }));
const CREW_MID = (CREW[0].x + CREW[MAX_PLAYERS - 1].x + CREW[MAX_PLAYERS - 1].w) / 2;
const DIAL_Y = 476;
export const COUNT_X = CREW_MID;
export const MINUS = { x: CREW_MID - 112, y: DIAL_Y, r: 40 };
export const PLUS = { x: CREW_MID + 112, y: DIAL_Y, r: 40 };
export const PLAYERS_GO = { x: 128, y: 786, w: 300, h: 92 };
// The menu dancers' blue and purple, then green and pink for players three and four.
export const PLAYER_COLORS = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4'] as const;
