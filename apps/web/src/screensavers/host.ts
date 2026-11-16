import type { Fade } from '../stage/Veil.tsx';
import { clockFor, sceneFor } from './definition.ts';
import type { ClockChoice } from './definition.ts';
import { sky } from './sky/sky.ts';
import type { SkyState } from './sky/sky.ts';
import type { SaverScene, ScreensaverContext, ScreensaverDefinition } from './types.ts';

/*
 * The screensavers' host: which screensaver is showing and which is wanted next, the veil
 * between them, the view Auto is on, and Shuffle. ScreensaverView (the 3D side) steps it every
 * frame and mounts what it shows; ScreensaverSelect (the menus and the full-screen overlay) and
 * App (the menus' background or a dance stage behind it) read it.
 *
 * A change of screensaver: the veil comes up (FADE_UP), the new one is mounted, and once its scene
 * is ready (a 'custom' world says so with ctx.ready(); the menus' background and a stage are
 * watched for) and has drawn a few frames, the veil goes down (FADE_DOWN). Asking for nothing
 * (leaving Screensavers) does the same back to the menus' background, then calls `left`.
 */

const FADE_UP = 0.35;
const FADE_DOWN = 0.8;
// Frames a new screensaver draws behind the veil before it comes down.
const SETTLE_FRAMES = 4;
// The longest the veil waits for a screensaver to say it's ready.
const READY_TIMEOUT = 12;
const DEFAULT_CUT = 24;
/** How far right the picture is pushed while the list or a preview covers the left of the screen. */
export const PREVIEW_SHIFT = 0.16;

/** A screensaver and its scenario: what's showing, or wanted (with the View setting it comes on with, if not the one now). */
export interface SaverShow { saver: ScreensaverDefinition; scenario: string; view?: string; }

/** What's behind the screensaver showing, for App: the menus' background, a stage, or its own world. */
export type ShownScene = SaverScene | null;

export class ScreensaverHost {
  /** The screensavers in list order (registry.ts SCREENSAVERS), for Left/Right and Shuffle. */
  private readonly list: readonly ScreensaverDefinition[];
  constructor(list: readonly ScreensaverDefinition[]) { this.list = list; }
  /** What should be showing (null: nothing, the menus' background). */
  private target: SaverShow | null = null;
  /** What is mounted, and a key that changes each time something is. */
  shown: SaverShow | null = null;
  key = 0;
  /** The veil over the world (stage/Veil.tsx), up between screensavers. */
  readonly fade: Fade = { value: 0, settled: 0 };
  private phase: 'steady' | 'covering' | 'waiting' | 'revealing' = 'steady';
  private waited = 0;
  private saidReady = false;
  private left: (() => void) | null = null;
  // The screensaver's clock and its views.
  private clock = 0;
  private viewIndex = 0;
  private viewStart = 0;
  /** The View setting: a view, or 'auto'. */
  viewChoice = 'auto';
  /** The Clock setting. */
  clockChoice: ClockChoice = 'corner';
  /** Full screen (running), rather than behind a preview. */
  full = false;
  /** The list or a preview covers the left of the screen (ScreensaverSelect says), so the picture moves right. */
  covered = false;
  private shiftValue = 0;
  /** Shuffle: on, how long each one shows (seconds), and when the current one began. */
  shuffle = { on: false, every: 180, since: 0, order: [] as string[] };
  /** Cuts and changes the overlay announces (a caption): bumped on each. */
  announced = 0;
  private reports: Record<string, string> = {};
  /** Bumped whenever the screensaver's reports change. */
  reportsVersion = 0;
  private listeners = new Set<() => void>();

  /** Calls back when what's mounted changes (App and ScreensaverView re-render). */
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { for (const fn of this.listeners) fn(); }

  /**
   * Shows this screensaver (with this scenario), behind the veil if another is showing, and its
   * View setting (`view`) once it's on: the one going isn't cut to a view of the next one's.
   */
  show(saver: ScreensaverDefinition, scenario = saver.scenarios?.[0].value ?? '', view?: string) {
    if (this.target?.saver === saver && this.target.scenario === scenario && !this.left) {
      if (view !== undefined) this.chooseView(view);
      return;
    }
    this.left = null;
    this.target = { saver, scenario, view };
    if (this.phase === 'steady' || this.phase === 'revealing') this.phase = 'covering';
  }

