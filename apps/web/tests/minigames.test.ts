import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { Puppet, REALISM } from '../src/pose/puppet/Puppet.ts';
import { PlayerTracker } from '../../../packages/pose/browser/tracker.ts';
import type { PlayerCount } from '../../../packages/pose/choreography.ts';
import type { PoseRecordEvent } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { LivePoseRecord, PoseSource, PoseSourceEvent } from '../src/pose/PoseSource.ts';
import { COUNTDOWN_MS, FINISH_MS, MinigameSession, RAISE_START_MS } from '../src/minigames/MinigameSession.ts';
import { SETUP_TRACKING_REFRESH_MS } from '../src/game/GameSession.ts';
import { definitionProblem, formatScore, forPlayers, howToFor, listMinigames, playersLabel } from '../src/minigames/definition.ts';
import { minigameBest, recordMinigameBest } from '../src/minigames/bestScores.ts';
import { cameraArea, fromDesign, toDesign } from '../src/minigames/cameraArea.ts';
import { MG_MAX_OPTIONS, MG_PER_PAGE, minigameLayout, mgTile } from '../src/minigames/layout.ts';
import { boardRows } from '../src/minigames/resultsBoard.ts';
import { minigameOptions, optionKey, optionsText, playerOption, resolveOptions, saveMinigameOption, stepOption } from '../src/minigames/options.ts';
import type { MinigameContext, MinigameDefinition, MinigameOption } from '../src/minigames/types.ts';
import type { Circle, Rect } from '../src/ui/draw.ts';
import type { PoseDetail } from '../../../packages/pose/webcamRecord.ts';

const INPUT = { width: 640, height: 480, mirrored: false };
const game = (patch: Partial<MinigameDefinition> = {}): MinigameDefinition => ({
  id: 'test-game', title: 'Test Game', players: [1, 2], howTo: [{ text: 'Do it' }],
  icon: () => {}, load: async () => ({ default: () => null }), durationMs: 10000, ...patch,
});
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
const option = (patch: Partial<MinigameOption> = {}): MinigameOption => ({
  id: 'level', label: 'Opponent', choices: [{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }], default: 'medium', ...patch,
});
const OPTIONS = [option(), option({ id: 'hand', label: 'Paddle hand', choices: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }], default: 'right' })];

/**
 * A live camera made of puppets: the puppet's frames through the player tracker into records,
 * delivered to subscribers like a webcam's (sourceKind 'webcam'), on a fake clock.
 */
function puppetCamera(playerCount: PlayerCount) {
  const clock = { t: 10000 };
  const puppet = new Puppet({ now: () => clock.t, realism: REALISM.real });
  puppet.follow(playerCount);
  let tracker = new PlayerTracker(playerCount);
  const listeners = new Set<(e: PoseSourceEvent) => void>();
  let seq = 0;
  const source: PoseSource = {
    view: { status: 'connected', message: '', sourceKind: 'webcam', snapshot: null, configuring: false, model: 'lite' },
    subscribeRecords(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    resetTracking() { tracker = new PlayerTracker(playerCount); },
  };
  const run = (ms: number, each?: () => void) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t += 40;
      const found = puppet.detect(clock.t - 50);
      const record: LivePoseRecord = { type: 'pose', sessionId: 'puppet', seq: ++seq, playerCount, input: INPUT, poses: tracker.update(found.landmarks, INPUT, clock.t, found.looks) };
      const event: PoseRecordEvent<LivePoseRecord> = { record, receivedBrowserTimeMs: clock.t, captureBrowserTimeMs: clock.t, timing: { method: 'browser-frame-observation' } };
      for (const fn of listeners) fn(event);
      each?.();
    }
  };
  return { clock, puppet, source, run };
}

test('a stuck line-up retries, and each retry starts the players\' holds again', async () => {
  const cam = puppetCamera(2);
  const session = new MinigameSession({ game: game(), playerCount: 2, source: cam.source, now: () => cam.clock.t });
  await session.load();
  const step = (ms: number) => cam.run(ms, () => session.advance());
  // One player is out of the picture: the other holds still all along, but calibration waits.
  cam.puppet.leave(1);
  step(SETUP_TRACKING_REFRESH_MS * 2 + 200);
  assert.equal(session.phase(), 'calibrating');
  const hold = session.calibrationHold!.holds.find(h => h.startedAt !== null);
  assert.ok(hold && cam.clock.t - hold.startedAt! < SETUP_TRACKING_REFRESH_MS, 'the holding player started again at the last retry');
  assert.ok(hold.frames.length <= SETUP_TRACKING_REFRESH_MS / 40 + 1, 'so their samples don\'t pile up');
  // Back in the picture, everyone calibrates.
  cam.puppet.enter(1);
  step(3200);
  assert.equal(session.phase(), 'howto');
});

