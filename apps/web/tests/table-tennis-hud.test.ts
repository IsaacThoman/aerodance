import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYERS } from '../src/game/results.ts';
import { BANNER, GOLD, HudModel, PROMPT, RALLY, ROBOT, callsFor, faceOf, promptFor } from '../src/minigames/table-tennis/calls.ts';
import { award } from '../src/minigames/table-tennis/match.ts';
import type { PointReason } from '../src/minigames/table-tennis/match.ts';
import type { End } from '../src/minigames/table-tennis/rally.ts';
import { newRig } from '../src/minigames/table-tennis/rig.ts';
import { BEAT, Round } from '../src/minigames/table-tennis/round.ts';
import type { Play, PointWon } from '../src/minigames/table-tennis/round.ts';

/*
 * What Table Tennis's HUD says (calls.ts): each point's call in each view, the banners and when
 * they show, and the prompts until the players know them; and a whole match followed through it.
 */

const FRAME = 1 / 60;
const PLAY: Play = { mode: 'match', controls: 'precise', forgiving: false, serve: false, timeScale: 1, hitLag: 0, assist: 'normal', botLevel: 'medium' };
const solo = (play: Partial<Play> = {}) => new Round([newRig(0, 'right')], { ...PLAY, ...play }, () => 0.5);
/** A round alone against the robot with a stand-in (autoplay.ts) playing for the player, the robot's mistakes seeded. */
function standIn(play: Partial<Play> = {}) {
  const rig = newRig(0, 'right');
  rig.autoplay = true; rig.tracked = true;
  let seed = 7;
  return { rig, round: new Round([rig], { ...PLAY, ...play }, () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }) };
}
const pair = () => new Round([newRig(0, 'right'), newRig(1, 'left')], { ...PLAY }, () => 0.5);
const won = (to: End, reason: PointReason, t = 0): PointWon => ({ to, reason, by: reason === 'double' || reason === 'missed' ? to : to === 0 ? 1 : 0, at: { x: 0, y: 0.8, z: 0 }, t });
const texts = (round: Round, point: PointWon, levelUp = false) => callsFor(round, point, levelUp).map((call) => call.text);

test('a point\'s call says what lost it, the same to everyone, in the winner\'s colours', () => {
  const alone = solo();
  assert.deepEqual(callsFor(alone, won(0, 'out')), [{ text: 'OUT', face: faceOf(PLAYERS[0]) }], 'the robot\'s shot out: the player\'s point');
  assert.deepEqual(callsFor(alone, won(1, 'own')), [{ text: 'SHORT', face: faceOf(ROBOT) }], 'the player\'s onto their own half');
  assert.deepEqual(texts(alone, won(1, 'net')), ['NET']);
  const two = pair();
  assert.deepEqual(callsFor(two, won(1, 'out')), [{ text: 'OUT', face: faceOf(PLAYERS[1]) }, { text: 'OUT', face: faceOf(PLAYERS[1]) }]);
});

test('a shot that won the point is NICE! to its player and what happened to the other; a long rally\'s is a GREAT RALLY! to all', () => {
  const alone = solo();
  assert.deepEqual(callsFor(alone, won(0, 'missed')), [{ text: 'NICE!', face: faceOf(PLAYERS[0]) }]);
  assert.deepEqual(callsFor(alone, won(1, 'double')), [{ text: '2 BOUNCES', face: faceOf(ROBOT) }], 'alone, the robot\'s winner is what the player missed');
  assert.deepEqual(texts(alone, won(1, 'missed')), ['MISSED']);
  const two = pair();
  assert.deepEqual(texts(two, won(0, 'missed')), ['NICE!', 'MISSED'], 'each view its own');
  assert.deepEqual(texts(two, won(1, 'double')), ['2 BOUNCES', 'NICE!']);
  two.rally = RALLY.great;
  assert.deepEqual(callsFor(two, won(1, 'missed')), [{ text: 'GREAT RALLY!', face: GOLD }, { text: 'GREAT RALLY!', face: GOLD }]);
  two.rally = RALLY.great - 1;
  two.done = true;
  assert.deepEqual(callsFor(two, won(1, 'missed'))[1], { text: 'NICE!', face: GOLD }, 'the match\'s last shot is gold');
});