  /** Back to nothing (the menus' background), then `done` once the veil is up. */
  leave(done: () => void) {
    this.full = false;
    this.shuffle.on = false;
    if (!this.shown && this.phase === 'steady') { done(); return; }
    this.target = null;
    this.left = done;
    this.phase = 'covering';
  }

  /** What's wanted (or showing): the preview's screensaver. */
  wanted(): SaverShow | null { return this.target; }

  /** The scene behind what's mounted, for App. */
  scene(): ShownScene { return this.shown ? sceneFor(this.shown.saver, this.shown.scenario) : null; }

  /** The veil is down and the screensaver showing is the one wanted. */
  settled() { return this.phase === 'steady' && this.target === this.shown; }

  /** The view showing: the View setting, or Auto's. */
  view(): string {
    const views = this.shown?.saver.views ?? [];
    if (!views.length) return '';
    if (this.viewChoice !== 'auto') return views.find((v) => v.value === this.viewChoice)?.value ?? views[0].value;
    return views[this.viewIndex % views.length].value;
  }

  /** Sets the View setting (for the one coming on, if another is on its way); a new view starts its clock. */
  chooseView(choice: string) {
    if (this.target && this.target !== this.shown) { this.target.view = choice; return; }
    if (choice === this.viewChoice) return;
    this.viewChoice = choice;
    this.viewStart = this.clock;
    this.announced++;
  }

  /** Steps Auto (or the View setting) to the next view, or back one. */
  stepView(dir: -1 | 1) {
    const views = this.shown?.saver.views ?? [];
    if (views.length < 2) return;
    const i = views.findIndex((v) => v.value === this.view());
    const next = views[(i + dir + views.length) % views.length].value;
    if (this.viewChoice === 'auto') { this.viewIndex = views.findIndex((v) => v.value === next); this.viewStart = this.clock; this.announced++; }
    else this.chooseView(next);
  }

  /** The context a screensaver is given. */
  context(show: SaverShow): ScreensaverContext {
    return {
      saver: show.saver,
      scenario: show.scenario,
      view: () => this.view(),
      viewTime: () => this.clock - this.viewStart,
      time: () => this.clock,
      // (The live weather is fetched for one that draws it.)
      sky: (): SkyState => sky.state({ fetch: !!show.saver.follows?.weather }),
      fullScreen: () => this.full,
      clock: () => clockFor(show.saver, this.clockChoice),
      shift: () => this.shiftValue,
      ready: () => { if (this.shown === show) this.saidReady = true; },
      report: (state) => {
        // (Not one on its way out, still drawing this frame.)
        if (this.shown !== show) return;
        for (const k in state) {
          const v = state[k], key = `sv${k[0].toUpperCase()}${k.slice(1)}`;
          if (v === null) { if (key in this.reports) { delete this.reports[key]; this.reportsVersion++; } continue; }
          const text = String(v);
          if (this.reports[key] !== text) { this.reports[key] = text; this.reportsVersion++; }
        }
      },
    };
  }

  /** The screensaver's own reports (data-sv-*), and clears ones it took back. */
  takeReports(): Record<string, string> { return this.reports; }

