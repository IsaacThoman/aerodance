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

/** The most option rows a game's preview has room for (definition.ts holds games to it). */
export const MG_MAX_OPTIONS = 4;
// An option row: as tall as a settings row (menu/layout.ts), with the glass panel's padding round
// the rows, and the room between the art and the rows for the line under the art.
const OPTION = { h: 52, gap: 8, pad: 12, arrow: 20, facts: 68 };

/**
 * The list, the preview, the how-to card, the HUD and the results, laid out for a display's width.
 * The preview makes room for the chosen game's option rows (`options` of them; the canvas reports
 * them as data-minigame-options).
 */
export function minigameLayout(width = 1600, options = 0) {
  const compact = width === 1200;
  const left = compact ? 72 : 128;
  const t = tileSize(compact);
  const gridBottom = GRID.y + 2 * t.h + t.gap;
  // The preview: the game's art in a glass panel on the right, its words on the left, and the
  // players dial over Play, bottom left like the players screen's.
  const fullArt = compact ? { x: 616, y: 236, w: 512, h: 342 } : { x: 828, y: 236, w: 644, h: 430 };
  const play = { x: left, y: 726, w: 370, h: 92 };
  const dialY = 638;
  const countX = left + (compact ? 330 : 340);
  // The game's options: a glass panel of rows under the art, its foot level with Play's, the art
  // giving up height (keeping its width) to make room. Each row is its label, then the choice
  // between a back and a forward arrow at the row's end.
  const n = Math.max(0, Math.min(MG_MAX_OPTIONS, Math.floor(options)));
  const panelH = 2 * OPTION.pad + n * OPTION.h + Math.max(0, n - 1) * OPTION.gap;
  const panel = { x: fullArt.x, y: play.y + play.h - panelH, w: fullArt.w, h: panelH };
  const art = n ? { ...fullArt, h: Math.min(fullArt.h, panel.y - OPTION.facts - fullArt.y) } : fullArt;
  const row = (i: number): Rect => ({ x: panel.x + OPTION.pad, y: panel.y + OPTION.pad + i * (OPTION.h + OPTION.gap), w: panel.w - 2 * OPTION.pad, h: OPTION.h });
  // The room between the arrows for the choice's name.
  const choiceW = compact ? 150 : 200;
  const next = (i: number): Circle => { const r = row(i); return { x: r.x + r.w - 8 - OPTION.arrow, y: r.y + r.h / 2, r: OPTION.arrow }; };
  const prev = (i: number): Circle => { const c = next(i); return { ...c, x: c.x - choiceW - 2 * OPTION.arrow - 12 }; };
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
    /** The preview's best score line: over the players dial, or, for a game with one player count (no dial), over Play. */
    MG_BEST_Y: dialY - 72,
    MG_BEST_Y_NO_DIAL: play.y - 46,
    /** The preview's option rows (with `options`): their panel, each row, and the arrows at its end. */
    MG_OPTIONS: n ? panel : null,
    mgOption: row,
    mgOptionPrev: prev,
    mgOptionNext: next,
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