test('a round runs: calibration, the how-to card, raise to start, 3-2-1, play, pause, a timed finish and results', async () => {
  const cam = puppetCamera(2);
  const session = new MinigameSession({ game: game(), playerCount: 2, source: cam.source, now: () => cam.clock.t });
  const phases: string[] = [];
  session.onChange((s) => phases.push(s.phase()));
  await session.load();
  assert.equal(session.phase(), 'calibrating');
  assert.ok(session.component, 'the game loaded');
  const step = (ms: number) => cam.run(ms, () => session.advance());
  step(3200);
  assert.equal(session.phase(), 'howto', 'everyone held still');
  assert.ok(session.players.every((p) => p.calibrated && p.present));
  assert.ok(session.calibration(0) && session.livePose(1), 'the characters have calibrations and poses');
  // A hand held up starts the countdown.
  cam.puppet.pose(1, 'rightUp', { ms: 200 });
  step(400 + RAISE_START_MS);
  assert.equal(session.phase(), 'countdown');
  cam.puppet.pose(1, 'stand');
  step(COUNTDOWN_MS);
  assert.equal(session.phase(), 'playing');
  // (The countdown started part-way through the steps before, so a little more has been played.)
  step(2000);
  assert.ok(session.timeMs() >= 2000 && session.timeMs() < 2400, `played ${session.timeMs()}`);
  // Gestures reach the game a frame at a time, while playing.
  let claps = 0;
  cam.puppet.gesture(0, 'clap');
  cam.run(1200, () => { claps += session.advance().events.filter((e) => e.type === 'clap' && e.player === 0).length; });
  assert.equal(claps, 1);
  session.addScore(0, 3);
  session.setScore(1, 5);
  assert.deepEqual(session.scores(), [3, 5]);
  // Paused, the clock holds; resuming counts down again first.
  session.pause();
  const held = session.timeMs();
  step(1500);
  assert.equal(session.phase(), 'paused');
  assert.equal(session.timeMs(), held);
  session.resume();
  step(COUNTDOWN_MS - 100);
  assert.equal(session.phase(), 'countdown');
  assert.equal(session.timeMs(), held);
  step(200);
  assert.equal(session.phase(), 'playing');
  // The timed round ends itself, says so for a moment, then has its results.
  step(10000 - held + 100);
  assert.equal(session.phase(), 'finishing');
  assert.equal(session.remainingMs(), 0);
  session.addScore(1, 100);
  step(FINISH_MS + 100);
  assert.equal(session.phase(), 'results');
  assert.deepEqual(session.results, [3, 105]);
  session.setScore(0, 999);
  assert.deepEqual(session.results, [3, 105], 'results are final');
  assert.deepEqual(phases, ['calibrating', 'howto', 'countdown', 'playing', 'paused', 'countdown', 'playing', 'finishing', 'results']);
  session.dispose();
});

