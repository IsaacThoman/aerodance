import type { ComponentType } from 'react';
import type { StageId } from '../../../../packages/stages/catalog.ts';
import type { BackgroundId } from '../backdrop/backgrounds.ts';
import type { IconDraw } from '../ui/draw.ts';
import type { DayPhase, SkyState } from './sky/sky.ts';

/*
 * The contract between the screensavers host and each screensaver (docs/screensavers.md). A
 * screensaver is a folder, apps/web/src/screensavers/<id>/, whose index.ts default-exports a
 * ScreensaverDefinition: the registry (registry.ts) finds it there, so adding one touches nothing
 * else. The definition is small and loads with the menus; the screensaver itself (`load`) is
 * fetched when it's shown.
 *
 * The host does everything around it: the list (Experiments → Screensavers), each one's preview
 * with its settings (its View and Scene, and the shared Time, Weather and Clock), going full
 * screen, the clock, captions, Shuffle, cutting between views under Auto, the veil between
 * screensavers, keeping the screen awake. The screensaver draws its scene and reads, each frame,
 * which view to show (ctx.view()) and the sky (ctx.sky(): the time of day and the weather).
 */

/**
 * What's behind it:
 *
 *   { background }   the skyline flight or a menu backdrop (packages/backdrops), drawn by the
 *                    menus' own Scene: the screensaver's component (if any) flies its camera
 *                    (useCameraViews in kit.ts) and may add things over it
 *   { stage }        a dance stage (packages/stages), its dancers looping the captured dance;
 *                    the component flies its camera the same way
 *   'custom'         its own world (SaverWorld in kit.ts), the menus' background standing down
 */
export type SaverScene = { background: BackgroundId } | { stage: StageId } | 'custom';

/** A choice on a setting row: the value the screensaver reads, and the words the row shows. */
export interface SaverChoice { value: string; label: string; }

export interface ScreensaverDefinition {
  /** The folder name: lower-case words joined by hyphens. */
  id: string;
  title: string;
  /** What it shows, in a line, under the title on its preview. */
  subtitle: string;
  /** Static monochrome icon for its list button, drawn in design units like the menu icons. */
  icon: IconDraw;
  /**
   * Its camera views, at least one (values: letters, digits, hyphens). With two or more the View
   * setting offers Auto first (the default), which cuts from one to the next every `cutEvery`
   * seconds; ctx.view() is always one of these, never 'auto'.
   */
  views: readonly SaverChoice[];
  /** Seconds a view holds under Auto (default 24). */
  cutEvery?: number;
  /**
   * Variations on what it shows (who plays, which stage), the first the default: the Scene
   * setting (its row labelled `scenarioLabel`). A change of scenario mounts the screensaver
   * afresh, behind the veil.
   */
  scenarios?: readonly SaverChoice[];
  scenarioLabel?: string;
  /** What's behind it (default 'custom'), or which, by scenario. */
  scene?: SaverScene | ((scenario: string) => SaverScene);
  /**
   * It draws the time of day and the weather from ctx.sky(): the Time and Weather settings are
   * for it (on others their rows are dimmed, though the clock still shows the live weather).
   */
  follows?: { time?: boolean; weather?: boolean };
  /**
   * It can show the time in its scene (a clock tower, a scoreboard, a screen): the Clock setting
   * offers In scene for it, and ctx.clock() says when to (the corner and large clocks stand aside).
   */
  sceneClock?: boolean;
  /** The times of day Shuffle shows it at, when it follows the real time (default any). */
  suits?: readonly DayPhase[];
  /** Listed in development builds only. */
  devOnly?: boolean;
  /** Where it sits on the list: lower first, then by title. */
  order?: number;
  /**
   * The screensaver itself, fetched when it's shown: () => import('./Saver.tsx'). A 'custom'
   * scene needs one; a background or stage one has one to fly the camera or add things.
   */
  load?: () => Promise<{ default: ScreensaverComponent }>;
}

/** The host's side of a screensaver, its `ctx` prop. */
export interface ScreensaverContext {
  readonly saver: ScreensaverDefinition;
  /** The scenario showing (fixed while it's mounted: a change mounts it again). */
  readonly scenario: string;
  /** The view to show now: the View setting, or Auto's current one. */
  view(): string;
  /**
   * The Clock setting, as it applies to this screensaver: 'scene' (show the time in the scene:
   * only for a `sceneClock` one), 'corner' or 'large' (the overlay draws those) or 'off'.
   */
  clock(): 'scene' | 'corner' | 'large' | 'off';
  /** Seconds on the screensaver's clock since this view began (a cut starts it at 0). */
  viewTime(): number;
  /** Seconds since the screensaver was mounted, on its own clock (it doesn't stop). */
  time(): number;
  /** The sky: the time of day, the sun and moon, and the weather, live or as chosen. */
  sky(): SkyState;
  /**
   * Full screen (true), or behind its preview, where the settings cover the left of the screen
   * (false): a screensaver may frame its views a little to the right then.
   */
  fullScreen(): boolean;
  /**
   * How far right to push the picture, as a share of its width (0 full screen, about 0.16 while
   * the list or a preview covers the left), eased: useCameraViews applies it to a background's or
   * stage's camera; a 'custom' world applies it to its own each frame (kit.ts shiftPicture).
   */
  shift(): number;
  /**
   * A 'custom' scene is built and has drawn: the veil can come down. (A background or stage
   * scene's readiness is the host's to know; the veil waits up to a few seconds for this.)
   */
  ready(): void;
  /** Reports the screensaver's own state on the canvas as data-sv-<key>, for play.ts and tests. */
  report(state: Record<string, string | number | boolean | null>): void;
}

/** A screensaver: rendered inside the game's <Canvas> while it shows. */
export type ScreensaverComponent = ComponentType<{ ctx: ScreensaverContext }>;