test('Return Challenge calls +1 a return, NICE! a new level, and how the run ended', () => {
  const run = solo({ mode: 'challenge' });
  assert.deepEqual(callsFor(run, won(0, 'return')), [{ text: '+1', face: faceOf(PLAYERS[0]) }]);
  assert.deepEqual(callsFor(run, won(0, 'return'), true), [{ text: 'NICE!', face: GOLD }]);
  assert.deepEqual(callsFor(run, won(1, 'missed')), [{ text: 'MISSED', face: faceOf(ROBOT) }]);
});

/** A point to `to` in a round played by hand: scored, the beat begun, and the HUD shown it. */
function score(round: Round, hud: HudModel, to: End, reason: PointReason = 'out') {
  round.point = won(to, reason, round.real);
  award(round.match, to);
  round.between = true;
  round.done = round.match.winner !== null;
  hud.observe(round);
}
/** Time passes (the players' seconds) and the HUD sees it. */
function wait(round: Round, hud: HudModel, seconds: number) { round.real += seconds; hud.observe(round); }
/** The beat over: the next serve set up. */
function nextServe(round: Round, hud: HudModel) { round.between = false; hud.observe(round); }

test('banners: whose point it was a moment after it, DEUCE and MATCH POINT as the next serve is set up, GAME! once it\'s won', () => {
  const round = solo(), hud = new HudModel('normal');
  round.real = 10;
  score(round, hud, 0);
  assert.equal(hud.calls.length, 1);
  assert.equal(hud.bump[0], 10, 'the player\'s score bumps');
  assert.equal(hud.banner(round), null, 'not over the call');
  wait(round, hud, BANNER.delay + 0.01);
  assert.equal(hud.banner(round)?.text, 'YOUR POINT');
  wait(round, hud, BEAT.point - BANNER.delay);
  assert.equal(hud.banner(round), null, 'gone by the next serve');
  nextServe(round, hud);
  assert.equal(hud.banner(round), null, 'nothing to say at 1-0');
  round.match.score = [4, 5];
  score(round, hud, 0);
  wait(round, hud, BANNER.delay + 0.01);
  assert.equal(hud.banner(round)?.text, 'YOUR POINT');
  wait(round, hud, 1);
  nextServe(round, hud);
  assert.equal(hud.banner(round)?.text, 'DEUCE', '5-5');
  wait(round, hud, BANNER.hold);
  assert.equal(hud.banner(round), null);
  score(round, hud, 1);
  wait(round, hud, BANNER.delay + 0.01);
  assert.equal(hud.banner(round)?.text, 'ROBOT\'S POINT');
  wait(round, hud, 1);
  nextServe(round, hud);
  const point = hud.banner(round);
  assert.equal(point?.text, 'MATCH POINT');
  assert.equal(point?.sub?.text, 'ROBOT', 'whose');
  score(round, hud, 0);
  wait(round, hud, 1);
  nextServe(round, hud);
  assert.equal(hud.banner(round)?.text, 'DEUCE', '6-6');
  score(round, hud, 0);
  wait(round, hud, 1);
  nextServe(round, hud);
  assert.equal(hud.banner(round)?.sub?.text, 'YOU');
  score(round, hud, 0);
  assert.equal(round.done, true);
  wait(round, hud, BANNER.delay + 0.01);
  assert.deepEqual([hud.banner(round)?.text, hud.banner(round)?.sub?.text], ['GAME!', 'YOU WIN']);
  wait(round, hud, 30);
  assert.equal(hud.banner(round)?.text, 'GAME!', 'until the results');
  assert.deepEqual(hud.report(round, 'playing'), { call: 'OUT', banner: 'GAME!' });
  assert.deepEqual(hud.report(round, 'finishing'), { call: 'OUT', banner: null }, 'only while it\'s shown');
});

test('two players: the point is named for its player, and the match point too', () => {
  const round = pair(), hud = new HudModel('normal');
  score(round, hud, 1, 'missed');
  assert.equal(hud.report(round, 'playing').call, 'MISSED|NICE!');
  wait(round, hud, BANNER.delay + 0.01);
  assert.equal(hud.banner(round)?.text, 'POINT — PLAYER 2');
  round.match.score = [4, 4];
  score(round, hud, 1);
  nextServe(round, hud);
  assert.deepEqual([hud.banner(round)?.text, hud.banner(round)?.sub?.text], ['MATCH POINT', 'PLAYER 2']);
});

