import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, nextChoice, optionsOf } from '../src/minigames/table-tennis/options.ts';

test('the settings default to the Biodome, medium shots, returning everything and hand tracking on', () => {
  assert.deepEqual(optionsOf({}), { scene: 'biodome', botShots: 'medium', botAlways: true, handTracking: true });
  assert.deepEqual(Object.fromEntries(OPTIONS.map((o) => [o.id, o.default])), { scene: 'biodome', botShots: 'medium', botReturns: 'everything', handTracking: 'on' });
  assert.equal(optionsOf({ handTracking: 'off' }).handTracking, false);
});

test('a chosen scene is kept, and an unknown one falls back to the Biodome', () => {
  assert.equal(optionsOf({ scene: 'debug' }).scene, 'debug');
  assert.equal(optionsOf({ scene: 'moon' }).scene, 'biodome');
  assert.equal(nextChoice('scene', 'biodome'), 'debug');
  assert.equal(nextChoice('scene', 'debug'), 'biodome');
});
