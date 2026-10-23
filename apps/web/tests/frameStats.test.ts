import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleWindow, count, fixed, gpuName, percentile, rate, summariseFrames } from '../src/stats/frameStats.ts';
import { DEFAULT_GRAPHICS } from '../src/menu/graphicsSettings.ts';

test('a sample window keeps only its last windowMs of samples', () => {
  const w = new SampleWindow(1000);
  w.add(0, 1);
  w.add(500, 2);
  w.add(1200, 3);
  assert.deepEqual(w.values, [2, 3]);
  w.prune(1600);
  assert.deepEqual(w.values, [3]);
  assert.deepEqual(w.times, [1200]);
});

test('frame summaries: rate from the mean interval, a nearest-rank p99 and the longest frame', () => {
  const intervals = [...Array<number>(99).fill(16), 50];
  const s = summariseFrames(intervals);
  assert.equal(s.fps.toFixed(2), (1000 / ((99 * 16 + 50) / 100)).toFixed(2));
  assert.equal(s.p99Ms, 16);
  assert.equal(s.maxMs, 50);
  assert.equal(percentile([...intervals, 60], 0.99), 50);
  assert.ok(Number.isNaN(summariseFrames([]).fps));
});

test('rates count arrivals over the time they span', () => {
  assert.equal(rate([0, 100, 200, 300]), 10);
  assert.equal(rate([5]), 0);
});

test('numbers print short, with "--" for none', () => {
  assert.equal(fixed(16.666, 1), '16.7');
  assert.equal(fixed(NaN), '--');
  assert.equal(fixed(null), '--');
  assert.equal(count(950), '950');
  assert.equal(count(1234), '1.2K');
  assert.equal(count(45_600), '46K');
  assert.equal(count(1_100_000), '1.1M');
});

test('GPU names lose their ANGLE wrapping', () => {
  assert.equal(gpuName('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)'), 'Apple M5 Pro (Metal)');
  assert.equal(gpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 4070 (D3D11)');
  assert.equal(gpuName('Apple GPU'), 'Apple GPU');
});

test('the stats overlay is off by default', () => {
  assert.equal(DEFAULT_GRAPHICS.stats, 'off');
});
