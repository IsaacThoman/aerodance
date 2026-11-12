import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, optionsOf, sceneParam } from '../src/minigames/table-tennis/options.ts';
import tableTennis from '../src/minigames/table-tennis/index.ts';

test('the settings default to a match against an Easy robot, Easy controls, right-handed paddles and hand tracking on', () => {
  assert.deepEqual(optionsOf({}), { mode: 'match', opponent: 'easy', controls: 'easy', handTracking: true, paddleHands: ['right', 'right', 'right', 'right'] });
  assert.deepEqual(Object.fromEntries(OPTIONS.map((o) => [o.id, o.default])), { mode: 'match', opponent: 'easy', controls: 'easy', paddleHand: 'right', handTracking: 'on' });
  assert.equal(optionsOf({ controls: 'precise' }).controls, 'precise');
  assert.equal(optionsOf({ handTracking: 'off' }).handTracking, false);
  assert.equal(optionsOf({ mode: 'challenge' }).mode, 'challenge');
  assert.equal(optionsOf({ mode: 'rally' }).mode, 'match', 'an unknown mode is a match');
  assert.equal(optionsOf({ opponent: 'hard' }).opponent, 'hard');
  // Each player's paddle hand, by their key.
  assert.deepEqual(optionsOf({ 'paddleHand.2': 'left' }).paddleHands, ['right', 'left', 'right', 'right']);
  // The mode and the robot are for one player: two always play a match against each other.
  for (const id of ['mode', 'opponent']) assert.deepEqual((OPTIONS.find((o) => o.id === id) as { players?: readonly number[] } | undefined)?.players, [1]);
});

test('the camera is asked for each player\'s paddle hand with two, both hands alone, and none with hand tracking off', () => {
  const track = tableTennis.tracking as (round: { playerCount: 1 | 2; options: Record<string, string> }) => string | null;
  assert.equal(track({ playerCount: 1, options: { 'paddleHand.1': 'left' } }), 'hands');
  assert.equal(track({ playerCount: 2, options: { 'paddleHand.2': 'left' } }), 'hands:right/left');
  assert.equal(track({ playerCount: 2, options: {} }), 'hands:right/right');
  assert.equal(track({ playerCount: 2, options: { handTracking: 'off' } }), 'world');
});

test('the plain room is for development, by ?scene=debug; otherwise the Biodome', () => {
  assert.equal(sceneParam('?scene=debug'), 'debug');
  assert.equal(sceneParam('?scene=moon'), 'biodome');
  assert.equal(sceneParam(''), 'biodome');
});