test('a game can finish its own round, report its state, and fail', async () => {
  const cam = puppetCamera(1);
  const session = new MinigameSession({ game: game({ durationMs: undefined }), playerCount: 1, source: cam.source, now: () => cam.clock.t });
  await session.load();
  cam.run(3200, () => session.advance());
  session.start();
  cam.run(COUNTDOWN_MS + 100, () => session.advance());
  assert.equal(session.remainingMs(), Infinity);
  session.report({ bubbles: 3, done: false, gone: null });
  assert.deepEqual(session.reported, { mgBubbles: '3', mgDone: 'false' });
  session.finish([42], { headline: 'TEAMWORK!', best: false, timeUp: true });
  cam.run(FINISH_MS + 100, () => session.advance());
  assert.deepEqual(session.results, [42]);
  assert.deepEqual(session.outcome, { headline: 'TEAMWORK!', best: false, timeUp: true }, 'how the game said it ended');
  session.fail('It broke.');
  assert.equal(session.phase(), 'error');
  assert.equal(session.error, 'It broke.');
  const broken = new MinigameSession({ game: game({ load: () => Promise.reject(Error('404')) }), playerCount: 1, source: cam.source });
  await broken.load();
  assert.equal(broken.phase(), 'error');
  assert.match(broken.error, /couldn't load\. 404/);
});

test('every game folder has a valid definition whose id is its folder', async () => {
  const dir = new URL('../src/minigames/', import.meta.url);
  const folders = readdirSync(dir).filter((name) => statSync(new URL(name, dir)).isDirectory() && name !== 'pose');
  assert.ok(folders.includes('table-tennis'));
  for (const folder of folders) {
    const def = (await import(new URL(`${folder}/index.ts`, dir).href) as { default: unknown }).default;
    assert.equal(definitionProblem(def, folder), '', folder);
  }
});

test('definitions are checked, listed in order, dev-only ones in development', () => {
  assert.equal(definitionProblem(game()), '');
  assert.match(definitionProblem(game({ id: 'Bad Id' })), /lower-case/);
  assert.match(definitionProblem(game(), 'other'), /match its folder/);
  assert.match(definitionProblem(game({ players: [] })), /players/);
  assert.match(definitionProblem(game({ howTo: [] })), /howTo/);
  assert.equal(definitionProblem(game({ tracking: 'world' })), '');
  assert.equal(definitionProblem(game({ tracking: () => 'hands' })), '');
  assert.match(definitionProblem(game({ tracking: 'feet' as unknown as 'hands' })), /tracking must be/);
  assert.match(definitionProblem(null), /default-export/);
  const errors: string[] = [];
  const error = console.error;
  console.error = (message: string) => errors.push(message);
  const found = [
    { folder: 'zebra', def: game({ id: 'zebra', title: 'Zebra' }) },
    { folder: 'apple', def: game({ id: 'apple', title: 'Apple' }) },
    { folder: 'first', def: game({ id: 'first', title: 'Zz first', order: 1 }) },
    { folder: 'dev', def: game({ id: 'dev', title: 'Dev', devOnly: true }) },
    { folder: 'broken', def: { id: 'broken' } },
  ];
  try {
    assert.deepEqual(listMinigames(found).map((g) => g.id), ['first', 'apple', 'zebra']);
    assert.deepEqual(listMinigames(found, { dev: true }).map((g) => g.id), ['first', 'apple', 'dev', 'zebra']);
  } finally { console.error = error; }
  assert.ok(errors.some((e) => e.includes('broken')));
  assert.equal(playersLabel([1]), '1 player');
  assert.equal(playersLabel([2, 1, 3]), '1–3 players');
  assert.equal(playersLabel([2]), '2 players');
  assert.equal(playersLabel([2, 4]), '2 or 4 players');
  assert.equal(formatScore(game({ score: { unit: 'pops' } }), 1234.4, { unit: true }), '1,234 pops');
  assert.equal(formatScore(game({ score: { format: (n) => `${(n / 1000).toFixed(2)} s` } }), 1530), '1.53 s');
});

test('best scores are kept per game and player count, either way round', () => {
  const storage = memoryStorage();
  assert.deepEqual(recordMinigameBest('pop', 2, [0, 0], 'higher', storage), { previous: null, best: null, isNewBest: false });
  const first = recordMinigameBest('pop', 2, [3, 7], 'higher', storage);
  assert.equal(first.isNewBest, true);
  assert.equal(first.best?.score, 7);
  assert.equal(recordMinigameBest('pop', 2, [6, 5], 'higher', storage).isNewBest, false);
  assert.equal(minigameBest('pop', 2, storage)?.score, 7);
  assert.equal(minigameBest('pop', 1, storage), null);
  // Times: lower is better, and the best is the quickest.
  assert.equal(recordMinigameBest('react', 1, [420], 'lower', storage).isNewBest, true);
  assert.equal(recordMinigameBest('react', 1, [500], 'lower', storage).isNewBest, false);
  const quicker = recordMinigameBest('react', 1, [310], 'lower', storage);
  assert.equal(quicker.isNewBest, true);
  assert.equal(quicker.previous?.score, 420);
  storage.setItem('aerodance-minigame-bests', '{"pop|2p":{"score":"nope"}}');
  assert.equal(minigameBest('pop', 2, storage), null, 'damaged entries are ignored');
});

test('the camera picture fits the screen, and points map both ways', () => {
  assert.deepEqual(cameraArea(1600, 900, 4 / 3, 'cover'), { x: 0, y: -150, w: 1600, h: 1200 });
  assert.deepEqual(cameraArea(1600, 900, 4 / 3, 'contain'), { x: 200, y: 0, w: 1200, h: 900 });
  assert.deepEqual(cameraArea(1200, 900), { x: 0, y: 0, w: 1200, h: 900 });
  const area = cameraArea(1600, 900);
  assert.deepEqual(toDesign({ x: 0.5, y: 0.5 }, area), { x: 800, y: 450 });
  assert.deepEqual(fromDesign(toDesign({ x: 0.2, y: 0.9 }, area), area), { x: 0.2, y: 0.9 });
});

test('the list and its page controls stay on the left, clear of the menu dancers', () => {
  for (const width of [1600, 1200]) {
    const l = minigameLayout(width);
    const tiles = Array.from({ length: MG_PER_PAGE }, (_, i) => l.mgTile(i));
    assert.deepEqual(tiles[0], mgTile(0, width));
    assert.ok(tiles.every((t) => t.x >= 0 && t.x + t.w <= width && t.y > l.MG_BACK.y + l.MG_BACK.r && t.y + t.h <= 900 - 40), `${width}`);
    assert.ok(tiles.every((t) => t.x + t.w <= width / 2), 'the right half stays free for dancers');
    assert.ok(tiles[1].y >= tiles[0].y + tiles[0].h, 'rows do not overlap');
    for (const c of [l.MG_PAGE_PREV, l.MG_PAGE_NEXT]) {
      assert.ok(c.y - c.r > tiles.at(-1)!.y + tiles.at(-1)!.h, 'arrows below the tiles');
      assert.ok(c.x - c.r >= 0 && c.x + c.r <= width / 2 && c.y + c.r < 900, 'arrows in the left half');
    }
    assert.ok(l.MG_PAGE_DOTS_X > l.MG_PAGE_PREV.x + l.MG_PAGE_PREV.r && l.MG_PAGE_DOTS_X < l.MG_PAGE_NEXT.x - l.MG_PAGE_NEXT.r);
    assert.ok(l.MG_MINUS.x - l.MG_MINUS.r > l.MG_TEXT.x + 150, 'the dial clears its label');
  }
});

test('the results board: the players in finishing order, a team as one, and a solo player\'s opponent under them, its buttons below it on screen', () => {
  const solo = game({ players: [1] });
  assert.deepEqual(boardRows(solo, [4]), [{ name: 'Your score', score: 4, player: 0 }]);
  const robot = { name: 'Robot', score: 6 };
  assert.deepEqual(boardRows(solo, [4], { headline: 'THE ROBOT WINS', opponent: robot }), [{ name: 'Your score', score: 4, player: 0 }, { name: 'Robot', score: 6, player: null }]);
  assert.deepEqual(boardRows(game(), [3, 5], { opponent: robot }).map((row) => row.name), ['Player 2', 'Player 1'], 'only a solo player has an opponent');
  assert.deepEqual(boardRows(game({ coop: true }), [3, 5]), [{ name: 'Your team', score: 5, player: 0 }]);
  assert.deepEqual(boardRows(game({ score: { better: 'lower' } }), [9, 4, 7]).map((row) => row.player), [1, 2, 0]);
  for (const width of [1600, 1200]) {
    const l = minigameLayout(width);
    for (let rows = 1; rows <= 5; rows++) {
      const board = l.mgResultsBoard(rows), retry = l.mgResultsRetry(rows), quit = l.mgResultsQuit(rows);
      assert.ok(retry.y >= board.y + board.h && quit.y === retry.y, `${width}, ${rows} rows: the buttons under the board`);
      assert.ok(retry.y + retry.h <= 900 - 24 && board.x >= 0 && board.x + board.w <= width, `${width}, ${rows} rows: on screen`);
    }
  }
});

test('options are checked: their ids, labels, choices and defaults, and only as many as the preview has rows for', () => {
  assert.equal(definitionProblem(game({ options: OPTIONS })), '');
  assert.equal(definitionProblem(game({ options: [] })), '');
  const problem = (...options: unknown[]) => definitionProblem(game({ options: options as MinigameOption[] }));
  assert.match(problem(option(), option()), /"level" is listed twice/);
  assert.match(problem(option({ id: 'bot level' })), /id of letters/);
  assert.match(problem(option({ label: '' })), /needs a label/);
  assert.match(problem(option({ choices: [{ value: 'only', label: 'Only' }], default: 'only' })), /two or more choices/);
  assert.match(problem(option({ choices: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Again' }], default: 'a' })), /offers "a" twice/);
  assert.match(problem(option({ choices: [{ value: 'a|b', label: 'A' }, { value: 'c', label: 'C' }], default: 'c' })), /value of letters/);
  assert.match(problem(option({ choices: [{ value: 'a', label: '' }, { value: 'c', label: 'C' }], default: 'c' })), /choice "a" needs a label/);
  assert.match(problem(option({ default: 'impossible' })), /default must be one of its choices/);
  assert.match(problem(null), /id of letters/);
  assert.match(problem(...Array.from({ length: MG_MAX_OPTIONS + 1 }, (_, i) => option({ id: `o${i}` }))), new RegExp(`at most ${MG_MAX_OPTIONS}`));
  assert.match(definitionProblem({ ...game(), options: 'level' }), new RegExp(`at most ${MG_MAX_OPTIONS}`));
  // A game with broken options is left off the list, like any broken definition.
  const errors: string[] = [];
  const error = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    assert.deepEqual(listMinigames([{ folder: 'odd', def: game({ id: 'odd', options: [option({ default: 'nope' })] }) }, { folder: 'fine', def: game({ id: 'fine', options: OPTIONS }) }]).map((g) => g.id), ['fine']);
  } finally { console.error = error; }
  assert.ok(errors.some((e) => e.includes('odd') && e.includes('default')));
});

test('how-to steps and options can be for some player counts only, of the ones the game plays with', () => {
  const steps = [{ text: 'Alone' , players: [1] as const }, { text: 'Together', players: [2] as const }, { text: 'Always' }];
  assert.equal(definitionProblem(game({ howTo: steps })), '');
  assert.deepEqual(howToFor(game({ howTo: steps }), 1).map((s) => s.text), ['Alone', 'Always']);
  assert.deepEqual(howToFor(game({ howTo: steps }), 2).map((s) => s.text), ['Together', 'Always']);
  // Every count the game plays with needs one to four steps.
  assert.match(definitionProblem(game({ howTo: [{ text: 'Alone', players: [1] }] })), /howTo needs one to four steps with 2 players/);
  assert.match(definitionProblem(game({ howTo: Array.from({ length: 5 }, (_, i) => ({ text: `Step ${i}`, players: [2] as const })) })), /with 1 player\b/);
  assert.equal(definitionProblem(game({ howTo: [{ text: 'A', players: [1] }, ...Array.from({ length: 4 }, (_, i) => ({ text: `Step ${i}`, players: [2] as const }))] })), '');
  assert.match(definitionProblem(game({ howTo: [{ text: 'Four', players: [4] }, { text: 'Any' }] })), /player counts the game plays with/);
  // An option for some counts.
  assert.equal(definitionProblem(game({ options: [option({ players: [1] })] })), '');
  assert.match(definitionProblem(game({ options: [option({ players: [3] })] })), /"level": its players must be some of the counts/);
  assert.match(definitionProblem(game({ options: [option({ players: [] })] })), /"level": its players/);
  assert.ok(forPlayers(option({ players: [1] }), 1));
  assert.ok(!forPlayers(option({ players: [1] }), 2));
  assert.ok(forPlayers(option(), 2));
});

test('a per-player option has a value for each player, kept, stepped and saved by its key', () => {
  const hand = option({ id: 'hand', label: 'Paddle hand', choices: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }], default: 'right', perPlayer: true });
  const g = game({ options: [option(), hand] });
  assert.equal(definitionProblem(g), '');
  assert.match(definitionProblem(game({ options: [{ ...hand, perPlayer: 'yes' as unknown as boolean }] })), /perPlayer/);
  assert.equal(optionKey('hand', 1), 'hand.2', 'keys number players from 1, as the screen does');
  const values = resolveOptions(g, { 'hand.2': 'left', 'hand.3': 'sideways', hand: 'left' });
  assert.deepEqual(values, { level: 'medium', 'hand.1': 'right', 'hand.2': 'left', 'hand.3': 'right', 'hand.4': 'right' });
  assert.equal(playerOption(g, values, 'hand', 1), 'left');
  assert.equal(playerOption(g, values, 'hand', 0), 'right');
  assert.equal(playerOption(g, values, 'level', 3), 'medium', 'a shared option is everyone\'s');
  assert.equal(stepOption(g, values, 'hand.1', 1), 'left');
  assert.equal(stepOption(g, values, 'hand', 1), null, 'a per-player option is stepped by a player\'s key');
  const storage = memoryStorage();
  saveMinigameOption(g, 'hand.2', 'left', storage);
  saveMinigameOption(g, 'hand.9', 'left', storage);
  assert.deepEqual(minigameOptions(g, storage), { level: 'medium', 'hand.1': 'right', 'hand.2': 'left', 'hand.3': 'right', 'hand.4': 'right' });
  assert.equal(optionsText({ 'hand.2': 'left' }), 'hand.2=left');
});

test('a game\'s options are remembered per game, anything unknown back at its default', () => {
  const storage = memoryStorage();
  const tennis = game({ id: 'tennis', options: OPTIONS });
  assert.deepEqual(minigameOptions(tennis, storage), { level: 'medium', hand: 'right' }, 'the defaults to begin with');
  saveMinigameOption(tennis, 'level', 'hard', storage);
  assert.deepEqual(minigameOptions(tennis, storage), { level: 'hard', hand: 'right' });
  assert.deepEqual(minigameOptions(game({ id: 'squash', options: OPTIONS }), storage), { level: 'medium', hand: 'right' }, 'per game');
  // Only what the game offers is saved.
  saveMinigameOption(tennis, 'level', 'impossible', storage);
  saveMinigameOption(tennis, 'colour', 'red', storage);
  assert.deepEqual(minigameOptions(tennis, storage), { level: 'hard', hand: 'right' });
  // What a newer or older version saved: an option it no longer has is dropped, a value it no longer offers is its default.
  storage.setItem('aerodance-minigame-options', JSON.stringify({ tennis: { level: 'nightmare', hand: 'left', spin: 'top' }, squash: 5 }));
  assert.deepEqual(minigameOptions(tennis, storage), { level: 'medium', hand: 'left' });
  saveMinigameOption(tennis, 'level', 'easy', storage);
  assert.deepEqual(JSON.parse(storage.getItem('aerodance-minigame-options') ?? '')?.tennis, { hand: 'left', level: 'easy' }, 'saving again tidies them away');
  storage.setItem('aerodance-minigame-options', '{not json');
  assert.deepEqual(minigameOptions(tennis, storage), { level: 'medium', hand: 'right' }, 'damaged storage is ignored');
  // A game without options never asks the browser; one that can't store still has its defaults.
  const refusing = { getItem: (): string | null => { throw Error('no storage'); }, setItem: () => { throw Error('no storage'); } };
  assert.deepEqual(minigameOptions(game(), refusing), {});
  assert.deepEqual(minigameOptions(tennis, refusing), { level: 'medium', hand: 'right' });
  assert.doesNotThrow(() => saveMinigameOption(tennis, 'level', 'easy', refusing));
  // The rows step round and round, and the canvas lists the choices.
  assert.equal(stepOption(tennis, { level: 'hard' }, 'level', 1), 'easy');
  assert.equal(stepOption(tennis, { level: 'easy' }, 'level', -1), 'hard');
  assert.equal(stepOption(tennis, { level: 'easy' }, 'level', 1), 'medium');
  assert.equal(stepOption(tennis, {}, 'level', 1), 'easy');
  assert.equal(stepOption(tennis, {}, 'spin', 1), null);
  assert.deepEqual(resolveOptions(tennis, { hand: 'left', spin: 'top' }), { level: 'medium', hand: 'left' });
  assert.equal(optionsText(resolveOptions(tennis, { level: 'hard' })), 'level=hard|hand=right');
  assert.equal(optionsText({}), '');
});

test('a round has the preview\'s settings as ctx.options, and the game can change them as it goes', () => {
  const storage = memoryStorage();
  const tennis = game({ id: 'tennis', options: OPTIONS });
  saveMinigameOption(tennis, 'level', 'hard', storage);
  const session = new MinigameSession({ game: tennis, playerCount: 1, options: { level: 'hard', hand: 'both', spin: 'top' }, optionStorage: storage });
  const ctx: MinigameContext = session;
  assert.deepEqual(ctx.options, { level: 'hard', hand: 'right' }, 'every option present, anything not offered at its default');
  ctx.setOption('hand', 'left');
  assert.equal(ctx.options.hand, 'left', 'at once');
  assert.deepEqual(minigameOptions(tennis, storage), { level: 'hard', hand: 'left' }, 'saved for Play again and the next preview');
  ctx.setOption('hand', 'both');
  ctx.setOption('spin', 'top');
  assert.deepEqual(ctx.options, { level: 'hard', hand: 'left' }, 'what the game doesn\'t offer is ignored');
  assert.deepEqual(new MinigameSession({ game: tennis, playerCount: 1 }).options, { level: 'medium', hand: 'right' }, 'the defaults without a preview');
  assert.deepEqual(new MinigameSession({ game: game(), playerCount: 1 }).options, {});
});

test('the preview has room for five option rows on the left, clear of the title, dial and Play', () => {
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  const box = (c: Circle): Rect => ({ x: c.x - c.r, y: c.y - c.r, w: 2 * c.r, h: 2 * c.r });
  for (const width of [1600, 1200]) {
    const plain = minigameLayout(width);
    assert.equal(plain.MG_OPTIONS, null, 'no panel without options');
    for (let n = 1; n <= MG_MAX_OPTIONS; n++) {
      const l = minigameLayout(width, n), panel = l.MG_OPTIONS!, at = `${width}, ${n} rows`;
      const screen = { x: 40, y: l.MG_BACK.y + l.MG_BACK.r + 40, w: width - 80, h: 900 - 40 - (l.MG_BACK.y + l.MG_BACK.r + 40) };
      assert.ok(inside(panel, screen), `on screen, below the header and clear of the top corners (${at})`);
      assert.equal(panel.x, l.MG_TEXT.x, `options in the left column (${at})`);
      assert.ok(panel.x + panel.w <= width / 2, `room for the platform on the right (${at})`);
      assert.ok(panel.y > l.MG_BACK.y + 84 + 40, `clear of the title (${at})`);
      assert.ok(!overlaps(panel, l.MG_PLAY) && !overlaps(panel, box(l.MG_PLUS)) && !overlaps(panel, box(l.MG_MINUS)), `clear of the dial and Play (${at})`);
      assert.ok(panel.y + panel.h < l.MG_MINUS.y - 60, `clear of the count (${at})`);
      assert.deepEqual([l.MG_PLAY, l.MG_MINUS, l.MG_PLUS], [plain.MG_PLAY, plain.MG_MINUS, plain.MG_PLUS], 'the controls stay put');
      for (let i = 0; i < n; i++) {
        const row = l.mgOption(i), prev = box(l.mgOptionPrev(i)), next = box(l.mgOptionNext(i));
        assert.ok(inside(row, panel) && inside(prev, row) && inside(next, row), `row ${i} and its arrows in the panel (${at})`);
        if (i) assert.ok(row.y >= l.mgOption(i - 1).y + l.mgOption(i - 1).h, `rows apart (${at})`);
        assert.ok(next.x - (prev.x + prev.w) >= 140, `room for a choice between the arrows (${at})`);
        assert.ok(prev.x - (row.x + 22) >= 190, `room for the label (${at})`);
        // A per-player row's chips: in the row, after its label, apart, each with room for a word.
        for (let count = 1; count <= 4; count++) {
          for (let p = 0; p < count; p++) {
            const chip = l.mgOptionPlayer(i, p, count);
            assert.ok(inside(chip, row) && chip.x - (row.x + 22) >= 150, `row ${i}'s chip ${p} of ${count} in the row, after the label (${at})`);
            assert.ok(chip.w >= 55, `room for a choice in chip ${p} of ${count} (${at})`);
            if (p) assert.ok(chip.x >= l.mgOptionPlayer(i, p - 1, count).x + l.mgOptionPlayer(i, p - 1, count).w, `chips apart (${at})`);
          }
        }
      }
    }
    assert.ok(plain.MG_BEST_Y > plain.MG_BACK.y + 84 && plain.MG_BEST_Y < minigameLayout(width, 1).MG_OPTIONS!.y, 'the best fits under the title');
  }
});

test('a game that asks for hands has them from the camera while its session lives, in its players\' raw poses; others never do', async () => {
  // A puppet camera that takes the detail (its hands come on at once) and remembers each request.
  const clock = { t: 10000 };
  const puppet = new Puppet({ now: () => clock.t, realism: REALISM.real });
  puppet.follow(1);
  const tracker = new PlayerTracker(1);
  const listeners = new Set<(e: PoseSourceEvent) => void>();
  const details: (PoseDetail | null)[] = [];
  let seq = 0;
  const source: PoseSource = {
    view: { status: 'connected', message: '', sourceKind: 'webcam', snapshot: null, configuring: false, model: 'lite' },
    subscribeRecords(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setDetail(detail) { details.push(detail); source.view.hands = detail === 'hands' ? 'on' : undefined; },
  };
  const run = (ms: number, session: MinigameSession) => {
    for (const end = clock.t + ms; clock.t < end;) {
      clock.t += 40;
      const on = !!source.view.hands;
      const found = puppet.detect(clock.t - 50, { world: on, hands: on });
      const record: LivePoseRecord = { type: 'pose', sessionId: 'puppet', seq: ++seq, playerCount: 1, input: INPUT,
        poses: tracker.update(found.landmarks, INPUT, clock.t, found.looks, on ? { world: found.world, hands: found.hands } : {}) };
      for (const fn of listeners) fn({ record, receivedBrowserTimeMs: clock.t, captureBrowserTimeMs: clock.t, timing: { method: 'browser-frame-observation' } });
      session.advance();
    }
  };
  const hands = game({ tracking: 'hands', players: [1] });
  const now = () => clock.t;
  const session = new MinigameSession({ game: hands, playerCount: 1, source, now });
  assert.deepEqual(details, ['hands']);
  assert.equal(session.handTracking(), 'on');
  await session.load();
  run(800, session);
  const p = session.players[0];
  assert.equal(p.raw?.world?.length, 33);
  assert.deepEqual(p.raw?.hands?.map((h) => h.side), ['left', 'right']);
  assert.equal(p.raw?.capturedAt, p.capturedAt);
  // Play again starts the next round before this one ends: the detail stays on for it.
  const next = new MinigameSession({ game: hands, playerCount: 1, source, now });
  session.dispose();
  assert.deepEqual(details, ['hands', 'hands']);
  next.dispose();
  next.dispose();
  assert.deepEqual(details, ['hands', 'hands', null], 'off once the last round ends, once');
  // A game that chooses per round: by its player count and settings, asking again when a setting changes mid-round.
  const choosing = game({ players: [1, 2], options: [option({ id: 'hands', choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], default: 'on' })],
    tracking: ({ playerCount, options }) => (playerCount === 1 && options.hands === 'on' ? 'hands' : 'world') });
  const storage = memoryStorage();
  const solo = new MinigameSession({ game: choosing, playerCount: 1, source, now, optionStorage: storage });
  assert.equal(details.at(-1), 'hands');
  assert.equal(solo.handTracking(), 'on');
  solo.setOption('hands', 'off');
  assert.equal(details.at(-1), 'world');
  assert.equal(solo.handTracking(), null, 'no hands asked for');
  solo.dispose();
  assert.equal(details.at(-1), null);
  const pair = new MinigameSession({ game: choosing, playerCount: 2, source, now, options: { hands: 'on' }, optionStorage: storage });
  assert.equal(details.at(-1), 'world');
  pair.dispose();
  // A game that doesn't ask has none.
  const plain = new MinigameSession({ game: game(), playerCount: 1, source, now });
  assert.equal(plain.handTracking(), null);
  assert.equal(details.at(-1), null);
  await plain.load();
  run(400, plain);
  assert.deepEqual([plain.players[0].raw?.world, plain.players[0].raw?.hands], [null, null]);
  plain.dispose();
  // A source without the detail (a replay) has no hands to give.
  const replay: PoseSource = { view: { status: 'connected', message: '', sourceKind: 'replay', snapshot: null, configuring: false, model: 'replay' }, subscribeRecords: () => () => {} };
  const replayed = new MinigameSession({ game: hands, playerCount: 1, source: replay, now });
  assert.equal(replayed.handTracking(), 'unavailable');
  replayed.dispose();
});
