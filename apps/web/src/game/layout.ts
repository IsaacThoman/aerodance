// Song Select and game layouts in 1600x900 (16:9) or 1200x900 (4:3) design units.
import type { Rect } from '../ui/draw.ts';

// Both phases: back button + heading, top left (under the server HUD).
export const BACK = { x: 166, y: 150, r: 30 };

// List phase: songs down the left.
export const ROWS = { x: 128, y: 258, w: 560, h: 88, gap: 16, perPage: 4 };
export const rowRect = (i: number): Rect => ({ x: ROWS.x, y: ROWS.y + i * (ROWS.h + ROWS.gap), w: ROWS.w, h: ROWS.h });
export const PAGE_UP = { x: 730, y: ROWS.y + ROWS.h / 2, r: 28 };
export const PAGE_DOWN = { x: 730, y: ROWS.y + 3 * (ROWS.h + ROWS.gap) + ROWS.h / 2, r: 28 };
export const RETRY = { x: 128, y: 340, w: 300, h: 80 };

// Preview phase: title top left; anything worth saying (a stage or audio that couldn't
// load) sits bottom left.
export const PREVIEW_NOTE = { x: 128, y: 830 };

// Gameplay: each player's score in a top corner. Player 1 top left, player 2 top right; with
// three or four players, players 1 and 2 share the left corner and the rest the right, in the
// order they stand. Each score is centred at playerHudX: as far in from its side of the screen
// in a 4:3 display as in 16:9, with its top at PLAYER_HUD_TOP (judgements pop up above it).
export const PLAYER_HUD_TOP = 100;
// Centres as fractions of the 16:9 screen, by player count.
const PLAYER_HUD_X: Record<number, readonly number[]> = { 1: [0.1], 2: [0.1, 0.9], 3: [0.08, 0.22, 0.9], 4: [0.08, 0.22, 0.78, 0.92] };
export const playerHudX = (id: number, playerCount: number, width = 1600) => {
  const x = PLAYER_HUD_X[playerCount]?.[id] ?? 0.5;
  return x < 0.5 ? x * 1600 / width : 1 - (1 - x) * 1600 / width;
};

// Gameplay overlay (GameScreen.jsx).
// The mirror, top centre between the scores (narrow enough for four in 4:3): every player's
// character cutout on a dark glass, under a strip `top` tall along its top holding the pause icon.
export const GAME_MIRROR = { x: 656, y: 24, w: 288, h: 196, top: 34 };
export const GAME_PAUSE = { x: GAME_MIRROR.x + GAME_MIRROR.w / 2, y: GAME_MIRROR.y + 20, r: 30 };
export const GAME_READY_START = { x: 610, y: 690, w: 380, h: 96 };
export const GAME_READY_BACK = { x: 166, y: 150, r: 30 };
// Webcam calibration: one glass card with the setup preview (pressed to start the camera, or
// with No camera to continue without one) over the camera picker. The shared hold runs along
// the bottom of the preview.
export const GAME_CALIBRATION_PREVIEW = { x: 448, y: 284, w: 704, h: 396 };
export const GAME_CALIBRATION_CARD = { x: 404, y: 240, w: 792, h: 574 };
export const GAME_CALIBRATION_PROGRESS = { x: 488, y: 646, w: 624, h: 12 };
const CALIBRATION_PICKER = { x: 500, y: 720, w: 600, h: 58 };
export const GAME_CALIBRATION_CAMERA = {
  prev: { x: CALIBRATION_PICKER.x, y: CALIBRATION_PICKER.y, w: 80, h: CALIBRATION_PICKER.h },
  next: { x: CALIBRATION_PICKER.x + CALIBRATION_PICKER.w - 80, y: CALIBRATION_PICKER.y, w: 80, h: CALIBRATION_PICKER.h },
};
export const GAME_PAUSE_PANEL ={ x: 560, y: 250, w: 480, h: 420 };
export const GAME_RESUME = { x: 610, y: 340, w: 380, h: 84 };
export const GAME_RESTART = { x: 610, y: 444, w: 380, h: 84 };
export const GAME_QUIT = { x: 610, y: 548, w: 380, h: 84 };
export const GAME_PROGRESS = { x: 560, y: 852, w: 480, h: 14 };
// Results: the scoreboard down the left (the stage and its winner on the right). The winner
// large on top, `top` tall, then a `row` per other player and `pad` under them; a solo round
// has its judgements, `stats` tall, instead. Play again and Song select sit side by side under
// it, `gap` below and as wide together as the board. Its height, and so the buttons' place,
// follow the player count: resultsRetry(2) is the two-player Play again.
export const RESULTS_BOARD = { x: 64, y: 222, w: 600, top: 150, row: 72, pad: 18, stats: 104, gap: 20, buttonH: 80, buttonGap: 20 };
export const resultsBoard = (players: number): Rect => {
  const b = RESULTS_BOARD;
  return { x: b.x, y: b.y, w: b.w, h: b.top + (players <= 1 ? b.stats : (players - 1) * b.row + b.pad) };
};
const resultsButton = (players: number, i: number): Rect => {
  const b = RESULTS_BOARD;
  const board = resultsBoard(players);
  const w = (b.w - b.buttonGap) / 2;
  return { x: b.x + i * (w + b.buttonGap), y: board.y + board.h + b.gap, w, h: b.buttonH };
};
export const resultsRetry = (players: number) => resultsButton(players, 0);
export const resultsSongs = (players: number) => resultsButton(players, 1);
// Song Select preview: Dance! starts the song for real, bottom right.
export const DANCE = { x: 1172, y: 770, w: 300, h: 96 };

