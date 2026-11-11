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

const SECONDS = 120, ROUNDS = 4;
const rate = (n: number, of: number) => (of ? n / of : 0);
const hitRate = (r: SimResult, i = 0) => rate(r.hits[i], r.came[i]);
/** Both players' hits over the balls that came at them. */
const hitRates = (r: SimResult) => rate(r.hits[0] + r.hits[1], r.came[0] + r.came[1]);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const perMinute = (n: number) => n / ((SECONDS * ROUNDS) / 60);
type Skill = keyof typeof SKILLS;
type Camera = keyof typeof TRACKING;
// Alone and together, at the game's own assist, seen as a webcam sees one player and two
// (TRACKING: measured on trackbench's ping-pong scenes).
const alone = (skill: Skill, camera: Camera = 'one') => simulateMany({ players: [{ skill: SKILLS[skill], tracking: TRACKING[camera] }], seconds: SECONDS }, ROUNDS);
const pair = (a: Skill, b: Skill = a, camera: Camera = 'two') =>
  simulateMany({ players: [{ skill: SKILLS[a], tracking: TRACKING[camera] }, { skill: SKILLS[b], tracking: TRACKING[camera] }], seconds: SECONDS }, ROUNDS);

test('a player who does nothing gets nothing', () => {
  // Seen exactly, exactly nothing.
  for (const skill of ['idle', 'still'] as const) {
    const two = pair(skill, skill, 'perfect');
    assert.equal(two.serves[0] + two.serves[1], 0, `${skill}: nobody serves`);
    assert.equal(two.hits[0] + two.hits[1], 0, `${skill}: nobody hits`);
    // Seen as a webcam sees two players, the tracker's wild poses serve a ball nobody swung at
    // once in a few minutes, and nobody hits it back.
    const seen = pair(skill);
    assert.ok(perMinute(seen.serves[0] + seen.serves[1]) < 1, `${skill}: ${seen.serves[0] + seen.serves[1]} serves`);
    assert.ok(seen.hits[0] + seen.hits[1] <= 1, `${skill}: ${seen.hits[0] + seen.hits[1]} hits`);
  }
  // Alone, hands by their sides, the robot is never asked to serve; a paddle held up and still
  // is served to, and returns next to nothing.
  assert.equal(alone('idle').came[0], 0);
  const held = alone('still');
  assert.ok(held.came[0] > 20);
  assert.ok(hitRate(held) < 0.04 && held.best <= 1, `held still: hits ${hitRate(held).toFixed(2)}, best rally ${held.best}`);
});

test('swinging at nothing hits now and then, and never keeps a rally going', () => {
  const one = alone('flail'), two = pair('flail');
  assert.ok(hitRate(one) < 0.45, `alone ${hitRate(one).toFixed(2)}`);
  // (Together the ball is paced for the other player, so a big swing at nothing finds it a little more often than alone it would.)
  assert.ok(hitRates(two) < 0.35, `together ${hitRates(two).toFixed(2)}`);
  assert.ok(Math.max(one.best, two.best) <= 7, `rallies of ${one.best} and ${two.best}`);
  assert.ok(mean(one.rallies) < 2 && mean(two.rallies) < 2);
});

test('a player who plays well nearly always hits, and their returns land', () => {
  const one = alone('good'), two = pair('good');
  assert.ok(hitRate(one) > 0.85, `alone, hits ${hitRate(one).toFixed(2)}`);
  assert.ok(rate(one.fair[0], one.hits[0]) > 0.85, `alone, fair ${rate(one.fair[0], one.hits[0]).toFixed(2)}`);
  assert.ok(hitRates(two) > 0.88, `together, hits ${hitRates(two).toFixed(2)}`);
  assert.ok(mean(two.rallies) > 5, `together, rallies of ${mean(two.rallies).toFixed(1)}`);
  // Seen exactly, they hardly miss.
  assert.ok(hitRates(pair('good', 'good', 'perfect')) > 0.95);
});

test('the better the player, the better they do', () => {
  const [novice, casual, good] = (['novice', 'casual', 'good'] as const).map((skill) => alone(skill));
  assert.ok(hitRate(novice) > 0.45, `a novice still hits half (${hitRate(novice).toFixed(2)})`);
  assert.ok(hitRate(novice) < hitRate(casual) - 0.08, `novice ${hitRate(novice).toFixed(2)} < casual ${hitRate(casual).toFixed(2)}`);
  assert.ok(hitRate(casual) < hitRate(good) + 0.03, `casual ${hitRate(casual).toFixed(2)}, good ${hitRate(good).toFixed(2)}`);
  assert.ok(mean(novice.rallies) < mean(casual.rallies) && mean(casual.rallies) < mean(good.rallies));
  const [a, b, c] = (['novice', 'casual', 'good'] as const).map((skill) => pair(skill));
  assert.ok(hitRates(a) < hitRates(b) - 0.08 && hitRates(b) < hitRates(c) + 0.03, `together ${hitRates(a).toFixed(2)}, ${hitRates(b).toFixed(2)}, ${hitRates(c).toFixed(2)}`);
  assert.ok(mean(a.rallies) < mean(b.rallies) && mean(b.rallies) < mean(c.rallies), `rallies ${mean(a.rallies).toFixed(1)} < ${mean(b.rallies).toFixed(1)} < ${mean(c.rallies).toFixed(1)}`);
});

test("two people have time to get to each other's serves and shots, at a slow laptop's camera too", () => {
  // People as recorded: they start for a ball a third of a second after it's hit and swing at
  // metres a second, which unpaced crossed the table before they'd moved (about one ball in ten
  // came back). At 20 poses a second, each 120 ms old:
  const [novice, casual, good] = (['novice', 'casual', 'good'] as const).map((skill) => pair(skill, skill, 'laptop'));
  assert.ok(hitRates(good) > 0.9, `good ${hitRates(good).toFixed(2)}`);
  assert.ok(hitRates(casual) > 0.82, `casual ${hitRates(casual).toFixed(2)}`);
  assert.ok(hitRates(novice) > 0.55, `novice ${hitRates(novice).toFixed(2)}`);
  assert.ok(mean(casual.rallies) > 4, `casual rallies of ${mean(casual.rallies).toFixed(1)}`);
});

test('the ball is soon back in play, and one player away does not stall the other', () => {
  // (A pretend server takes about a second to bring the paddle up and start their swing.)
  const two = pair('casual');
  assert.ok(median(two.waits) < 1.8, `median wait ${median(two.waits).toFixed(2)} s`);
  // One player away: the ball comes straight back to the one who's there.
  const lone = pair('good', 'idle');
  assert.ok(median(lone.waits) < 2.5, `alone at the table, median wait ${median(lone.waits).toFixed(2)} s`);
  assert.ok(perMinute(lone.serves[0]) > 10, `who serves again and again (${lone.serves[0]})`);
});
