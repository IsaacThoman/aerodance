import type { ComponentType } from 'react';
import type { PlayerCount, Pose, TrackCalibration } from '../../../../packages/pose/choreography.ts';
import type { StageId } from '../../../../packages/stages/catalog.ts';
import type { BackgroundId } from '../backdrop/backgrounds.ts';
import type { IconDraw, IconName, Rect } from '../ui/draw.ts';
import type { PlayerPose } from './pose/body.ts';
import type { GestureEvent } from './pose/gestures.ts';

/*
 * The contract between the minigames host and each game (docs/minigames.md). A game is a folder,
 * apps/web/src/minigames/<id>/, whose index.ts default-exports a MinigameDefinition: the
 * registry (registry.ts) finds it there, so adding one touches nothing else. The definition is
 * small and loads with the menus (its tile art is drawn on Minigames' list); the game itself
 * (`load`) is fetched when it's picked.
 *
 * The host runs everything around the game: the camera and its calibration, the how-to card,
 * the 3-2-1, pausing (Escape, the pause icon, a hidden tab, interruptions), the HUD's scores and
 * timer, the results and best scores. The game gets a MinigameContext (the `ctx` prop, or
 * useMinigame()) and draws inside the game's <Canvas>: its own overlay (useMinigameOverlay),
 * a 3D layer over the menu background, its own world, or things on a dance stage (scene.tsx).
 */

/**
 * Where a session is:
 *
 *   loading → calibrating (a live camera) → howto → countdown → playing ⇄ paused → finishing → results
 *
 * Replays skip calibrating; resuming counts down again; error is a game that wouldn't load or crashed.
 */
export type MinigamePhase = 'loading' | 'calibrating' | 'howto' | 'countdown' | 'playing' | 'paused' | 'finishing' | 'results' | 'error' | 'disposed';

/** What's behind a game. */
export type MinigameScene =
  /** Whatever the menus show (the player's chosen background), carrying on. */
  | 'menu'
  /** The skyline flight or one of the menu backdrops (packages/backdrops). */
  | { background: BackgroundId }
  /** A dance stage, with the game's component (its 3D things) inside the stage's scene. */
  | { stage: StageId }
  /** Nothing: the game draws its own world (MinigameWorld in scene.tsx) and the menu's stands down. */
  | 'custom';

/** One step of the how-to card: a picture and a line or two. */
export interface HowToStep {
  /** One of the drawing kit's icons (ui/draw.ts ICONS) or a drawing of its own, white on a blue disc. */
  icon?: IconName | IconDraw;
  text: string;
}

/** How a score reads, and which way is better. */
export interface ScoreFormat {
  /** 'higher' (default) or 'lower' (times, misses). */
  better?: 'higher' | 'lower';
  /** The score as text (default: a whole number with thousands separators). */
  format?: (score: number) => string;
  /** A word after it on the results and the list's best ('pops', 'm'). */
  unit?: string;
}

export interface MinigameDefinition {
  /** The folder name: lower-case words joined by hyphens. Best scores are saved under it. */
  id: string;
  title: string;
  /** One line on its tile. */
  blurb: string;
  /** A paragraph on its preview. */
  description: string;
  /** The player counts it plays with, e.g. [1, 2]. */
  players: readonly PlayerCount[];
  /** The how-to card before the countdown: two to four steps. */
  howTo: readonly HowToStep[];
  /**
   * Draws its art into rect (design units), clipped to it: its tile on the list, and larger on its
   * preview. time (seconds) is for gentle movement; keep it cheap, it can draw every frame.
   */
  art: (g: CanvasRenderingContext2D, rect: Rect, time: number) => void;
  /** The tile's glass behind the art, top and bottom colours (default a deep aero blue). */
  tint?: readonly [top: string, bottom: string];
  score?: ScoreFormat;
  /** A timed round's length: the HUD counts it down and the host ends the round. Without it the game calls finish(). */
  durationMs?: number;
  /** What's behind it (default 'menu'). */
  scene?: MinigameScene;
  /**
   * Calibrate only with everyone's whole body in view, feet too, as the songs do (games about
   * legs and feet). Otherwise the shoulders and hips are enough: players can stand close.
   */
  fullBody?: boolean;
  /**
   * The players play together, as a team: every player's score is the team's, and the results
   * show it as one score instead of naming a winner (or a tie).
   */
  coop?: boolean;
  /** The host's HUD: each player's score in the top corners, and the round's time left (both on by default). */
  hud?: { scores?: boolean; timer?: boolean };
  /** Listed in development builds only (the reference game). */
  devOnly?: boolean;
  /** Where it sits on the list: lower first, then by title. */
  order?: number;
  /** The game itself, fetched when it's picked: () => import('./Game.tsx'). */
  load: () => Promise<{ default: MinigameComponent }>;
}

/** How a round ended, when its scores alone don't say: a team won, or everyone played together. */
export interface MinigameOutcome {
  /** The results' headline, in place of "Player 2 wins!" or "It's a tie!". */
  headline?: string;
  /** The player whose colours the headline wears (gold without one). */
  player?: number;
  /** false keeps the round out of the best scores (a match's points aren't a score to beat). */
  best?: boolean;
  /** This round was played together, as a team (as `coop` says for a whole game): the results show one team score. */
  coop?: boolean;
  /** The round ran out of time on the game's own clock: "Time's up!" rather than "Finish!" (as a durationMs round's). */
  timeUp?: boolean;
}

/** What a game is given each frame (useMinigameFrame). */
export interface MinigameFrame {
  /** Seconds since the last frame (0 while not playing, so a game's motion stops with it). */
  dt: number;
  /** performance.now(). */
  now: number;
  phase: MinigamePhase;
  /** Milliseconds of play so far: 0 until the countdown ends, standing still while paused. */
  timeMs: number;
  players: readonly PlayerPose[];
  /** What the players did since the last frame (minigames/pose/gestures.ts), only while playing. */
  events: readonly GestureEvent[];
}

/** The host's side of a game: its players, its round and its score. */
export interface MinigameContext {
  readonly game: MinigameDefinition;
  readonly playerCount: PlayerCount;
  /** Each player's pose (minigames/pose/body.ts), updated as poses arrive. */
  readonly players: readonly PlayerPose[];
  phase(): MinigamePhase;
  /** Milliseconds of play so far (see MinigameFrame.timeMs). */
  timeMs(): number;
  /** Milliseconds left in a timed round (durationMs), or Infinity. */
  remainingMs(): number;
  scores(): readonly number[];
  setScore(player: number, score: number): void;
  addScore(player: number, points: number): void;
  /**
   * Plays this round as a team, or not, whatever the definition's `coop` says: for a game whose
   * players choose (together or versus) once it has started. The results follow it.
   */
  setCoop(coop: boolean): void;
  /** Ends the round (its results come up), with final scores if given, and how it ended if the scores don't say. */
  finish(scores?: readonly number[], outcome?: MinigameOutcome): void;
  /** The pose to draw a player's glass character with (smoothed for display), or null while they're missing. */
  livePose(player: number, now?: number): Pose | null;
  /** The calibration a player's character is drawn with. */
  calibration(player: number): TrackCalibration | null;
  /** Reports the game's own state on the canvas as data-mg-<key> (mgBubbles=3), for play.ts and tests. */
  report(state: Record<string, string | number | boolean | null>): void;
}

/** A game: rendered inside the game's <Canvas> for the whole session. */
export type MinigameComponent = ComponentType<{ ctx: MinigameContext }>;
