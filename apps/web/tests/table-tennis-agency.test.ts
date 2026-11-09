import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS, TRACKING, simulateMany } from './helpers/tableTennisSim.ts';
import type { SimResult } from './helpers/tableTennisSim.ts';

/*
 * How much of Table Tennis is the player's doing (helpers/tableTennisSim.ts: pretend people at a
 * pretend webcam, through the game's own round; tools/table-tennis/agency.ts prints the whole
 * table). Someone doing nothing gets nothing, someone playing well nearly always hits, and the
 * better the player the better they do.
 */

const SECONDS = 90, ROUNDS = 3;
const rate = (n: number, of: number) => (of ? n / of : 0);
const hitRate = (r: SimResult, i = 0) => rate(r.hits[i], r.came[i]);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const alone = (skill: keyof typeof SKILLS, tracking: keyof typeof TRACKING = 'good') =>
  simulateMany({ players: [{ skill: SKILLS[skill], tracking: TRACKING[tracking] }], seconds: SECONDS }, ROUNDS);
const pair = (a: keyof typeof SKILLS, b: keyof typeof SKILLS = a, tracking: keyof typeof TRACKING = 'good') =>
  simulateMany({ players: [{ skill: SKILLS[a], tracking: TRACKING[tracking] }, { skill: SKILLS[b], tracking: TRACKING[tracking] }], seconds: SECONDS }, ROUNDS);

test('a player who does nothing gets nothing: no serves, no hits', () => {
  for (const skill of ['idle', 'still'] as const) {
    const two = pair(skill);
    assert.equal(two.serves[0] + two.serves[1], 0, `${skill}: nobody serves`);
    assert.equal(two.hits[0] + two.hits[1], 0, `${skill}: nobody hits`);
  }
  // Alone, hands by their sides, the robot is never asked to serve; a paddle held up and still
  // is served to, and returns nothing.
  assert.equal(alone('idle').came[0], 0);
  const held = alone('still');
  assert.ok(held.came[0] > 20);
  assert.equal(held.hits[0], 0);
});

test('swinging at nothing rarely hits, and never keeps a rally going', () => {
  const one = alone('flail'), two = pair('flail');
  assert.ok(hitRate(one) < 0.35, `alone ${hitRate(one).toFixed(2)}`);
  assert.ok(hitRate(two) < 0.35 && hitRate(two, 1) < 0.35, `together ${hitRate(two).toFixed(2)}, ${hitRate(two, 1).toFixed(2)}`);
  assert.ok(Math.max(one.best, two.best) <= 5, `rallies of ${one.best} and ${two.best}`);
});

test('a player who plays well nearly always hits, and their returns land', () => {
  const one = alone('good'), two = pair('good');
  assert.ok(hitRate(one) > 0.85, `alone, hits ${hitRate(one).toFixed(2)}`);
  assert.ok(rate(one.fair[0], one.hits[0]) > 0.85, `alone, fair ${rate(one.fair[0], one.hits[0]).toFixed(2)}`);
  assert.ok(hitRate(two) > 0.88, `together, hits ${hitRate(two).toFixed(2)}`);
  assert.ok(mean(two.rallies) > 6, `together, rallies of ${mean(two.rallies).toFixed(1)}`);
});

test('the better the player, the better they do', () => {
  const [novice, casual, good] = (['novice', 'casual', 'good'] as const).map((skill) => alone(skill));
  assert.ok(hitRate(novice) > 0.45, `a novice still hits half (${hitRate(novice).toFixed(2)})`);
  assert.ok(hitRate(novice) < hitRate(casual) - 0.08, `novice ${hitRate(novice).toFixed(2)} < casual ${hitRate(casual).toFixed(2)}`);
  assert.ok(hitRate(casual) < hitRate(good) + 0.03, `casual ${hitRate(casual).toFixed(2)}, good ${hitRate(good).toFixed(2)}`);
  assert.ok(mean(novice.rallies) < mean(casual.rallies) && mean(casual.rallies) < mean(good.rallies));
  const [a, b, c] = (['novice', 'casual', 'good'] as const).map((skill) => mean(pair(skill).rallies));
  assert.ok(a < b && b < c, `rallies ${a.toFixed(1)} < ${b.toFixed(1)} < ${c.toFixed(1)}`);
});

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

test('the ball is soon back in play, and one player away does not stall the other', () => {
  // (A pretend server takes about a second to bring the paddle up and start their swing.)
  const two = pair('casual');
  assert.ok(median(two.waits) < 1.8, `median wait ${median(two.waits).toFixed(2)} s`);
  // One player away: the ball comes straight back to the one who's there.
  const lone = pair('good', 'idle');
  assert.ok(median(lone.waits) < 2.5, `alone at the table, median wait ${median(lone.waits).toFixed(2)} s`);
  assert.ok(lone.serves[0] >= 45, `who serves again and again (${lone.serves[0]})`);
});

test('rough tracking costs a good player some hits, not the game', () => {
  const two = pair('good', 'good', 'rough');
  assert.ok(hitRate(two) > 0.7, `hits ${hitRate(two).toFixed(2)}`);
  // Wild poses can serve a ball nobody swung at, now and then: seldom, standing ready or not.
  for (const skill of ['idle', 'still'] as const) {
    const nobody = pair(skill, skill, 'rough');
    assert.ok((nobody.serves[0] + nobody.serves[1]) / ((SECONDS * ROUNDS) / 60) < 2, `${skill}: ${nobody.serves[0] + nobody.serves[1]} serves`);
  }
  // A paddle held still in the ball's way blocks some: that's a block, not a rally.
  const held = alone('still', 'rough');
  assert.ok(hitRate(held) < 0.3 && held.best <= 3, `held still: hits ${hitRate(held).toFixed(2)}, best rally ${held.best}`);
});
