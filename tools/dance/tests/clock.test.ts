import test from 'node:test';
import assert from 'node:assert/strict';
import { SongClock } from '../studio/clock.ts';

test('the clock stops at the end of the song by itself, and pausing there keeps it there', async () => {
  const clock = new SongClock();
  clock.durationMs = 40;
  let heard = 0;
  clock.subscribe(() => { heard++; });
  await clock.play();
  await new Promise(resolve => setTimeout(resolve, 80));
  // Stopped on its own, with nothing reading the time (as when frames are slow to draw).
  assert.equal(clock.playing, false);
  assert.equal(clock.now(), 40);
  clock.pause();
  assert.equal(clock.now(), 40);
  assert.equal(heard, 2, 'play, then the stop at the end');
});