export function gameLayout(width = 1600) {
  const dx = (width - 1600) / 2;
  const compact = width === 1200;
  const centered = <T extends { x: number }>(shape: T): T => ({ ...shape, x: shape.x + dx });
  const rows = { ...ROWS, x: compact ? 72 : ROWS.x, w: compact ? 480 : ROWS.w };
  return {
    BACK: { ...BACK, x: compact ? 110 : BACK.x },
    ROWS: rows,
    rowRect: (i: number): Rect => ({ x: rows.x, y: rows.y + i * (rows.h + rows.gap), w: rows.w, h: rows.h }),
    PAGE_UP: { ...PAGE_UP, x: rows.x + rows.w + 42 },
    PAGE_DOWN: { ...PAGE_DOWN, x: rows.x + rows.w + 42 },
    RETRY: { ...RETRY, x: rows.x },
    PREVIEW_NOTE: { ...PREVIEW_NOTE, x: rows.x },
    DANCE: { ...DANCE, x: width - (compact ? 72 : 128) - DANCE.w },
    GAME_MIRROR: centered(GAME_MIRROR),
    GAME_PAUSE: centered(GAME_PAUSE),
    GAME_READY_START: centered(GAME_READY_START),
    GAME_READY_BACK: { ...GAME_READY_BACK, x: compact ? 110 : GAME_READY_BACK.x },
    GAME_CALIBRATION_PREVIEW: centered(GAME_CALIBRATION_PREVIEW),
    GAME_CALIBRATION_CARD: centered(GAME_CALIBRATION_CARD),
    GAME_CALIBRATION_PROGRESS: centered(GAME_CALIBRATION_PROGRESS),
    GAME_CALIBRATION_CAMERA: { prev: centered(GAME_CALIBRATION_CAMERA.prev), next: centered(GAME_CALIBRATION_CAMERA.next) },
    GAME_PAUSE_PANEL: centered(GAME_PAUSE_PANEL),
    GAME_RESUME: centered(GAME_RESUME),
    GAME_RESTART: centered(GAME_RESTART),
    GAME_QUIT: centered(GAME_QUIT),
    GAME_PROGRESS: centered(GAME_PROGRESS),
  };
}
