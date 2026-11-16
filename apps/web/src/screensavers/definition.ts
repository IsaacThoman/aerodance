import { OPTION_KEY } from '../minigames/definition.ts';
import type { MinigameOption } from '../minigames/types.ts';
import { TIME_CHOICES, WEATHER_CHOICES } from './sky/sky.ts';
import { DAY_PHASES } from './sky/sky.ts';
import type { SaverScene, ScreensaverDefinition } from './types.ts';

/*
 * Checks a screensaver's definition (types.ts) and puts the list in order, as the minigames'
 * definition.ts does for games; and the setting rows each one's preview shows: its own View and
 * Scene, then the Time, Weather and Clock every screensaver shares.
 */

export const SAVER_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The list's first button: every screensaver in turn. Not a folder. */
export const SHUFFLE_ID = 'shuffle';

/** What's wrong with a definition, if anything ('' when it's fine). */
export function saverProblem(def: unknown, folder?: string): string {
  if (typeof def !== 'object' || def === null) return 'its index.ts must default-export a ScreensaverDefinition';
  const d = def as Partial<ScreensaverDefinition>;
  if (typeof d.id !== 'string' || !SAVER_ID.test(d.id)) return 'id must be lower-case words joined by hyphens';
  if (d.id === SHUFFLE_ID) return `"${SHUFFLE_ID}" is the list's own button`;
  if (folder !== undefined && d.id !== folder) return `id "${d.id}" must match its folder "${folder}"`;
  if (typeof d.title !== 'string' || !d.title) return 'title is missing';
  if (typeof d.subtitle !== 'string') return 'subtitle is missing';
  if (typeof d.icon !== 'function') return 'icon must draw its icon';
  const views = choicesProblem('views', d.views, 1);
  if (views) return views;
  if (d.views!.some((v) => v.value === 'auto')) return "'auto' is the host's view (Auto): name the views themselves";
  if (d.scenarios !== undefined) { const p = choicesProblem('scenarios', d.scenarios, 2); if (p) return p; }
  if (d.cutEvery !== undefined && !(d.cutEvery >= 5)) return 'cutEvery is at least 5 seconds';
  if (d.suits !== undefined && (!Array.isArray(d.suits) || !d.suits.length || !d.suits.every((p) => DAY_PHASES.includes(p)))) return `suits lists some of ${DAY_PHASES.join(', ')}`;
  if (d.load !== undefined && typeof d.load !== 'function') return 'load must import the screensaver';
  if (d.sceneClock && typeof d.load !== 'function') return 'sceneClock needs load: the part that draws it';
  const scenes = (d.scenarios ?? [{ value: '' }]).map((s) => sceneFor(d as ScreensaverDefinition, s.value));
  if (scenes.some((s) => s === 'custom') && typeof d.load !== 'function') return "a 'custom' scene needs load: its world";
  return '';
}

function choicesProblem(name: string, choices: unknown, min: number): string {
  if (!Array.isArray(choices) || choices.length < min) return `${name} needs ${min === 1 ? 'at least one' : 'two or more'} choices`;
  const values = new Set<string>();
  for (const c of choices as Partial<{ value: string; label: string }>[]) {
    if (typeof c?.value !== 'string' || !OPTION_KEY.test(c.value)) return `${name}: each needs a value of letters, digits, hyphens or underscores`;
    if (typeof c.label !== 'string' || !c.label) return `${name}: "${c.value}" needs a label`;
    if (values.has(c.value)) return `${name} lists "${c.value}" twice`;
    values.add(c.value);
  }
  return '';
}

/** What's behind a screensaver with this scenario. */
export function sceneFor(saver: Pick<ScreensaverDefinition, 'scene'>, scenario: string): SaverScene {
  const scene = typeof saver.scene === 'function' ? saver.scene(scenario) : saver.scene;
  return scene ?? 'custom';
}

/** The screensavers to list: valid ones (a broken one is left out and said in the console), dev-only ones only in development, in order. */
export function listScreensavers(found: readonly { folder: string; def: unknown }[], { dev = false } = {}): ScreensaverDefinition[] {
  const savers: ScreensaverDefinition[] = [];
  for (const { folder, def } of found) {
    const problem = saverProblem(def, folder);
    if (problem) { console.error(`[screensavers] ${folder}: ${problem}`); continue; }
    const saver = def as ScreensaverDefinition;
    if (saver.devOnly && !dev) continue;
    savers.push(saver);
  }
  return savers.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
}

// ---- Settings ----

/**
 * The Clock setting: a chip in the corner (with the weather), a large clock, the time shown in the
 * scene itself (for a screensaver with a `sceneClock`; the corner chip on others), or none.
 */
export const CLOCK_CHOICES = [
  { value: 'corner', label: 'Corner' }, { value: 'large', label: 'Large' }, { value: 'scene', label: 'In scene' }, { value: 'off', label: 'Off' },
] as const;
export type ClockChoice = typeof CLOCK_CHOICES[number]['value'];

/** The Clock setting as it applies to a screensaver (Shuffle's for null): In scene is the corner chip on one without a clock of its own. */
export function clockFor(saver: Pick<ScreensaverDefinition, 'sceneClock'> | null, choice: ClockChoice): ClockChoice {
  return choice === 'scene' && saver && !saver.sceneClock ? 'corner' : choice;
}

/** The Clock row's choices for a screensaver: In scene only for one with a clock of its own (and Shuffle, for those). */
export const clockChoices = (saver: Pick<ScreensaverDefinition, 'sceneClock'> | null) =>
  CLOCK_CHOICES.filter((c) => c.value !== 'scene' || !saver || saver.sceneClock);
/** Shuffle's Change every setting, in minutes. */
export const SHUFFLE_CHOICES = [
  { value: '1', label: '1 minute' }, { value: '3', label: '3 minutes' }, { value: '5', label: '5 minutes' }, { value: '10', label: '10 minutes' },
] as const;

/** The settings every screensaver shares (one set for them all, kept in the browser). */
export const SHARED_OPTIONS: readonly MinigameOption[] = [
  { id: 'time', label: 'Time', choices: TIME_CHOICES, default: 'live' },
  { id: 'weather', label: 'Weather', choices: WEATHER_CHOICES, default: 'live' },
  { id: 'clock', label: 'Clock', choices: CLOCK_CHOICES, default: 'corner' },
];
/** Shuffle's own setting. */
export const SHUFFLE_OPTIONS: readonly MinigameOption[] = [
  { id: 'every', label: 'Change every', choices: SHUFFLE_CHOICES, default: '3' },
];

/** A screensaver's own rows: View (Auto first), when it has views to choose between, then its Scene. */
export function ownOptions(saver: Pick<ScreensaverDefinition, 'views' | 'scenarios' | 'scenarioLabel'>): MinigameOption[] {
  const rows: MinigameOption[] = [];
  // (One view: nothing to choose.)
  if (saver.views.length > 1) {
    const views = [{ value: 'auto', label: 'Auto' }, ...saver.views];
    rows.push({ id: 'view', label: 'View', choices: views, default: 'auto' });
  }
  if (saver.scenarios?.length) rows.push({ id: 'scenario', label: saver.scenarioLabel ?? 'Scene', choices: saver.scenarios, default: saver.scenarios[0].value });
  return rows;
}

/** Shared settings a screensaver doesn't draw (it doesn't follow the time or the weather): its preview dims their rows. */
export function unusedShared(saver: Pick<ScreensaverDefinition, 'follows'> | null, id: string): boolean {
  if (!saver) return false;
  if (id === 'time') return !saver.follows?.time;
  if (id === 'weather') return !saver.follows?.weather;
  return false;
}