  /**
   * One frame: the veil, swaps, Auto's cuts and Shuffle. `sceneReady` says whether the scene
   * behind what's mounted (the menus' background, or a stage) is built and showing.
   */
  step(dt: number, sceneReady: boolean) {
    const f = this.fade;
    this.clock += dt;
    // (Eased, unless the veil hides the move.)
    const shiftTo = this.covered && !this.full ? PREVIEW_SHIFT : 0;
    this.shiftValue = f.value >= 1 ? shiftTo : this.shiftValue + (shiftTo - this.shiftValue) * (1 - Math.exp(-4 * dt));
    if (this.phase === 'covering') {
      f.value = Math.min(1, f.value + dt / FADE_UP);
      if (f.value >= 1) {
        this.shown = this.target;
        if (this.shown?.view !== undefined) this.viewChoice = this.shown.view;
        this.key++;
        this.clock = 0;
        this.viewIndex = 0;
        this.viewStart = 0;
        this.saidReady = false;
        this.waited = 0;
        this.reports = {};
        this.reportsVersion++;
        f.settled = 0;
        this.phase = 'waiting';
        this.shuffle.since = 0;
        this.announced++;
        this.changed();
        if (!this.target && this.left) { const done = this.left; this.left = null; done(); }
      }
      return;
    }
    if (this.phase === 'waiting') {
      // Another one wanted meanwhile: straight on to it (the veil is still up).
      if (this.target !== this.shown) { this.phase = 'covering'; return; }
      this.waited += dt;
      // A 'custom' world says it's ready; a background or stage screensaver is once its part is
      // mounted (ScreensaverView says so) and its scene is showing. Nothing is once the menus' background is back.
      const custom = this.shown && sceneFor(this.shown.saver, this.shown.scenario) === 'custom';
      const ready = (custom ? this.saidReady : this.shown ? this.saidReady && sceneReady : sceneReady) || this.waited > READY_TIMEOUT;
      if (ready && ++f.settled > SETTLE_FRAMES) this.phase = 'revealing';
      return;
    }
    if (this.phase === 'revealing') {
      f.value = Math.max(0, f.value - dt / FADE_DOWN);
      if (f.value <= 0) this.phase = 'steady';
    }
    if (this.target !== this.shown) { this.phase = 'covering'; return; }
    // Auto's cuts.
    const views = this.shown?.saver.views ?? [];
    // (Quietly: captions are for a new screensaver, or a view someone asked for.)
    if (this.viewChoice === 'auto' && views.length > 1 && this.clock - this.viewStart > (this.shown?.saver.cutEvery ?? DEFAULT_CUT)) {
      this.viewIndex = (this.viewIndex + 1) % views.length;
      this.viewStart = this.clock;
    }
    // Shuffle's turns, full screen.
    if (this.shuffle.on && this.full && this.phase === 'steady') {
      this.shuffle.since += dt;
      if (this.shuffle.since > this.shuffle.every) this.shuffleNext(1);
    }
  }

  /** Shuffle's next screensaver (or the one before), with a scenario of its own picking. */
  shuffleNext(dir: -1 | 1 = 1) {
    this.shuffle.since = 0;
    // (From the one on its way, so two quick presses go two along.)
    const pick = shufflePick(this.list, (this.target ?? this.shown)?.saver.id ?? null, dir, sky.state());
    if (pick) this.show(pick.saver, pick.scenario, 'auto');
  }

  /**
   * The next screensaver on the list (or the one before): Left and Right, full screen. `settings`
   * gives a screensaver's own Scene and View as they were last chosen (its first scenario and Auto
   * without). Under Shuffle, Shuffle's next.
   */
  stepSaver(dir: -1 | 1, settings?: (saver: ScreensaverDefinition) => { scenario?: string; view?: string }) {
    if (this.shuffle.on) { this.shuffleNext(dir); return; }
    const list = this.list;
    const i = list.findIndex((s) => s === (this.target ?? this.shown)?.saver);
    const next = list[(i + dir + list.length) % list.length];
    if (!next) return;
    const own = settings?.(next);
    this.show(next, own?.scenario ?? next.scenarios?.[0].value, own?.view ?? 'auto');
  }
}

// Shuffle goes through the list in turn from the one showing, passing over any that don't suit
// the time of day it's showing, each on a scenario chosen at random.
export function shufflePick(list: readonly ScreensaverDefinition[], current: string | null, dir: -1 | 1, state: Pick<SkyState, 'phase'>, random = Math.random): SaverShow | null {
  if (!list.length) return null;
  const start = Math.max(-1, list.findIndex((s) => s.id === current));
  for (let n = 1; n <= list.length; n++) {
    const saver = list[(((start + dir * n) % list.length) + list.length) % list.length];
    if (saver.suits && !saver.suits.includes(state.phase) && n < list.length) continue;
    const scenarios = saver.scenarios ?? [];
    const scenario = scenarios.length ? scenarios[Math.floor(random() * scenarios.length)].value : '';
    return { saver, scenario };
  }
  return null;
}
