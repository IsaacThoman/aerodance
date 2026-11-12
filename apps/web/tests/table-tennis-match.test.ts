import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHALLENGE, MATCH, award, challengeLevel, deadVerdict, deuce, judge, matchPointFor, newMatch, newShot, serverOf } from '../src/minigames/table-tennis/match.ts';
import type { Match } from '../src/minigames/table-tennis/match.ts';
import { newRig } from '../src/minigames/table-tennis/rig.ts';
import { Round } from '../src/minigames/table-tennis/round.ts';
import type { Play } from '../src/minigames/table-tennis/round.ts';

const FRAME = 1 / 60;
const at = (a: number, b: number): Match => ({ score: [a, b], first: 0, winner: null });

test('the serve changes every two points, and from 5-all every point', () => {
  const order: number[] = [];
  const m = newMatch(0);
  // Alternate points so it goes to deuce and on.
  for (let i = 0; i < 14; i++) { order.push(serverOf(m)); award(m, (i % 2) as 0 | 1); }
  assert.deepEqual(order, [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0]);
  assert.equal(m.winner, null, 'level all the way');
  assert.equal(serverOf(newMatch(1)), 1, 'the first server serves first');
});

test('first to 6 wins, by 2 clear', () => {
  const m = newMatch();
  for (let i = 0; i < MATCH.firstTo - 1; i++) award(m, 0);
  assert.equal(matchPointFor(m), 0);
  award(m, 0);
  assert.equal(m.winner, 0);
  award(m, 1);
  assert.deepEqual(m.score, [6, 0], 'nothing more once it is won');
  const close = at(5, 5);
  assert.ok(deuce(close));
  assert.equal(matchPointFor(close), null);
  award(close, 1);
  assert.equal(matchPointFor(close), 1);
  award(close, 0);
  assert.ok(deuce(close));
  award(close, 0); award(close, 0);
  assert.equal(close.winner, 0);
  assert.deepEqual(close.score, [8, 6]);
});

test("the referee: a shot that doesn't land loses the point, one that lands and isn't returned wins it", () => {
  const half = (end: 0 | 1) => end;
  // Out: past the far end without touching the table.
  assert.deepEqual(judge(newShot(0), { type: 'floor', half: half(1) }), { to: 1, reason: 'out' });
  // Into the net and down onto the hitter's own side, or the floor.
  const netted = newShot(0);
  assert.equal(judge(netted, { type: 'net', half: half(0) }), null);
  assert.deepEqual(judge(netted, { type: 'table', half: half(0) }), { to: 1, reason: 'net' });
  const dropped = newShot(0);
  judge(dropped, { type: 'net', half: half(0) });
  assert.deepEqual(judge(dropped, { type: 'floor', half: half(0) }), { to: 1, reason: 'net' });
  // Clipping the net and going over is fine.
  const cord = newShot(0);
  judge(cord, { type: 'net', half: half(0) });
  assert.equal(judge(cord, { type: 'table', half: half(1) }), null);
  assert.ok(cord.landed);
  // Onto its own half.
  assert.deepEqual(judge(newShot(1), { type: 'table', half: half(1) }), { to: 0, reason: 'own' });
  // Landed, then a second bounce or the floor: the hitter's.
  const landed = newShot(0);
  judge(landed, { type: 'table', half: half(1) });
  assert.deepEqual(judge({ ...landed }, { type: 'table', half: half(1) }), { to: 0, reason: 'double' });
  assert.deepEqual(judge({ ...landed }, { type: 'floor', half: half(1) }), { to: 0, reason: 'missed' });
  // The robot's serve bounces on its own half first, then must land on the player's.
  const serve = newShot(1, true);
  assert.equal(judge(serve, { type: 'table', half: half(1) }), null);
  assert.equal(judge(serve, { type: 'table', half: half(0) }), null);
  assert.deepEqual(judge(serve, { type: 'table', half: half(0) }), { to: 1, reason: 'double' });
  const short = newShot(1, true);
  judge(short, { type: 'table', half: half(1) });
  assert.deepEqual(judge(short, { type: 'table', half: half(1) }), { to: 0, reason: 'own' });
  // Gone dead with nothing decided.
  assert.deepEqual(deadVerdict(newShot(0)), { to: 1, reason: 'out' });
  assert.deepEqual(deadVerdict({ ...newShot(0), landed: true }), { to: 0, reason: 'missed' });
});

test("Return Challenge's serves step up a level every few returns, to a top level", () => {
  assert.equal(challengeLevel(0), 0);
  assert.equal(challengeLevel(CHALLENGE.every - 1), 0);
  assert.equal(challengeLevel(CHALLENGE.every), 1);
  assert.equal(challengeLevel(1000), CHALLENGE.levels - 1);
});

const PLAY: Play = { mode: 'match', forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium' };

/** A round alone against the robot, the player a stand-in (autoplay.ts) or nobody, until it's finished or `seconds` have gone. */
function solo(play: Partial<Play>, seconds: number, stand = true) {
  const rig = newRig(0, 'right');
  rig.autoplay = stand; rig.tracked = stand;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const round = new Round([rig], { ...PLAY, ...play }, rand);
  const reasons: string[] = [];
  let t = 0;
  for (; t < seconds && !round.finished(); t += FRAME) {
    const point = round.point;
    round.step(FRAME, t * 1000, true);
    if (round.point !== point) reasons.push(`${round.point!.to}:${round.point!.reason}`);
  }
  return { round, reasons, t };
}

test('a match against the robot is played to its end: the robot serves its own, makes mistakes now and then, and someone wins', () => {
  const { round, reasons, t } = solo({}, 400);
  assert.ok(round.finished(), `finished in ${t.toFixed(0)} s (${round.match.score.join('-')})`);
  assert.ok(round.match.winner !== null);
  const [a, b] = round.match.score;
  assert.ok(Math.max(a, b) >= MATCH.firstTo && Math.abs(a - b) >= MATCH.winBy);
  assert.equal(reasons.length, a + b, 'a point decided for every point scored');
  assert.ok(reasons.some((r) => r.startsWith('0:')), `the player won some points (${reasons.join(' ')})`);
});

test('nobody at the table: the robot wins its own serves, and the match waits for the player to serve theirs', () => {
  const { round } = solo({}, 30, false);
  assert.deepEqual(round.match.score, [0, 0], 'the player serves first, and never does');
  assert.equal(round.server(), 0);
  const robotFirst = new Round([newRig(0, 'right')], { ...PLAY }, () => 0.5);
  robotFirst.match.first = 1;
  for (let t = 0; t < 15; t += FRAME) robotFirst.step(FRAME, t * 1000, true);
  assert.deepEqual(robotFirst.match.score, [0, 2], 'two serves that got by');
  assert.equal(robotFirst.server(), 0);
});

test('Return Challenge: the robot serves and serves again, each return counts, and the first miss ends it', () => {
  const { round, t } = solo({ mode: 'challenge' }, 300);
  assert.ok(round.finished(), `the run ended (${round.challenge.returns} returns in ${t.toFixed(0)} s)`);
  assert.ok(round.challenge.returns >= 5, `a stand-in returns plenty (${round.challenge.returns})`);
  assert.equal(round.challenge.level, challengeLevel(round.challenge.returns));
  assert.equal(round.point!.to, 1, 'ended by a serve that got by');
  const nobody = solo({ mode: 'challenge' }, 20, false);
  assert.ok(nobody.round.finished() && nobody.round.challenge.returns === 0, 'nobody there: over at the first serve');
  assert.ok(nobody.t < 6, `over in ${nobody.t.toFixed(1)} s`);
});
