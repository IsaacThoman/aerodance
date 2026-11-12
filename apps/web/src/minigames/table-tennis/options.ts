/*
 * Table Tennis's settings, shown on its preview (the minigames' options). They load with the
 * menus, so this stays free of the game's code (types only): Game.tsx reads them back with optionsOf.
 */

import type { BotLevel } from './bot.ts';
import type { Controls, Mode } from './round.ts';
import type { Side } from './arms.ts';
import { optionKey } from '../options.ts';

export const BOT_CHOICES: readonly { value: BotLevel; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];

/** What's played alone: a match against the robot, or Return Challenge (round.ts Mode). Two players always play a match. */
export const MODE_CHOICES: readonly { value: Mode; label: string }[] = [
  { value: 'match', label: 'Match' },
  { value: 'challenge', label: 'Return Challenge' },
];

/** How a player hits: Easy (the default, as Wii Sports Resort: a swing's timing) or Precise (the paddle where the hand puts it). */
export const CONTROL_CHOICES: readonly { value: Controls; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'precise', label: 'Precise' },
];

/**
 * Where the table stands: the Biodome (packages/arenas/biodome), or the plain room the game was
 * built in. Not a setting: the room is for development (?scene=debug).
 */
export type SceneId = 'biodome' | 'debug';
export const sceneParam = (search: string = globalThis.location?.search ?? ''): SceneId => (new URLSearchParams(search).get('scene') === 'debug' ? 'debug' : 'biodome');

export const OPTIONS = [
  { id: 'mode', label: 'Mode', choices: MODE_CHOICES, default: 'match', players: [1] },
  // The robot's level in a match: alone only (two players play each other). Easy to begin with,
  // as Wii Sports Resort's first opponents are.
  { id: 'opponent', label: 'Opponent', choices: BOT_CHOICES, default: 'easy', players: [1] },
  // Easy plays as Wii Sports Resort does, seen from behind each player's dancer: only the swing's
  // timing counts. Precise is first person, the paddle where the hand puts it.
  { id: 'controls', label: 'Controls', choices: CONTROL_CHOICES, default: 'easy' },
  // Each player's: the hand that holds their paddle (the other tosses the ball to serve).
  { id: 'paddleHand', label: 'Paddle hand', choices: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }], default: 'right', perPlayer: true },
  // The Hand Landmarker (index.ts tracking): the paddle's angle and a surer wrist, for tracking
  // time; off, the paddle follows the pose's own wrist and fingers. With two players it runs on
  // both paddle hands.
  { id: 'handTracking', label: 'Hand tracking', choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], default: 'on' },
] as const;
export type OptionId = (typeof OPTIONS)[number]['id'];

export interface TableTennisOptions {
  mode: Mode; opponent: BotLevel; controls: Controls; handTracking: boolean;
  /** Each player's paddle hand (four of them, by player). */
  paddleHands: Side[];
}

const pick = <T extends string>(choices: readonly { value: T }[], value: string | undefined, fallback: T): T =>
  choices.find((c) => c.value === value)?.value ?? fallback;

/** The settings from the minigame's chosen options (anything missing or unknown at its default). */
export function optionsOf(values: Readonly<Record<string, string>>): TableTennisOptions {
  return {
    mode: pick(MODE_CHOICES, values.mode, 'match'),
    opponent: pick(BOT_CHOICES, values.opponent, 'easy'),
    controls: pick(CONTROL_CHOICES, values.controls, 'easy'),
    handTracking: values.handTracking !== 'off',
    paddleHands: [0, 1, 2, 3].map((player): Side => (values[optionKey('paddleHand', player)] === 'left' ? 'left' : 'right')),
  };
}

/** A choice's label, for the HUD. */
export function choiceLabel(id: OptionId, value: string): string {
  const { choices } = OPTIONS.find((o) => o.id === id)!;
  return choices.find((c) => c.value === value)?.label ?? value;
}
