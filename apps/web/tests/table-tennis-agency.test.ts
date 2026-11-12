import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS, TRACKING, simulateMany } from './helpers/tableTennisSim.ts';
import type { SimResult } from './helpers/tableTennisSim.ts';
import type { Controls } from '../src/minigames/table-tennis/round.ts';

/*
 * How much of Table Tennis is the player's doing (helpers/tableTennisSim.ts: pretend people at a
 * pretend webcam, through the game's own round, a match after match or, alone, Return Challenge;
 * tools/table-tennis/agency.ts prints the whole table), with either controls: Easy (the default,
 * a swing's timing) and Precise (the paddle where the hand puts it, the aim assist helping).
 * Someone doing nothing gets nothing, someone flailing gets little, someone playing well nearly
 * always hits, and the better the player the better they do.
 */

const SECONDS = 120, ROUNDS = 4;
const BOTH: readonly Controls[] = ['easy', 'precise'];
const rate = (n: number, of: number) => (of ? n / of : 0);
const hitRate = (r: SimResult, i = 0) => rate(r.hits[i], r.came[i]);
/** Both players' hits over the balls that came at them. */
const hitRates = (r: SimResult) => rate(r.hits[0] + r.hits[1], r.came[0] + r.came[1]);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const wins = (r: SimResult, i = 0) => r.matches.filter((m) => m[i] > m[i === 0 ? 1 : 0]).length;
type Skill = keyof typeof SKILLS;
type Camera = keyof typeof TRACKING;
// Alone and together, seen as a webcam sees one player and two (TRACKING: measured on
// trackbench's ping-pong scenes).
const alone = (controls: Controls, skill: Skill, camera: Camera = 'one', seconds = SECONDS, rounds = ROUNDS) =>
  simulateMany({ players: [{ skill: SKILLS[skill], tracking: TRACKING[camera] }], seconds, controls }, rounds);
const challenge = (controls: Controls, skill: Skill, camera: Camera = 'one') =>
  simulateMany({ players: [{ skill: SKILLS[skill], tracking: TRACKING[camera] }], seconds: SECONDS, mode: 'challenge', controls }, ROUNDS);
const pair = (controls: Controls, a: Skill, b: Skill = a, camera: Camera = 'two') =>
  simulateMany({ players: [{ skill: SKILLS[a], tracking: TRACKING[camera] }, { skill: SKILLS[b], tracking: TRACKING[camera] }], seconds: SECONDS, controls }, ROUNDS);

