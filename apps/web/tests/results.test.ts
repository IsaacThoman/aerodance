import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadersOf, winnerOf } from '../src/game/results.ts';

const scores = (...values: number[]) => values.map((score) => ({ score }));

test('the winner is the single top score; a tie names everyone tied for first', () => {
  assert.equal(winnerOf(scores(5)), null);
  assert.deepEqual(leadersOf(scores(5)), [0]);
  assert.equal(winnerOf(scores(3, 9, 1, 4)), 1);
  assert.deepEqual(leadersOf(scores(3, 9, 1, 4)), [1]);
  // Two of four tie: only they lead, the others are behind.
  assert.equal(winnerOf(scores(5, 9, 9, 1)), null);
  assert.deepEqual(leadersOf(scores(5, 9, 9, 1)), [1, 2]);
  assert.deepEqual(leadersOf(scores(7, 7, 7, 7)), [0, 1, 2, 3]);
});
