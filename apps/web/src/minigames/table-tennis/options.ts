/*
 * Table Tennis's settings, shown on its preview (the minigames' options) and stepped with keys
 * while playing. They load with the menus, so this stays free of the game's code: Game.tsx reads
 * them back with optionsOf.
 */

import type { AssistLevel } from './assist.ts';
import type { BotLevel } from './bot.ts';

export const ASSIST_CHOICES: readonly { value: AssistLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];
export const BOT_CHOICES: readonly { value: BotLevel; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

export const OPTIONS = [
  { id: 'assist', label: 'Aim assist', choices: ASSIST_CHOICES, default: 'max' },
  { id: 'botShots', label: 'Bot shots', choices: BOT_CHOICES, default: 'medium' },
  { id: 'botReturns', label: 'Bot returns', choices: [{ value: 'everything', label: 'Everything' }, { value: 'fair', label: 'Fair shots' }], default: 'everything' },
] as const;
export type OptionId = (typeof OPTIONS)[number]['id'];

export interface TableTennisOptions { assist: AssistLevel; botShots: BotLevel; botAlways: boolean; }

const pick = <T extends string>(choices: readonly { value: T }[], value: string | undefined, fallback: T): T =>
  choices.find((c) => c.value === value)?.value ?? fallback;

/** The settings from the minigame's chosen options (anything missing or unknown at its default). */
export function optionsOf(values: Readonly<Record<string, string>>): TableTennisOptions {
  return {
    assist: pick(ASSIST_CHOICES, values.assist, 'max'),
    botShots: pick(BOT_CHOICES, values.botShots, 'medium'),
    botAlways: values.botReturns !== 'fair',
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
