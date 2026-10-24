import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUNDS, BACKGROUND_SETTINGS, isBackgroundSetting, shuffleBackground } from '../src/backdrop/backgrounds.ts';
import { BACKDROP_METAS } from '../../../packages/backdrops/catalog.ts';

test('Settings steps through the skyline, every backdrop and Shuffle, once each', () => {
  const values = BACKGROUND_SETTINGS.map((b) => b.value);
  assert.deepEqual(values, ['skyline', ...BACKDROP_METAS.map((m) => m.id), 'shuffle']);
  assert.equal(new Set(BACKGROUND_SETTINGS.map((b) => b.label)).size, values.length);
});

test('saved settings keep only known backgrounds', () => {
  assert.ok(isBackgroundSetting('koi'));
  assert.ok(isBackgroundSetting('shuffle'));
  assert.ok(!isBackgroundSetting('lava'));
  assert.ok(!isBackgroundSetting(undefined));
});

test('Shuffle never picks the background it is leaving', () => {
  for (const { id } of BACKGROUNDS) {
    for (let i = 0; i < 50; i++) assert.notEqual(shuffleBackground(id), id);
  }
});
