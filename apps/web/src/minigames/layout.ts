// Minigames layouts in 1600x900 (16:9) or 1200x900 (4:3) design units. The camera setup, the HUD's
// pause icon and the pause panel are the song game's (game/layout.ts): GAME_CALIBRATION_PREVIEW,
// GAME_PAUSE, GAME_RESUME, GAME_RESTART and GAME_QUIT click the same places in a minigame.
import type { Circle, Rect } from '../ui/draw.ts';

// Both screens of the list: back button and heading top left, where Song Select has them.
export const MG_BACK = { x: 166, y: 150, r: 30 };
/** Tiles per page of the list: three across, two down. */
export const MG_PER_PAGE = 6;

// The list: a grid of glass tiles, each the game's art over its title, blurb, players and best.
const GRID = { y: 232, cols: 3 };
const tileSize = (compact: boolean) => ({ w: compact ? 336 : 420, h: compact ? 268 : 288, gap: compact ? 22 : 32 });
const gridX = (width: number) => { const t = tileSize(width === 1200); return (width - (GRID.cols * t.w + (GRID.cols - 1) * t.gap)) / 2; };
/** The ith tile on the page in view. */
export const mgTile = (i: number, width = 1600): Rect => {
  const t = tileSize(width === 1200), col = i % GRID.cols, row = Math.floor(i / GRID.cols);
  return { x: gridX(width) + col * (t.w + t.gap), y: GRID.y + row * (t.h + t.gap), w: t.w, h: t.h };
};
/** Where a tile's art goes inside it. */
export const tileArt = (tile: Rect): Rect => ({ x: tile.x + 10, y: tile.y + 10, w: tile.w - 20, h: Math.round(tile.h * 0.56) });

/** The list, the preview, the how-to card, the HUD and the results, laid out for a display's width. */
export function minigameLayout(width = 1600) {
  const compact = width === 1200;
  const left = compact ? 72 : 128;
  const t = tileSize(compact);
  const gridBottom = GRID.y + 2 * t.h + t.gap;
  // The preview: the game's art in a glass panel on the right, its words on the left, and the
  // players dial over Play, bottom left like the players screen's.
  const art = compact ? { x: 616, y: 236, w: 512, h: 342 } : { x: 828, y: 236, w: 644, h: 430 };
  const play = { x: left, y: 726, w: 370, h: 92 };
  const dialY = 638;
  const countX = left + (compact ? 330 : 340);
  // The how-to card, centred, with Start at its foot.
  const howto = { x: (width - 880) / 2, y: 196, w: 880, h: 580 };
  const board = { x: (width - 800) / 2, y: 222, w: 800 };
  return {
    MG_BACK: { ...MG_BACK, x: compact ? 110 : MG_BACK.x },
    mgTile: (i: number) => mgTile(i, width),
    /** Page arrows, either side of the grid (only with more than a page of games). */
    MG_PAGE_PREV: { x: gridX(width) - (compact ? 34 : 56), y: GRID.y + (gridBottom - GRID.y) / 2, r: 30 } as Circle,
    MG_PAGE_NEXT: { x: width - gridX(width) + (compact ? 34 : 56), y: GRID.y + (gridBottom - GRID.y) / 2, r: 30 } as Circle,
    /** Under the grid: the page dots. */
    MG_PAGE_DOTS_Y: gridBottom + 30,
    MG_TEXT: { x: left, w: art.x - left - (compact ? 36 : 60) },
    MG_ART: art,
    MG_PLAY: play,
    MG_COUNT_X: countX,
    MG_MINUS: { x: countX - 104, y: dialY, r: 36 } as Circle,
    MG_PLUS: { x: countX + 104, y: dialY, r: 36 } as Circle,
    MG_HOWTO: howto,
    MG_HOWTO_START: { x: width / 2 - 190, y: howto.y + howto.h - 118, w: 380, h: 88 },
    /** The HUD's round timer, under the pause icon at the top centre. */
    MG_TIMER_Y: 104,
    /** Results: the scoreboard centred, then Play again and Minigames side by side under it. */
    MG_RESULTS_BOARD: board,
    mgResultsBoard: (players: number): Rect => ({ ...board, h: 150 + Math.max(0, players - 1) * 72 + (players > 1 ? 18 : 0) }),
    mgResultsRetry: (players: number): Rect => resultsButton(board, players, 0),
    mgResultsQuit: (players: number): Rect => resultsButton(board, players, 1),
  };
}

function resultsButton(board: { x: number; y: number; w: number }, players: number, i: number): Rect {
  const h = 150 + Math.max(0, players - 1) * 72 + (players > 1 ? 18 : 0), w = (board.w - 20) / 2;
  return { x: board.x + i * (w + 20), y: board.y + h + 24, w, h: 84 };
}
