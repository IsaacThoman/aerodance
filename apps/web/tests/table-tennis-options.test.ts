import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, nextChoice, optionsOf } from '../src/minigames/table-tennis/options.ts';
import tableTennis from '../src/minigames/table-tennis/index.ts';

test('the settings default to the Biodome, right-handed paddles, medium shots, returning everything and hand tracking on', () => {
  assert.deepEqual(optionsOf({}), { scene: 'biodome', botShots: 'medium', botAlways: true, handTracking: true, paddleHands: ['right', 'right', 'right', 'right'] });
  assert.deepEqual(Object.fromEntries(OPTIONS.map((o) => [o.id, o.default])), { scene: 'biodome', paddleHand: 'right', handTracking: 'on', botShots: 'medium', botReturns: 'everything' });
  assert.equal(optionsOf({ handTracking: 'off' }).handTracking, false);
  // Each player's paddle hand, by their key.
  assert.deepEqual(optionsOf({ 'paddleHand.2': 'left' }).paddleHands, ['right', 'left', 'right', 'right']);
});

test('the camera is asked for each player\'s paddle hand with two, both hands alone, and none with hand tracking off', () => {
  const track = tableTennis.tracking as (round: { playerCount: 1 | 2; options: Record<string, string> }) => string | null;
  assert.equal(track({ playerCount: 1, options: { 'paddleHand.1': 'left' } }), 'hands');
  assert.equal(track({ playerCount: 2, options: { 'paddleHand.2': 'left' } }), 'hands:right/left');
  assert.equal(track({ playerCount: 2, options: {} }), 'hands:right/right');
  assert.equal(track({ playerCount: 2, options: { handTracking: 'off' } }), 'world');
});

test('a chosen scene is kept, and an unknown one falls back to the Biodome', () => {
  assert.equal(optionsOf({ scene: 'debug' }).scene, 'debug');
  assert.equal(optionsOf({ scene: 'moon' }).scene, 'biodome');
  assert.equal(nextChoice('scene', 'biodome'), 'debug');
  assert.equal(nextChoice('scene', 'debug'), 'biodome');
});