for (const controls of BOTH) {
  test(`${controls}: a player who does nothing gets nothing`, () => {
    for (const skill of ['idle', 'still'] as const) {
      // Seen exactly, exactly nothing.
      const two = pair(controls, skill, skill, 'perfect');
      assert.equal(two.serves[0] + two.serves[1], 0, `${skill}: nobody serves`);
      assert.equal(two.hits[0] + two.hits[1], 0, `${skill}: nobody hits`);
      // Seen as a webcam sees two players: a serve needs the ball tossed (the free hand raised), so
      // the tracker's wild poses serve nothing, and nobody hits anything.
      const seen = pair(controls, skill);
      assert.equal(seen.serves[0] + seen.serves[1], 0, `${skill}: ${seen.serves[0] + seen.serves[1]} serves`);
      assert.ok(seen.hits[0] + seen.hits[1] <= 1, `${skill}: ${seen.hits[0] + seen.hits[1]} hits`);
      // In Return Challenge the robot serves: hands by their sides or a paddle held up and still,
      // they return next to nothing, and every run ends at its first serve.
      const run = challenge(controls, skill);
      assert.ok(run.came[0] > 20);
      assert.ok(hitRate(run) < 0.05 && Math.max(...run.runs) <= 1, `${skill}: hits ${hitRate(run).toFixed(2)}, best run ${Math.max(...run.runs)}`);
    }
    // Alone, the player serves a match's first point: doing nothing, they never do, and the match waits.
    assert.equal(alone(controls, 'idle').came[0], 0);
  });

  test(`${controls}: swinging at nothing hits now and then, and never keeps a rally going`, () => {
    const one = alone(controls, 'flail'), two = pair(controls, 'flail');
    assert.ok(hitRate(one) < 0.45, `alone ${hitRate(one).toFixed(2)}`);
    // (Together the ball is paced for the other player, so a big swing at nothing finds it a little more often than alone it would.)
    assert.ok(hitRates(two) < 0.35, `together ${hitRates(two).toFixed(2)}`);
    assert.ok(Math.max(one.best, two.best) <= 7, `rallies of ${one.best} and ${two.best}`);
    assert.ok(mean(one.rallies) < 2 && mean(two.rallies) < 2);
    assert.ok(mean(challenge(controls, 'flail').runs) < 1);
  });

  test(`${controls}: a player who plays well nearly always hits, and their returns land`, () => {
    const one = alone(controls, 'good'), two = pair(controls, 'good');
    assert.ok(hitRate(one) > 0.85, `alone, hits ${hitRate(one).toFixed(2)}`);
    assert.ok(rate(one.fair[0], one.hits[0]) > 0.85, `alone, fair ${rate(one.fair[0], one.hits[0]).toFixed(2)}`);
    assert.ok(hitRates(two) > 0.88, `together, hits ${hitRates(two).toFixed(2)}`);
    assert.ok(mean(two.rallies) > 5, `together, rallies of ${mean(two.rallies).toFixed(1)}`);
    // Seen exactly, they hardly miss.
    assert.ok(hitRates(pair(controls, 'good', 'good', 'perfect')) > 0.95);
  });

  test(`${controls}: the better the player, the better they do`, () => {
    const [novice, casual, good] = (['novice', 'casual', 'good'] as const).map((skill) => alone(controls, skill));
    // (Easy forgives a novice more: the gap's smaller there.)
    const gap = controls === 'easy' ? 0.03 : 0.08;
    assert.ok(hitRate(novice) > 0.45, `a novice still hits half (${hitRate(novice).toFixed(2)})`);
    assert.ok(hitRate(novice) < hitRate(casual) - gap, `novice ${hitRate(novice).toFixed(2)} < casual ${hitRate(casual).toFixed(2)}`);
    assert.ok(hitRate(casual) < hitRate(good) + 0.03, `casual ${hitRate(casual).toFixed(2)}, good ${hitRate(good).toFixed(2)}`);
    // (Against the robot a point's length is the robot's mistakes as much as theirs: casual and good players' are much the same.)
    assert.ok(mean(novice.rallies) < mean(casual.rallies) && mean(novice.rallies) < mean(good.rallies), `rallies ${mean(novice.rallies).toFixed(1)}, ${mean(casual.rallies).toFixed(1)}, ${mean(good.rallies).toFixed(1)}`);
    const [a, b, c] = (['novice', 'casual', 'good'] as const).map((skill) => pair(controls, skill));
    assert.ok(hitRates(a) < hitRates(b) - gap && hitRates(b) < hitRates(c) + 0.03, `together ${hitRates(a).toFixed(2)}, ${hitRates(b).toFixed(2)}, ${hitRates(c).toFixed(2)}`);
    assert.ok(mean(a.rallies) < mean(b.rallies) && mean(b.rallies) < mean(c.rallies), `rallies ${mean(a.rallies).toFixed(1)} < ${mean(b.rallies).toFixed(1)} < ${mean(c.rallies).toFixed(1)}`);
    const runs = (['novice', 'casual', 'good'] as const).map((skill) => mean(challenge(controls, skill).runs));
    assert.ok(runs[0] < runs[1] && runs[1] < runs[2] && runs[2] > 8, `Return Challenge runs ${runs.map((r) => r.toFixed(1)).join(' < ')}`);
  });

  test(`${controls}: two people have time to get to each other's serves and shots, at a slow laptop's camera too`, () => {
    // People as recorded: they start for a ball a third of a second after it's hit and swing at
    // metres a second, which unpaced crossed the table before they'd moved (about one ball in ten
    // came back). At 20 poses a second, each 120 ms old:
    const [novice, casual, good] = (['novice', 'casual', 'good'] as const).map((skill) => pair(controls, skill, skill, 'laptop'));
    assert.ok(hitRates(good) > 0.9, `good ${hitRates(good).toFixed(2)}`);
    assert.ok(hitRates(casual) > 0.82, `casual ${hitRates(casual).toFixed(2)}`);
    assert.ok(hitRates(novice) > 0.55, `novice ${hitRates(novice).toFixed(2)}`);
    assert.ok(mean(casual.rallies) > 4, `casual rallies of ${mean(casual.rallies).toFixed(1)}`);
  });

  test(`${controls}: between points the next serve soon comes, and matches are played to their end, the better player winning`, () => {
    // (A point's beat, then a pretend server takes about a second to toss the ball and swing.)
    const waits = pair(controls, 'casual').waits;
    assert.ok(median(waits) < 3.5, `median wait ${median(waits).toFixed(2)} s`);
    // Alone: a good player beats the robot at Normal more often than a novice does. (A good
    // player's points are long ones: a match of theirs takes a few minutes.)
    const good = alone(controls, 'good', 'one', 480, 2), novice = alone(controls, 'novice', 'one', 480, 2);
    assert.ok(good.matches.length >= 2 && novice.matches.length >= 2, `matches finished: ${good.matches.length}, ${novice.matches.length}`);
    assert.ok(wins(good) / good.matches.length > wins(novice) / novice.matches.length, `good wins ${wins(good)} of ${good.matches.length}, novice ${wins(novice)} of ${novice.matches.length}`);
    // Two: the better player wins.
    const mixed = simulateMany({ players: [{ skill: SKILLS.good, tracking: TRACKING.two }, { skill: SKILLS.novice, tracking: TRACKING.two }], seconds: 240, controls }, 2);
    assert.ok(mixed.matches.length >= 2 && wins(mixed, 0) > wins(mixed, 1), `good v novice: ${mixed.matches.map((m) => m.join('-')).join(' ')}`);
  });
}
