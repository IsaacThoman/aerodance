import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { Puppet, REALISM } from '../src/pose/puppet/Puppet.ts';
import { PlayerTracker } from '../../../packages/pose/browser/tracker.ts';
import type { PlayerCount } from '../../../packages/pose/choreography.ts';
import type { PoseRecordEvent } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { LivePoseRecord, PoseSource, PoseSourceEvent } from '../src/pose/PoseSource.ts';
import { COUNTDOWN_MS, FINISH_MS, MinigameSession, RAISE_START_MS } from '../src/minigames/MinigameSession.ts';
import { definitionProblem, formatScore, listMinigames, playersLabel } from '../src/minigames/definition.ts';
import { minigameBest, recordMinigameBest } from '../src/minigames/bestScores.ts';
import { cameraArea, fromDesign, toDesign } from '../src/minigames/cameraArea.ts';
import { minigameLayout, mgTile } from '../src/minigames/layout.ts';
import type { MinigameDefinition } from '../src/minigames/types.ts';

const INPUT = { width: 640, height: 480, mirrored: false };
const game = (patch: Partial<MinigameDefinition> = {}): MinigameDefinition => ({
  id: 'test-game', title: 'Test Game', blurb: 'A test', description: 'Testing.', players: [1, 2], howTo: [{ text: 'Do it' }],
  art: () => {}, load: async () => ({ default: () => null }), durationMs: 10000, ...patch,
});
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}

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
  session.finish([42]);
  cam.run(FINISH_MS + 100, () => session.advance());
  assert.deepEqual(session.results, [42]);
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
  assert.ok(folders.includes('reference'));
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

test('the list fits six tiles in either display, clear of the back button and the bottom', () => {
  for (const width of [1600, 1200]) {
    const l = minigameLayout(width);
    const tiles = Array.from({ length: 6 }, (_, i) => l.mgTile(i));
    assert.deepEqual(tiles[0], mgTile(0, width));
    assert.ok(tiles.every((t) => t.x >= 0 && t.x + t.w <= width && t.y > l.MG_BACK.y + l.MG_BACK.r && t.y + t.h <= 900 - 40), `${width}`);
    assert.ok(tiles[1].x >= tiles[0].x + tiles[0].w && tiles[3].y >= tiles[0].y + tiles[0].h, 'no overlaps');
    assert.ok(l.MG_ART.x >= l.MG_TEXT.x + l.MG_TEXT.w && l.MG_ART.x + l.MG_ART.w <= width);
    assert.ok(l.MG_MINUS.x - l.MG_MINUS.r > l.MG_TEXT.x + 150, 'the dial clears its label');
  }
});