test('the prompts: how to serve, then Swing!; whose serve it is; Return Challenge\'s', () => {
  const round = solo();
  assert.deepEqual(promptFor(round, 0), { text: 'Raise your left hand to toss the ball', icon: 'raise', mine: true }, 'the free hand tosses');
  round.tossAt = round.time;
  assert.equal(promptFor(round, 0)?.text, 'Swing!');
  round.match.first = 1;
  assert.deepEqual(promptFor(round, 0), { text: 'The robot serves', icon: null, mine: false });
  assert.equal(promptFor(pair(), 1)?.text, 'Player 1 serves');
  assert.equal(promptFor(solo({ mode: 'challenge' }), 0)?.text, 'Return the robot\'s serve');
  round.between = true;
  assert.equal(promptFor(round, 0), null, 'nothing between points');
});

test('a player is told how to serve until they\'ve served three times, and again if they stand at it; the robot\'s serves until they\'ve seen three', () => {
  /** Each serve of `end`'s in a round with a stand-in: whether the player was told, as the ball waited for it. */
  let clock = 0;
  const step = (round: Round) => { clock += FRAME; round.step(FRAME, clock * 1000, true); };
  const serves = (round: Round, hud: HudModel, end: End, count: number) => {
    const told: boolean[] = [];
    let waiting = false;
    for (const until = clock + 400; clock < until && told.length < count && !round.done;) {
      step(round);
      hud.observe(round);
      const now = round.holding() && round.server() === end;
      if (now && !waiting) told.push(hud.prompt(round, 0) !== null);
      waiting = now;
    }
    return told;
  };
  const { rig, round } = standIn(), hud = new HudModel('normal');
  const mine = serves(round, hud, 0, PROMPT.serves + 1);
  assert.deepEqual(mine, [true, true, true, false], 'told for the first three serves');
  // Standing at their serve: told again.
  rig.autoplay = false;
  for (let t = 0; t < PROMPT.idle - 0.1; t += FRAME) step(round);
  hud.observe(round);
  assert.equal(hud.prompt(round, 0), null);
  for (let t = 0; t < 0.2; t += FRAME) step(round);
  hud.observe(round);
  assert.equal(hud.prompt(round, 0)?.text, 'Raise your left hand to toss the ball');
  // The robot's serves (Return Challenge's, all of them), each seen once.
  const run = standIn({ mode: 'challenge' }), seen = new HudModel('normal');
  assert.deepEqual(serves(run.round, seen, 1, PROMPT.serves + 1), [true, true, true, false]);
  assert.equal(seen.seen[0], PROMPT.serves, 'each serve counted once (the robot\'s follow-through too)');
  assert.equal(seen.served[0], 0);
});

test('a whole match through the HUD: a call for every point, the scores bumping, and GAME! at the end', () => {
  const { round } = standIn(), hud = new HudModel('normal');
  let calls = 0, last = hud.calls.at(-1);
  const banners = new Set<string>();
  for (let t = 0; t < 600 && !round.finished(); t += FRAME) {
    round.step(FRAME, t * 1000, true);
    hud.observe(round);
    if (hud.calls.at(-1) !== last) { calls += 1; last = hud.calls.at(-1); }
    const banner = hud.banner(round);
    if (banner) banners.add(banner.text);
  }
  assert.ok(round.finished());
  const [a, b] = round.match.score;
  assert.equal(calls, a + b, 'a call for every point');
  assert.ok(hud.bump[0] > 0 && hud.bump[1] > 0, 'both scores went up');
  assert.ok(banners.has('YOUR POINT') && banners.has('ROBOT\'S POINT'), [...banners].join(', '));
  assert.equal(hud.banner(round)?.text, 'GAME!');
  assert.ok(banners.has('MATCH POINT'), 'someone had a match point');
});

test('the aim assist\'s new level is said', () => {
  const round = solo(), hud = new HudModel('normal');
  hud.observe(round);
  assert.equal(hud.toast, null);
  round.play.assist = 'high';
  round.real = 3;
  hud.observe(round);
  assert.deepEqual(hud.toast, { text: 'Aim assist: High', t: 3 });
});
