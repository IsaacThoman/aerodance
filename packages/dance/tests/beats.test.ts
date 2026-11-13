import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSong, waveformPeaks } from '../beats.ts';

const RATE = 22050;
/** A drum loop: a kick on each bar's first beat, a hat on every beat, and a pad that changes every `partBars` bars. */
function song({ bpm, offsetMs, seconds, partBars = 8 }: { bpm: number; offsetMs: number; seconds: number; partBars?: number }): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE)), beat = 60 / bpm;
  let seed = 7;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 31 - 1; };
  for (let b = 0; offsetMs / 1000 + b * beat < seconds; b++) {
    const start = Math.round((offsetMs / 1000 + b * beat) * RATE), down = b % 4 === 0;
    for (let i = 0; i < RATE * 0.12 && start + i < pcm.length; i++) {
      const t = i / RATE, decay = Math.exp(-t * 40);
      pcm[start + i] += (down ? Math.sin(2 * Math.PI * 70 * t) * 0.9 : 0) * decay + noise() * 0.25 * Math.exp(-t * 90);
    }
  }
  // The pad: two different chords, swapped every partBars bars.
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE, bar = Math.floor((t - offsetMs / 1000) / (beat * 4)), part = Math.floor(Math.max(0, bar) / partBars) % 2;
    pcm[i] += part ? 0.12 * (Math.sin(2 * Math.PI * 880 * t) + Math.sin(2 * Math.PI * 1320 * t)) : 0.12 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t));
  }
  return pcm;
}

for (const [bpm, offsetMs] of [[120, 250], [128, 40], [96, 610], [174, 120]] as const) test(`finds ${bpm} bpm and its downbeat`, () => {
  const { grid } = analyzeSong(song({ bpm, offsetMs, seconds: 60 }), RATE);
  assert.ok(grid, 'a grid');
  assert.ok(Math.abs(grid.bpm - bpm) < 0.06, `bpm ${grid.bpm}`);
  const bar = 4 * 60000 / bpm, off = ((grid.beatOffsetMs - offsetMs) % bar + bar) % bar;
  assert.ok(Math.min(off, bar - off) < 25, `downbeat at ${grid.beatOffsetMs} ms, expected ${offsetMs} (mod a bar)`);
  assert.ok(grid.confidence > 0.3, `confidence ${grid.confidence}`);
});

test('finds where the song changes, on bar lines, and labels alike parts alike', () => {
  const bpm = 120, offsetMs = 250, { grid, sections } = analyzeSong(song({ bpm, offsetMs, seconds: 96, partBars: 8 }), RATE);
  assert.ok(grid);
  // 48 bars: A B A B A B, eight bars each.
  assert.equal(sections.length, 6, JSON.stringify(sections));
  sections.slice(1).forEach((s, i) => assert.ok(Math.abs(s.startMs - (offsetMs + (i + 1) * 8 * 2000)) < 60, `section ${i + 1} starts at ${s.startMs}`));
  assert.deepEqual(sections.map(s => s.label), ['Part A', 'Part B', 'Part A', 'Part B', 'Part A', 'Part B']);
  assert.equal(sections[0].startMs, 0);
  assert.equal(sections[5].endMs, 96000);
});

test('silence and noise have no grid', () => {
  assert.equal(analyzeSong(new Float32Array(RATE * 20), RATE).grid, null);
  assert.deepEqual([...waveformPeaks(Float32Array.from([0, 0.5, -1, 0.25]), 2)], [0.5, 1]);
});
