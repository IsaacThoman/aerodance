import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultCast, sampleDancers, sampleSong, validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';
import type { PoseRecordEvent } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import { AUDIO_START_MS, COUNTDOWN_MS, GameSession, LATE_ALLOWANCE_MS, READY_HOLD_MS, SETUP_TRACKING_REFRESH_MS } from '../src/game/GameSession.ts';
import type { GameSessionOptions, SessionPlayer } from '../src/game/GameSession.ts';
import { ReplayPoseSource, createPoseRecorder, parseRecording, standingPose } from '../src/pose/ReplayPoseSource.ts';
import type { LivePoseRecord, PoseInputView, PoseSource, PoseSourceEvent, SongClock } from '../src/pose/PoseSource.ts';
import type { LoadedSongBundle } from '../src/songs/loadBundle.ts';
import { bestScore, recordResults } from '../src/game/bestScores.ts';
import type { BestScoreStorage, ScoredResult } from '../src/game/bestScores.ts';
import { installFakeAudio } from './fixtures/fakeAudio.ts';

const dir = new URL('./fixtures/song-70c63c8e/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const song = validateSong(read('song.json'));
// The session never decodes audio here: createPlayer is faked.
const bundle: LoadedSongBundle = { song, choreography: validateSongChoreography(song, readFileSync(new URL('choreography.adpose', dir))), audio: new Blob([]), cover: null, scoreId: song.songId };

interface Clock { now: number; }
type FakePlayer = SessionPlayer & {
  tick(): void; disposed?: boolean;
  /** Stops or starts the audio (a phone call holding it): its clock stands still meanwhile. */
  setAudio(running: boolean): void;
  /** How far the drawn clock runs ahead of what is heard (songPlayer.ts on a TV: the output latency). */
  aheadMs: number;
};

/** A song player on a fake clock, with songPlayer.ts's surface. */
function fakePlayer(clock: Clock): FakePlayer {
  let startPerf = 0;
  let positionMs = song.playableStartMs;
  let playFrom = positionMs;
  let stoppedAt: number | null = null;
  let playedOut = false;
  const at = (perf: number) => (stoppedAt === null ? perf : Math.min(perf, stoppedAt)) - startPerf;
  const clamp = (ms: number) => Math.min(song.playableEndMs, Math.max(song.playableStartMs, ms));
  const player: FakePlayer = {
    state: 'paused',
    ended: false,
    endMs: song.playableEndMs,
    aheadMs: 0,
    rawTimeMs: () => (player.state === 'playing' ? at(clock.now) + player.aheadMs : positionMs),
    timeMs: () => clamp(player.state === 'playing' ? Math.max(player.rawTimeMs(), playFrom) : positionMs),
    songTimeAt: (perf) => (player.state === 'playing' || playedOut ? at(perf) : positionMs),
    audioRunning: () => stoppedAt === null,
    setAudio(running) {
      // The clock carries on from where it stood.
      if (running && stoppedAt !== null) startPerf += clock.now - stoppedAt;
      stoppedAt = running ? null : stoppedAt ?? clock.now;
    },
    play({ delayMs = 0 } = {}) { playFrom = positionMs; startPerf = (stoppedAt ?? clock.now) + delayMs - positionMs; player.state = 'playing'; player.ended = playedOut = false; },
    pause() { positionMs = clamp(Math.max(player.songTimeAt(clock.now), playFrom)); player.state = 'paused'; },
    seek(ms) { positionMs = clamp(ms); playedOut = false; },
    // The song plays out once its end is heard (and still places late poses after).
    tick() { if (player.state === 'playing' && player.songTimeAt(clock.now) >= song.playableEndMs) { positionMs = song.playableEndMs; player.state = 'paused'; player.ended = playedOut = true; } },
    dispose() { player.disposed = true; },
  };
  return player;
}

type FakeSource = PoseSource & {
  attached: SongClock | null;
  resets: number;
  send(poses: Pose[], captureBrowserTimeMs: number, playerCount?: PlayerCount): void;
};

/** A pose source the test drives by hand. */
function fakeSource(sourceKind: PoseInputView['sourceKind'] = 'replay'): FakeSource {
  const listeners = new Set<(event: PoseSourceEvent) => void>();
  let seq = 0;
  return {
    view: { sourceKind, status: 'connected', message: '', snapshot: null, configuring: false, model: 'test' },
    attached: null,
    resets: 0,
    resetTracking() { this.resets++; },
    subscribeRecords(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    attachSong(clock) { this.attached = clock; },
    send(poses, captureBrowserTimeMs, playerCount = 1) {
      const record: LivePoseRecord = { type: 'pose', sessionId: 's', seq: ++seq, playerCount, input: { width: 640, height: 480, mirrored: false }, poses };
      for (const fn of listeners) fn({ record, captureBrowserTimeMs, receivedBrowserTimeMs: captureBrowserTimeMs, timing: { method: 'test' } });
    },
  };
}

type SetupOptions = Partial<GameSessionOptions> & { sourceKind?: PoseInputView['sourceKind'] };

async function setup(playerCount: PlayerCount = 1, options: SetupOptions = {}) {
  const clock = { now: 1000 };
  let player: FakePlayer | null = null;
  const current = () => {
    if (!player) throw Error('The song player has not been created');
    return player;
  };
  const source = fakeSource(options.sourceKind);
  const session = new GameSession({
    bundle, playerCount, source, now: () => clock.now, createPlayer: async () => (player = fakePlayer(clock)), ...options,
  });
  await session.load();
  const step = (ms: number, each?: (now: number) => void) => {
    for (let t = 0; t < ms; t += 50) {
      clock.now += 50;
      each?.(clock.now);
      current().tick();
      session.update(clock.now);
    }
  };
  return { clock, session, source, step, player: current };
}

// One player in the middle, two at 0.3 and 0.7, three or four spread evenly.
const laneX = (playerCount: PlayerCount, id: number) => (playerCount === 1 ? 0.5 : playerCount === 2 ? 0.3 + id * 0.4 : (id + 0.5) / playerCount);
const standing = (playerCount: PlayerCount): Pose[] => Array.from({ length: playerCount }, (_, playerId) => ({ playerId, landmarks: standingPose(laneX(playerCount, playerId)) }));
const reference = (t: number, playerCount: PlayerCount) => sampleSong(bundle, Math.min(Math.max(t, 0), song.playableEndMs - 1), defaultCast(playerCount, 2)).poses;

test('the ready check waits for every player, then counts down into the song', async () => {
  const { session, source, step } = await setup(2);
  assert.equal(session.phase, 'ready');
  assert.deepEqual(session.readiness(), ['missing', 'missing']);
  // Only player 1 in view: nothing starts.
  step(2000, (now) => source.send([standing(2)[0]], now, 2));
  assert.equal(session.phase, 'ready');
  assert.deepEqual(session.readiness(), ['ready', 'missing']);
  // Both in view: calibrate, hold for a second, then the countdown.
  step(1200 + READY_HOLD_MS + 200, (now) => source.send(standing(2), now, 2));
  assert.equal(session.phase, 'countdown');
  assert.ok(source.attached, 'the pose source follows the song clock');
  assert.ok(session.livePose(0) && session.livePose(1));
  step(COUNTDOWN_MS - 400);
  assert.equal(session.phase, 'countdown');
  assert.ok(session.countdownMs() > 0);
  step(600);
  assert.equal(session.phase, 'playing');
});

test('a paired phone calibrates like a webcam; only replays skip calibration', async () => {
  assert.equal((await setup(1, { sourceKind: 'phone' })).session.phase, 'calibrating');
  assert.equal((await setup(1, { sourceKind: 'replay' })).session.phase, 'ready');
});

test('each live-camera song starts a fresh line-up; replay identities are preserved', async () => {
  for (const kind of ['webcam', 'phone', 'replay'] as const) {
    const { session, source } = await setup(2, { sourceKind: kind });
    const expected = kind === 'replay' ? 0 : 1;
    assert.equal(source.resets, expected);
    session.dispose();
    const next = await setup(2, { source });
    assert.equal(source.resets, 2 * expected, `${kind} resets once per song`);
    next.session.dispose();
  }
});

test('stuck setup refreshes assignments periodically, but a hold and gameplay keep their identities', async () => {
  for (const sourceKind of ['webcam', 'phone'] as const) {
    const { session, source, step } = await setup(2, { sourceKind });
    step(SETUP_TRACKING_REFRESH_MS * 2, now => source.send([standing(2)[0]], now, 2));
    assert.equal(source.resets, 3, `${sourceKind}: initial line-up and two retries`);
    // Start holding just before another retry would be due. The hold must complete.
    step(SETUP_TRACKING_REFRESH_MS - 100, now => source.send([standing(2)[0]], now, 2));
    step(2600, now => source.send(standing(2), now, 2));
    assert.equal(session.phase, 'countdown');
    assert.equal(source.resets, 3, 'no reset through the hold');
    step(COUNTDOWN_MS + SETUP_TRACKING_REFRESH_MS * 2, now => source.send(standing(2), now, 2));
    assert.equal(session.phase, 'playing');
    assert.equal(source.resets, 3, 'no reset during gameplay');
    session.dispose();
  }
});

test('webcam sessions require a shared still hold and start countdown immediately after calibration', async () => {
  const { session, source, step, player } = await setup(2, { sourceKind: 'webcam' });
  assert.equal(session.phase, 'calibrating');
  session.start();
  assert.equal(player().state, 'paused', 'manual start cannot bypass webcam calibration');
  step(3000, now => source.send([standing(2)[0]], now, 2));
  assert.equal(session.phase, 'calibrating');
  assert.ok(session.live.every(p => p.calibration === null));
  step(2500, now => source.send(standing(2), now, 2));
  assert.equal(session.phase, 'calibrating', 'the first frame starts the 2.5-second window');
  assert.equal(source.attached, null);
  assert.equal(session.scorer.result(0).score, 0);
  step(50, now => source.send(standing(2), now, 2));
  assert.equal(session.phase, 'countdown');
  assert.equal(session.countdownMs(), COUNTDOWN_MS, 'no additional one-second readiness wait');
  for (const [id, live] of session.live.entries()) {
    assert.ok(live.calibration);
    assert.equal(live.calibration.cameraScaleMode, 'body-relative');
    assert.ok(Math.abs(live.calibration.baseHip.x - (0.3 + id * 0.4)) < 1e-6);
  }
  step(COUNTDOWN_MS);
  assert.equal(session.phase, 'playing');
});

test('continuing without a camera starts the countdown; anyone the camera sees still dances and scores', async () => {
  const { session, source, step, player } = await setup(2, { sourceKind: 'webcam' });
  assert.equal(session.phase, 'calibrating');
  session.continueWithoutCamera();
  assert.equal(session.phase, 'countdown');
  assert.equal(session.webcamCalibration, null);
  assert.ok(session.withoutCamera);
  assert.equal(player().state, 'playing');
  assert.ok(source.attached, 'the pose source follows the song clock');
  step(COUNTDOWN_MS + 200);
  assert.equal(session.phase, 'playing');
  // Nobody calibrated by holding still: player 1 steps in mid-song and calibrates as they dance.
  step(3000, now => source.send([standing(2)[0]], now, 2));
  assert.ok(session.live[0].calibration);
  assert.ok(session.livePose(0));
  assert.equal(session.live[1].calibration, null);
  session.continueWithoutCamera();
  assert.equal(session.phase, 'playing', 'only the calibration screen continues without a camera');
});

test('webcam calibration survives lost tracking and pause/resume but a new game calibrates afresh', async () => {
  const { session, source, step, clock } = await setup(1, { sourceKind: 'webcam' });
  step(2600, now => source.send(standing(1), now));
  const profile = session.live[0].calibration;
  step(COUNTDOWN_MS + 3500);
  assert.equal(session.livePose(0), null);
  const moved = standing(1); moved[0].landmarks.forEach(j => { j.x += 0.1; });
  source.send(moved, clock.now);
  assert.equal(session.live[0].calibration, profile);
  assert.ok(session.livePose(0));
  session.pause(); session.resume();
  assert.equal(session.phase, 'countdown');
  assert.equal(session.live[0].calibration, profile);
  session.dispose();
  const next = new GameSession({ bundle, playerCount: 1, source, now: () => clock.now, createPlayer: async () => fakePlayer(clock) });
  await next.load();
  assert.equal(next.phase, 'calibrating');
  assert.equal(next.live[0].calibration, null);
  next.dispose();
});

test('poses gathered while webcam song audio loads do not count toward calibration', async () => {
  const clock = { now: 0 }, source = fakeSource('webcam');
  let resolvePlayer: ((player: SessionPlayer) => void) | undefined;
  const session = new GameSession({ bundle, playerCount: 1, source, now: () => clock.now,
    createPlayer: () => new Promise(resolve => { resolvePlayer = resolve; }) });
  const loading = session.load();
  for (clock.now = 0; clock.now < 3000; clock.now += 100) source.send(standing(1), clock.now);
  assert.equal(session.live[0].calibration, null);
  assert.ok(resolvePlayer);
  resolvePlayer(fakePlayer(clock)); await loading;
  assert.equal(session.phase, 'calibrating');
  assert.equal(session.calibrationStatus()?.progress, 0);
  session.dispose();
});

test('a webcam boundary before countdown discards a completed calibration', async () => {
  const { session, source, step, clock } = await setup(1, { sourceKind: 'webcam', autoStart: false });
  step(2600, now => source.send(standing(1), now));
  assert.equal(session.phase, 'ready');
  const previous = session.live[0].calibration;
  for (let seq = 1; seq <= 26; seq++) {
    clock.now += 100;
    const poses = standing(1); poses[0].landmarks.forEach(j => { j.x += 0.1; });
    session.onRecord({ record: { type: 'pose', playerCount: 1, sessionId: 'new-camera', seq,
      input: { width: 1280, height: 720, mirrored: false }, poses },
    captureBrowserTimeMs: clock.now, receivedBrowserTimeMs: clock.now, timing: { method: 'test' } });
    if (seq === 1) {
      assert.equal(session.phase, 'calibrating');
      assert.equal(session.live[0].calibration, null);
      session.start();
      assert.equal(session.phase, 'calibrating');
    }
  }
  assert.equal(session.phase, 'ready');
  const calibration = session.live[0].calibration;
  assert.ok(calibration);
  assert.notEqual(calibration, previous);
  assert.equal(calibration.inputWidth, 1280);
  assert.ok(Math.abs(calibration.baseHip.x - 0.6) < 1e-6);
  session.dispose();
});

test('a player who copies the routine scores high, judged at capture time despite late arrival', async () => {
  const { session, source, step, player } = await setup(1, { autoStart: false });
  session.start();
  const pending: { at: number; capture: number; poses: Pose[] }[] = [];
  step(COUNTDOWN_MS + song.playableEndMs + LATE_ALLOWANCE_MS + 500, (now) => {
    // The camera sees the player now; the pose arrives 300 ms later.
    if (player().state === 'playing' && now % 100 === 0) pending.push({ at: now + 300, capture: now, poses: reference(player().songTimeAt(now), 1) });
    for (let p = pending[0]; p && p.at <= now; p = pending[0]) { pending.shift(); source.send(p.poses, p.capture); }
  });
  assert.equal(session.phase, 'results');
  assert.ok(session.results);
  assert.equal(session.results.length, 1);
  assert.ok(session.results[0].score > 950_000, `score ${session.results[0].score}`);
  assert.equal(source.attached, null, 'the source is released from the song');
});

for (const count of [3, 4] as const) {
  test(`${count} webcam players calibrate together and each scores against their part`, async () => {
    const { session, source, step, player } = await setup(count, { sourceKind: 'webcam' });
    assert.equal(session.phase, 'calibrating');
    // Everyone but the last player: no calibration.
    step(3000, (now) => source.send(standing(count).slice(0, -1), now, count));
    assert.equal(session.phase, 'calibrating');
    step(2600, (now) => source.send(standing(count), now, count));
    assert.equal(session.phase, 'countdown');
    for (const [id, live] of session.live.entries()) assert.ok(Math.abs((live.calibration?.baseHip.x ?? -1) - laneX(count, id)) < 1e-6);
    step(COUNTDOWN_MS + song.playableEndMs + LATE_ALLOWANCE_MS + 500, (now) => {
      if (player().state === 'playing' && now % 100 === 0) source.send(reference(player().songTimeAt(now), count), now, count);
    });
    assert.equal(session.phase, 'results');
    assert.ok(session.results);
    assert.equal(session.results.length, count);
    for (const result of session.results) assert.ok(result.score > 900_000, `player ${result.playerId + 1} scored ${result.score}`);
  });
}

test('pausing stops scoring, drops later poses and resumes with a countdown at the same spot', async () => {
  const { session, source, step, player } = await setup(1, { autoStart: false });
  session.start();
  step(COUNTDOWN_MS + 5000);
  assert.equal(session.phase, 'playing');
  const at = player().timeMs();
  session.pause();
  assert.equal(session.phase, 'paused');
  assert.equal(session.pausedAtMs, at);
  step(2000);
  assert.equal(player().timeMs(), at, 'the song holds while paused');
  session.resume();
  assert.equal(session.phase, 'countdown');
  // Poses captured during the resume countdown map to before the pause: never scored.
  const before = session.scorer.result(0).score;
  step(COUNTDOWN_MS - 200, (now) => source.send(reference(player().songTimeAt(now), 1), now));
  assert.equal(player().timeMs(), at, 'the dancers hold their place during the countdown');
  session.scorer.finish();
  assert.equal(session.scorer.result(0).score, before);
});

test('on a TV the dancers are drawn ahead by the latency, while judging goes by what was heard', async () => {
  const AHEAD = 500;
  const { session, source, step, player } = await setup(1, { autoStart: false });
  session.start();
  player().aheadMs = AHEAD;
  // The countdown ends when the music starts rendering: the TV shows zero with its sound.
  step(COUNTDOWN_MS - AHEAD - 100);
  assert.equal(session.phase, 'countdown');
  step(150);
  assert.equal(session.phase, 'playing');
  // A player who copies what they see and hear scores high, with poses arriving within the late
  // allowance: scoring by the drawn clock would leave them 500 ms less of it, and miss these.
  const pending: { at: number; capture: number; poses: Pose[] }[] = [];
  step(song.playableEndMs + LATE_ALLOWANCE_MS + 500, (now) => {
    if (player().state === 'playing' && now % 100 === 0) pending.push({ at: now + LATE_ALLOWANCE_MS - 50, capture: now, poses: reference(player().songTimeAt(now), 1) });
    for (let p = pending[0]; p && p.at <= now; p = pending[0]) { pending.shift(); source.send(p.poses, p.capture); }
  });
  assert.equal(session.phase, 'results');
  assert.ok(session.results && session.results[0].score > 950_000, `score ${session.results?.[0].score}`);
});

test('on a TV, pausing keeps what was heard and seen, not what was drawn ahead for the TV', async () => {
  const AHEAD = 250;
  const { session, step, player } = await setup(1, { autoStart: false });
  session.start();
  player().aheadMs = AHEAD;
  step(COUNTDOWN_MS + 2000);
  const drawn = player().timeMs();
  assert.equal(drawn - player().songTimeAt(session.now()), AHEAD);
  session.pause();
  assert.equal(session.pausedAtMs, drawn - AHEAD);
  assert.equal(player().timeMs(), drawn - AHEAD);
  // A recording replays each pose at the perf time its song position was heard.
  session.resume();
  step(COUNTDOWN_MS + 500);
  assert.equal(session.clock.songTimeAt(session.clock.perfAtSong(drawn)), drawn);
});

test('Resume while a call still holds the audio pauses again instead of a countdown that never ends', async () => {
  const { session, step, player } = await setup(1, { autoStart: false });
  session.start();
  step(COUNTDOWN_MS + 2000);
  assert.equal(session.phase, 'playing');
  // The call takes the audio; the game pauses for it.
  player().setAudio(false);
  session.pause();
  const at = session.pausedAtMs;
  // Resume during the call: the audio doesn't start, so the countdown's clock stands still.
  session.resume();
  assert.equal(session.phase, 'countdown');
  assert.equal(session.waitingForAudio, false);
  step(AUDIO_START_MS - 100);
  assert.equal(session.phase, 'countdown', 'the audio gets a moment to start');
  assert.equal(session.countdownMs(), COUNTDOWN_MS, 'the countdown waits at 3, not 4');
  step(100);
  assert.equal(session.phase, 'paused');
  assert.equal(session.waitingForAudio, true, 'the pause screen says what it waits for');
  assert.equal(session.pausedAtMs, at, 'at the same spot');
  // The call ends: Resume plays on.
  player().setAudio(true);
  session.resume();
  assert.equal(session.waitingForAudio, false);
  step(COUNTDOWN_MS + 100);
  assert.equal(session.phase, 'playing');
  // A countdown whose audio is running (or just starting) is left alone.
  session.pause();
  session.resume();
  step(COUNTDOWN_MS + 100);
  assert.equal(session.phase, 'playing');
});

test('the song finishes after the late-arrival allowance, with results', async () => {
  const { session, step } = await setup(1, { autoStart: false });
  session.start();
  step(COUNTDOWN_MS + song.playableEndMs + 100);
  assert.equal(session.phase, 'finishing');
  step(LATE_ALLOWANCE_MS);
  assert.equal(session.phase, 'results');
  assert.ok(session.results);
  assert.equal(session.results[0].score, 0, 'nobody danced');
  assert.equal(session.results[0].coverage, 0);
});

test('pausing once the end of the song is heard lets it finish rather than pausing at the end', async () => {
  const { session, step, player, clock } = await setup(1, { autoStart: false });
  session.start();
  step(COUNTDOWN_MS + song.playableEndMs - 50);
  // The song has just played out; the next frame would move on to finishing.
  clock.now += 50;
  player().tick();
  assert.ok(player().ended);
  session.pause();
  assert.equal(session.phase, 'playing', 'resuming from the end would start the song over');
  step(50 + LATE_ALLOWANCE_MS);
  assert.equal(session.phase, 'results');
});

test('pausing past the player\'s end (audio a little shorter than the song) finishes rather than starting over', async () => {
  const clock = { now: 1000 };
  const player = fakePlayer(clock);
  // The decoded audio ends 20 ms before the song says it does; the player ends with the audio.
  player.endMs = song.playableEndMs - 20;
  const session = new GameSession({ bundle, playerCount: 1, source: fakeSource(), now: () => clock.now, createPlayer: async () => player, autoStart: false });
  await session.load();
  session.start();
  for (let t = 0; t < COUNTDOWN_MS + song.playableEndMs - 10; t += 10) { clock.now += 10; session.update(clock.now); }
  // Heard past the audio's end, before the player has noticed.
  assert.equal(player.ended, false);
  session.pause();
  assert.equal(session.phase, 'playing', 'resuming would have started the song over from 0');
  session.dispose();
});

/**
 * A ghost that copies the routine exactly, on the real song player through a fake WebKit
 * context: the camera sees it every 100 ms, and each pose arrives 200 ms later. latencyMs is
 * output latency the timestamp leaves out (AirPods, AirPlay), so the source ends that long
 * before its end is heard.
 */
async function ghostRun(t: TestContext, latencyMs: number) {
  const audio = installFakeAudio(t, { latencyMs, bufferMs: song.playableEndMs + 1000 });
  const source = fakeSource();
  const session = new GameSession({ bundle, playerCount: 1, source, now: () => audio.now, autoStart: false });
  await session.load();
  const placed: number[] = [];
  const addSample = session.scorer.addSample;
  session.scorer.addSample = (id, ms, ...rest) => { placed.push(ms); addSample(id, ms, ...rest); };
  session.start();
  const pending: { at: number; capture: number; poses: Pose[] }[] = [];
  let danced = -Infinity;
  while (session.phase !== 'results' && audio.now < 120_000) {
    audio.advance(50);
    const now = audio.now;
    const heard = session.clock.songTimeAt(now);
    if (now % 100 === 0) pending.push({ at: now + 200, capture: now, poses: reference(heard, 1) });
    // The last pose danced to the song (the routine's poses end a little before it does).
    if (now % 100 === 0 && heard < song.playableEndMs && reference(heard, 1).length) danced = heard;
    for (let p = pending[0]; p && p.at <= now; p = pending[0]) { pending.shift(); source.send(p.poses, p.capture); }
    session.update(now);
  }
  assert.equal(session.phase, 'results');
  return { score: session.results?.[0].score ?? 0, last: Math.max(...placed), danced };
}

test('output latency left out of the timestamp still judges the end of the song as it is heard', async (t) => {
  const runs: Record<number, { score: number; last: number; danced: number }> = {};
  for (const latencyMs of [0, 500]) await t.test(`${latencyMs} ms`, async (t) => { runs[latencyMs] = await ghostRun(t, latencyMs); });
  for (const run of Object.values(runs)) {
    // Poses danced up to the end, arriving after it, are placed where they were danced.
    assert.ok(run.danced > song.playableEndMs - 200);
    assert.equal(run.last, run.danced);
    assert.ok(run.score > 990_000, `score ${run.score}`);
  }
  assert.ok(runs[500].score >= runs[0].score, `${runs[500].score} < ${runs[0].score}`);
});

test('the entrance follows the first beat and holds through pause and resume', async () => {
  const { session, step } = await setup(1, { autoStart: false });
  const routine = session.routine();
  assert.equal(routine.entranceTimeMs(), -Infinity, 'hidden during the ready check');
  session.start();
  assert.equal(routine.entranceTimeMs(), -COUNTDOWN_MS);
  step(COUNTDOWN_MS - 500);
  assert.equal(routine.entranceTimeMs(), -500);
  session.pause();
  step(1000);
  assert.equal(routine.entranceTimeMs(), -500, 'pausing mid-entrance freezes the effect');
  session.resume();
  assert.equal(routine.entranceTimeMs(), -COUNTDOWN_MS, 'an interrupted entrance starts again');
  step(COUNTDOWN_MS);
  assert.equal(routine.entranceTimeMs(), 0);
  step(300);
  session.pause();
  step(1000);
  assert.equal(routine.entranceTimeMs(), 300);
  session.resume();
  step(COUNTDOWN_MS - 100);
  assert.equal(routine.entranceTimeMs(), 300, 'resume keeps an appeared dancer in place');
  step(200);
  assert.equal(routine.entranceTimeMs(), 400);
  session.dispose();
  const retry = await setup(2, { autoStart: false });
  assert.equal(retry.session.routine().entranceTimeMs(), -Infinity);
  retry.session.start();
  assert.equal(retry.session.routine().entranceTimeMs(), -COUNTDOWN_MS, 'a new run gets a fresh entrance');
  retry.session.dispose();
});

test('the ghost replay dances the routine and stands in its halves without a song', async () => {
  let now = 0;
  const ghost = new ReplayPoseSource({ now: () => now });
  const records: PoseRecordEvent<LivePoseRecord>[] = [];
  ghost.subscribeRecords((e) => records.push(e));
  await ghost.setPlayerCount(2);
  ghost.tick();
  assert.deepEqual(records[0].record.poses.map((p) => p.playerId), [0, 1]);
  assert.ok(records[0].record.poses[0].landmarks[23].x > 0.5 && records[0].record.poses[1].landmarks[23].x < 0.5);
  ghost.attachSong({ bundle, cast: [0, 1], songTimeAt: (perf) => perf, perfAtSong: (ms) => ms, playing: () => true });
  now = 5000;
  ghost.tick();
  const last = records[records.length - 1];
  const pose = last.record.poses[0].landmarks[23];
  const ref = reference(5000, 2)[0].landmarks[23];
  assert.ok(Math.abs(pose.x - ref.x) < 0.05 && Math.abs(pose.y - ref.y) < 0.05);
  assert.equal(last.captureBrowserTimeMs, 5000);
});

test('a four-player ghost stands side by side and doubles the duet', async () => {
  let now = 0;
  const ghost = new ReplayPoseSource({ now: () => now, noise: 0 });
  const records: PoseRecordEvent<LivePoseRecord>[] = [];
  ghost.subscribeRecords((e) => records.push(e));
  await ghost.setPlayerCount(4);
  ghost.tick();
  const hips = records[0].record.poses.map((p) => p.landmarks[23].x);
  assert.deepEqual(records[0].record.poses.map((p) => p.playerId), [0, 1, 2, 3]);
  assert.ok(hips.every((x, i) => i === 0 || x < hips[i - 1]), 'P1 stands on the right of the camera, P4 on its left');
  ghost.attachSong({ bundle, cast: defaultCast(4, 2), songTimeAt: (perf) => perf, perfAtSong: (ms) => ms, playing: () => true });
  now = 5000;
  ghost.tick();
  const last = records[records.length - 1].record;
  assert.equal(last.playerCount, 4);
  assert.deepEqual(last.poses[2].landmarks, last.poses[0].landmarks);
  assert.deepEqual(last.poses[3].landmarks, last.poses[1].landmarks);
  await assert.rejects(ghost.setPlayerCount(5 as PlayerCount));
});

test('the session, its dancers and the ghost follow the cast the players picked', async () => {
  const { session, source } = await setup(2, { cast: [1, 1], autoStart: false });
  assert.deepEqual(session.cast, [1, 1]);
  assert.deepEqual(session.routine().cast, [1, 1]);
  session.start();
  assert.deepEqual(source.attached?.cast, [1, 1], 'the ghost hears the cast with the song');
  // A cast that doesn't fit the song or the players falls back to taking turns.
  for (const cast of [[0, 2], [0], [0, 1, 0]]) assert.deepEqual((await setup(2, { cast })).session.cast, [0, 1]);
  assert.deepEqual((await setup(3)).session.cast, [0, 1, 0]);

  // The ghost dances each player's pick: player 1 the second dancer, player 2 the first.
  let now = 0;
  const ghost = new ReplayPoseSource({ now: () => now, noise: 0 });
  const records: PoseRecordEvent<LivePoseRecord>[] = [];
  ghost.subscribeRecords((e) => records.push(e));
  await ghost.setPlayerCount(2);
  ghost.attachSong({ bundle, cast: [1, 0], songTimeAt: (perf) => perf, perfAtSong: (ms) => ms, playing: () => true });
  now = 5000;
  ghost.tick();
  const { poses } = records[records.length - 1].record, dancers = sampleDancers(bundle, 5000).poses;
  assert.deepEqual(poses.map((p) => p.playerId), [0, 1]);
  assert.deepEqual(poses[0].landmarks, dancers[1].landmarks);
  assert.deepEqual(poses[1].landmarks, dancers[0].landmarks);
});

test('a four-player pose recording keeps every player', async () => {
  const source = fakeSource();
  const recorder = createPoseRecorder(source, { songId: song.songId, songTimeAt: (perf) => perf, playerCount: 4 });
  source.send(standing(4), 1000, 4);
  source.send(standing(4).filter((p) => p.playerId !== 2), 1100, 4);
  const { header, entries } = parseRecording(recorder.stop());
  assert.equal(header.playerCount, 4);
  assert.deepEqual(entries.map((e) => e.record.poses.map((p) => p.playerId)), [[0, 1, 2, 3], [0, 1, 3]]);
  assert.ok(Math.abs(entries[0].record.poses[3].landmarks[23].x - standing(4)[3].landmarks[23].x) < 1e-3);
});

test('a pose recording replays at the song times it was captured', async () => {
  const source = fakeSource();
  const recorder = createPoseRecorder(source, { songId: song.songId, songTimeAt: (perf) => perf - 100, playerCount: 1 });
  source.send(standing(1), 1100);
  source.send(standing(1), 1200);
  const { header, entries } = parseRecording(recorder.stop());
  assert.equal(header.songId, song.songId);
  assert.deepEqual(entries.map((e) => e.songTimeMs), [1000, 1100]);

  let now = 0;
  const replay = new ReplayPoseSource({ now: () => now, mode: 'recording', recording: { header, entries } });
  const out: number[] = [];
  replay.subscribeRecords((e) => out.push(e.captureBrowserTimeMs));
  replay.attachSong({ bundle, cast: [0], songTimeAt: (perf) => perf - 500, perfAtSong: (ms) => ms + 500, playing: () => true });
  now = 1550;
  replay.tick();
  assert.deepEqual(out, [1500]);
  now = 1700;
  replay.tick();
  assert.deepEqual(out, [1500, 1600]);
});

test('best scores keep the top score per song, mode and scorer version', () => {
  const store = new Map<string, string>();
  const storage: BestScoreStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } };
  const r = (score: number): ScoredResult => ({ score, grade: 'A', accuracy: score / 1e6, scorerVersion: 1 });
  assert.equal(recordResults('song', 2, [r(500), r(700)], storage).isNewBest, true);
  assert.equal(bestScore('song', 2, 1, storage)?.score, 700);
  assert.equal(recordResults('song', 2, [r(600)], storage).isNewBest, false);
  assert.equal(recordResults('song', 1, [r(100)], storage).isNewBest, true);
  assert.equal(bestScore('song', 2, 2, storage), null);
});

test('saved failing best scores display F without losing the previous record', () => {
  const saved = { score: 200_000, grade: 'D', accuracy: 0.2, at: '2026-10-01T00:00:00.000Z' };
  let data = JSON.stringify({ 'song|1p|v1': saved });
  const storage: BestScoreStorage = { getItem: () => data, setItem: (_k, v) => { data = v; } };
  const expected = { ...saved, grade: 'F' };
  assert.deepEqual(bestScore('song', 1, 1, storage), expected);

  const result: ScoredResult = { score: 100_000, grade: 'F', accuracy: 0.1, scorerVersion: 1 };
  assert.deepEqual(recordResults('song', 1, [result], storage), {
    previous: expected, best: expected, isNewBest: false,
  });
  assert.equal(recordResults('song', 1, [{ ...result, score: 300_000, accuracy: 0.3 }], storage).isNewBest, true);
  assert.equal(bestScore('song', 1, 1, storage)?.grade, 'F');
  assert.equal(JSON.parse(data)['song|1p|v1'].grade, 'F');
});
