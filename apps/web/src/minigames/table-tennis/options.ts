/*
 * Table Tennis's settings, shown on its preview (the minigames' options) and stepped with keys
 * while playing. They load with the menus, so this stays free of the game's code: Game.tsx reads
 * them back with optionsOf.
 */

import type { BotLevel } from './bot.ts';

export const BOT_CHOICES: readonly { value: BotLevel; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

/** Where the table stands: the Biodome (packages/arenas/biodome), or the plain room the game was built in. */
export type SceneId = 'biodome' | 'debug';
export const SCENE_CHOICES: readonly { value: SceneId; label: string }[] = [
  { value: 'biodome', label: 'Biodome' },
  { value: 'debug', label: 'Debug' },
];

export const OPTIONS = [
  { id: 'scene', label: 'Scene', choices: SCENE_CHOICES, default: 'biodome' },
  // The robot's settings: alone only (two players play each other).
  { id: 'botShots', label: 'Bot shots', choices: BOT_CHOICES, default: 'medium', players: [1] },
  { id: 'botReturns', label: 'Bot returns', choices: [{ value: 'everything', label: 'Everything' }, { value: 'fair', label: 'Fair shots' }], default: 'everything', players: [1] },
  // The Hand Landmarker (index.ts tracking): the paddle's angle and a surer wrist, for tracking
  // time; off, the paddle follows the pose's own wrist and fingers. It runs for one player only.
  { id: 'handTracking', label: 'Hand tracking', choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], default: 'on', players: [1] },
] as const;
export type OptionId = (typeof OPTIONS)[number]['id'];

export interface TableTennisOptions { scene: SceneId; botShots: BotLevel; botAlways: boolean; handTracking: boolean; }

const pick = <T extends string>(choices: readonly { value: T }[], value: string | undefined, fallback: T): T =>
  choices.find((c) => c.value === value)?.value ?? fallback;

/** The settings from the minigame's chosen options (anything missing or unknown at its default). */
export function optionsOf(values: Readonly<Record<string, string>>): TableTennisOptions {
  return {
    scene: pick(SCENE_CHOICES, values.scene, 'biodome'),
    botShots: pick(BOT_CHOICES, values.botShots, 'medium'),
    botAlways: values.botReturns !== 'fair',
    handTracking: values.handTracking !== 'off',
  };
}

/** The choice after `value` in an option's list, wrapping round. */
export function nextChoice(id: OptionId, value: string): string {
  const { choices } = OPTIONS.find((o) => o.id === id)!;
  const i = choices.findIndex((c) => c.value === value);
  return choices[(i + 1) % choices.length].value;
}

/** A choice's label, for the HUD. */
export function choiceLabel(id: OptionId, value: string): string {
  const { choices } = OPTIONS.find((o) => o.id === id)!;
  return choices.find((c) => c.value === value)?.label ?? value;
}
