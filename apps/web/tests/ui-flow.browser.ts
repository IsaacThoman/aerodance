// Browser flow for the in-engine game UI: Settings, player count, Song Select, the song
// preview on its dance stage and a scored song. Everything is drawn on the canvas,
// so it clicks design coordinates (the layout modules below) and reads the state each
// overlay reports on the canvas's data attributes. Run after `npm run build`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { chromium } from 'playwright';
import { bundleFixture, choreographyBytes, silentWav } from './fixtures/songBundle.ts';
import type { BundleFixture } from './fixtures/songBundle.ts';
import { menuLayout } from '../src/menu/layout.ts';
import { gameLayout } from '../src/game/layout.ts';
import { DISPLAY_MODES } from '../src/display.ts';
import type { Circle, Rect } from '../src/ui/draw.ts';
import { resolveStage } from '../../../packages/stages/catalog.ts';
import { validateCatalog, validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import type { PlayerCount } from '../../../packages/pose/choreography.ts';

// Run the same real input/session flow in each fixed display configuration.
const mode = process.env.UI_ASPECT === 'standard' ? 'standard' : 'widescreen';
const design = DISPLAY_MODES[mode];
const viewport = mode === 'standard' ? { width: 1024, height: 768 } : { width: 1280, height: 800 };
const { ASPECT, BACK: MENU_BACK, MINUS, PLAYERS_BACK, PLAYERS_GO, PLUS, SETTINGS, START, STATS } = menuLayout(design.w);
const { BACK, DANCE, GAME_CALIBRATION_PREVIEW, GAME_PAUSE, GAME_QUIT, GAME_RESUME, RESULTS_RETRY, RESULTS_SONGS, rowRect } = gameLayout(design.w);

/** A layout rect or circle, or a widget with a rect, in design units. */
type Shape = Rect | Circle | { rect: Rect };
/** What the page script adds to window. */
type TestWindow = typeof window & { webcamRequests: number; danceLabelX: number };
/** A reported value to wait for: exactly this string, or matching this pattern. */
type Expected = Record<string, string | RegExp>;
type Match = { re: string } | { is: string };

const app = express();
app.use(express.static('dist'));
const server = app.listen(4173, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const graphics = process.env.UI_GPU === '1'
  ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl', '--disable-gpu-sandbox', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...graphics],
});
// Middle of a layout rect, circle, or widget with a rect.
const center = (shape: Shape) => {
  const r = 'rect' in shape ? shape.rect : shape;
  return 'w' in r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: r.x, y: r.y };
};
let testPage;
try {
  const page = await browser.newPage({ viewport, hasTouch: true });
  testPage = page;
  page.setDefaultTimeout(90000);
  await page.addInitScript(() => {
    const w = window as TestWindow;
    w.webcamRequests = 0;
    // Observe the actual overlay draw, so resizing a static preview must repaint its
    // button in the new layout rather than leaving a cached texture at old coordinates.
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (value, x, y, maxWidth) {
      if (value === 'Dance!') w.danceLabelX = this.getTransform().transformPoint({ x, y }).x;
      if (maxWidth === undefined) fillText.call(this, value, x, y);
      else fillText.call(this, value, x, y, maxWidth);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      w.webcamRequests++;
      throw new DOMException('Fixture permission denied', 'NotAllowedError');
    };
  });
  // Flow assertions exercise the real React/canvas event handlers. Skip GPU
  // rasterization in software-only containers; full visual runs opt in.
  if (process.env.UI_RENDER !== '1') await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        if (Reflect.get(Type.prototype, name)) Reflect.set(Type.prototype, name, () => {});
      }
    }
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Keep empty-catalog coverage independent of installed authored songs.
  await page.route('**/songs/manifest.json', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ version: 1, songs: [] }),
  }));
  await page.goto('http://127.0.0.1:4173');
  await page.locator('canvas').waitFor();
  const frameBox = async () => {
    const box = await page.locator('.canvas-frame').boundingBox();
    assert.ok(box, 'the canvas frame is laid out');
    return box;
  };
  let frame = await frameBox();
  assert.equal(frame.height, mode === 'standard' ? 768 : 720);
  assert.equal(frame.y, mode === 'standard' ? 0 : 40);
  const click = async (shape: Shape) => {
    const p = center(shape);
    await page.mouse.click(frame.x + (p.x / design.w) * frame.width, frame.y + (p.y / design.h) * frame.height);
  };
  const data = () => page.locator('canvas').evaluate((c) => ({ ...c.dataset }));
  // Waits until the canvas's reported state matches (values or regexps).
  const until = async (expected: Expected, timeout?: number) => {
    const entries = Object.entries(expected).map(([k, v]): [string, Match] => [k, v instanceof RegExp ? { re: v.source } : { is: v }]);
    await page.waitForFunction((list) => {
      const d = document.querySelector('canvas')?.dataset;
      return d && list.every(([k, m]) => ('re' in m ? new RegExp(m.re).test(d[k] ?? '') : d[k] === m.is));
    }, entries, timeout ? { timeout } : undefined);
  };
  const menuOn = (screen: string) => until({ menuScreen: screen, menuReady: 'true' });
  // Turns the players dial one step at a time to n, waiting for each step.
  const dialTo = async (n: number) => {
    for (let cur = Number((await data()).menuPlayers); cur !== n; cur += cur < n ? 1 : -1) {
      await click(cur < n ? PLUS : MINUS);
      await until({ menuPlayers: String(cur < n ? cur + 1 : cur - 1) });
    }
  };
  const pickPlayers = async (count: PlayerCount) => {
    await dialTo(count);
    await click(PLAYERS_GO);
  };
  const shot = async (name: string) => { if (process.env.UI_ARTIFACTS) await page.screenshot({ path: `${process.env.UI_ARTIFACTS}/${name}.png` }); };

  await page.waitForFunction(() => document.querySelector('canvas')?.style.opacity === '1', null, { timeout: 90000 });
  await menuOn('main');
  assert.deepEqual(await page.locator('canvas').evaluate((c) => [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height]), [640, 480]);

  // Settings holds the sound controls; nothing before the calibration screen asks for the camera.
  await click(SETTINGS);
  await menuOn('settings');
  await shot('settings');
  assert.equal(await page.evaluate(() => (window as TestWindow).webcamRequests), 0);
  // Graphics → Aspect ratio holds the other shape whatever the window; Auto fits it again.
  const other = mode === 'standard' ? 'widescreen' : 'standard';
  await click(ASPECT(other === 'standard' ? 1 : 2));
  await until({ displayMode: other, menuReady: 'true' });
  await shot('settings-other-aspect');
  const otherFrame = await frameBox();
  const otherDesign = DISPLAY_MODES[other];
  const auto = center(menuLayout(otherDesign.w).ASPECT(0));
  await page.mouse.click(otherFrame.x + (auto.x / otherDesign.w) * otherFrame.width, otherFrame.y + (auto.y / otherDesign.h) * otherFrame.height);
  await until({ displayMode: mode, menuReady: 'true' });
  assert.deepEqual(await page.evaluate(() => localStorage.getItem('aerodance.graphics')), JSON.stringify({ aspect: 'auto', stats: 'off' }));
  frame = await frameBox();
  // Graphics → Stats shows the overlay, which reports its numbers; Off takes it and them away.
  await click(STATS(1));
  await until({ statsMode: 'basic', statsFps: /^\d/ });
  await click(STATS(2));
  await until({ statsMode: 'full' });
  await shot('settings-stats-full');
  await click(STATS(0));
  await page.waitForFunction(() => !('statsMode' in (document.querySelector('canvas')?.dataset ?? {})));
  await click(MENU_BACK);
  await menuOn('main');
  await shot('main-menu');

  // Start -> the dial. Plus and minus stop at 1-4, and every count can start a song.
  await click(START);
  await menuOn('players');
  await shot('player-select');
  assert.equal((await data()).menuPlayers, '2', 'Start opens the dial on 2');
  await dialTo(1);
  await click(MINUS);
  await page.waitForTimeout(200);
  assert.equal((await data()).menuPlayers, '1');
  await dialTo(4);
  await click(PLUS);
  await page.waitForTimeout(200);
  assert.equal((await data()).menuPlayers, '4');
  await shot('player-select-4');
  await click(PLAYERS_GO);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'empty', playerSlots: 'Camera off|Camera off|Camera off|Camera off' });
  await click(BACK);
  await menuOn('players');
  assert.equal((await data()).menuPlayers, '4', 'the dial keeps the count picked last');
  await click(MINUS);
  await until({ menuPlayers: '3' });
  await click(PLAYERS_GO);
  await until({ songScreen: 'list', songReady: 'true', playerSlots: 'Camera off|Camera off|Camera off' });
  await click(BACK);
  await menuOn('players');
  // ...but Start always opens it on 2 again.
  await click(PLAYERS_BACK);
  await menuOn('main');
  await click(START);
  await menuOn('players');
  assert.equal((await data()).menuPlayers, '2', 'Start turns the dial back to 2');

  // One player -> Song Select (empty catalog) -> Back keeps the player screen.
  await pickPlayers(1);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'empty', songCount: '0', playerSlots: 'Camera off' });
  await click(BACK);
  await menuOn('players');
  await pickPlayers(2);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'empty', playerSlots: 'Camera off|Camera off' });
  await shot('song-select');

  // Keyboard: Escape leaves Song Select with the cursor on Let's dance. Left / Right only move
  // the cursor (Let's dance -> plus -> minus), never the count; Enter or Space on minus / plus
  // changes it, and Enter on Let's dance goes on.
  await page.mouse.move(frame.x + 10, frame.y + 10);
  await page.keyboard.press('Escape');
  await menuOn('players');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  assert.equal((await data()).menuPlayers, '2');
  await page.keyboard.press('Enter');
  await until({ menuPlayers: '1' });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press(' ');
  await until({ menuPlayers: '2' });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  assert.equal((await data()).menuPlayers, '2');
  await page.keyboard.press('Enter');
  await until({ songScreen: 'list', songReady: 'true', playerSlots: 'Camera off|Camera off' });

  // The letterboxed frame on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await until({ displayMode: 'standard' });
  const mobile = await frameBox();
  assert.equal(mobile.width, 390);
  assert.ok(Math.abs(mobile.height - (390 * 3) / 4) < 1);
  await shot('song-select-mobile');
  await page.setViewportSize(viewport);
  await until({ displayMode: mode });
  await page.waitForTimeout(300);
  frame = await frameBox();

  // Installed exports through the built catalog and the real HTTP assets, at every player
  // count they support, each opening on its own stage.
  await page.unroute('**/songs/manifest.json');
  const installed = validateCatalog(JSON.parse(await readFile('dist/songs/manifest.json', 'utf8')));
  const openSong = async (count: PlayerCount, index: number) => {
    await click(BACK);
    await menuOn('players');
    await pickPlayers(count);
    await until({ songScreen: 'list', songReady: 'true', catalog: 'ready' });
    await click(rowRect(index));
  };
  for (const [i, song] of installed.songs.slice(0, 4).entries()) {
    for (const count of [1, 2, 3, 4] as const) {
      if (!song.supportedPlayerCounts.includes(count)) continue;
      await openSong(count, i);
      // The preview plays by itself.
      await until({ songScreen: 'preview', songReady: 'true', previewState: 'playing', stage: resolveStage(song.stage), stageReady: 'true' });
      await page.waitForFunction(() => Number(document.querySelector('canvas')?.dataset.previewTimeMs) > 150);
      await shot(`preview-${count}p`);
      await click(BACK);
      await until({ songScreen: 'list', songReady: 'true', stage: '' });
    }
  }

  // Private fixtures cover the exact playable range and song stages, apart from authored music.
  const serveFixture = async (stage?: string | null, fixture: BundleFixture = bundleFixture(), choreography = choreographyBytes(fixture)) => {
    if (stage) fixture.song.stage = stage;
    const songJson = Buffer.from(JSON.stringify(fixture.song));
    const files = new Map([['song.json', songJson], ['choreography.adpose', Buffer.from(choreography)], ['audio.wav', Buffer.from(fixture.audio)]]);
    files.set('checksums.json', Buffer.from(JSON.stringify({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...files].map(([path, body]) => ({ path, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })) })));
    const entry = { ...fixture.entry, sha256: createHash('sha256').update(songJson).digest('hex'), ...(stage ? { stage } : {}) };
    await page.unroute('**/songs/**');
    await page.route('**/songs/**', async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
      const body = name === 'manifest.json' ? Buffer.from(JSON.stringify({ version: 1, songs: [entry] })) : files.get(name);
      await route.fulfill({ status: body ? 200 : 404, contentType: name === 'audio.wav' ? 'audio/wav' : name.endsWith('.adpose') ? 'application/octet-stream' : 'application/json', body: body ?? 'missing' });
    });
  };
  await serveFixture();
  for (const count of [1, 2, 3, 4] as const) {
    await openSong(count, 0);
    await until({ songScreen: 'preview', songReady: 'true', previewState: 'playing', stage: 'openreef', stageReady: 'true' });
    // It plays the playable range (100–900 ms) and loops back to its start.
    await page.waitForFunction(() => Number(document.querySelector('canvas')?.dataset.previewTimeMs) > 700);
    await page.waitForFunction(() => Number(document.querySelector('canvas')?.dataset.previewTimeMs) < 500);
    await until({ previewState: 'playing' });
    if (count === 1) {
      const other = mode === 'standard' ? 'widescreen' : 'standard';
      const otherDesign = DISPLAY_MODES[other];
      const otherDance = gameLayout(otherDesign.w).DANCE;
      await page.setViewportSize(other === 'standard' ? { width: 1024, height: 768 } : { width: 1280, height: 800 });
      await until({ displayMode: other, songScreen: 'preview', stageReady: 'true' });
      await page.waitForFunction((x) => Math.abs((window as TestWindow).danceLabelX - x) < 1,
        (otherDance.x + otherDance.h + 14) * 640 / otherDesign.w);
      await page.setViewportSize(viewport);
      await until({ displayMode: mode, songScreen: 'preview' });
      await page.waitForFunction((x) => Math.abs((window as TestWindow).danceLabelX - x) < 1,
        (DANCE.x + DANCE.h + 14) * 640 / design.w);
      frame = await frameBox();
    }
    await click(BACK);
    await until({ songScreen: 'list', songReady: 'true', stage: '' });
  }

  // A song dances on its own stage (picked in Dance Studio); players can't change it.
  await serveFixture('club');
  await openSong(1, 0);
  await until({ songScreen: 'preview', songReady: 'true', stage: 'club', stageReady: 'true' });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  assert.equal((await data()).stage, 'club');
  await click(BACK);
  await until({ songScreen: 'list', songReady: 'true', stage: '' });
  await click(rowRect(0));
  await until({ songScreen: 'preview', songReady: 'true', stage: 'club', stageReady: 'true' });
  await click(BACK);
  await until({ songScreen: 'list', stage: '' });
  // A stage this build doesn't know falls back to openreef.
  await serveFixture('moon-base');
  await openSong(1, 0);
  await until({ songScreen: 'preview', songReady: 'true', stage: 'openreef', stageReady: 'true' });
  await click(BACK);
  await until({ songScreen: 'list', stage: '' });

  // Dancing with the webcam calibrates first, and the camera is set up right there: pressing
  // the preview starts it (and reports the denial). Three players calibrate side by side.
  await serveFixture();
  await openSong(3, 0);
  await until({ songScreen: 'preview', songReady: 'true', stageReady: 'true' });
  await click(DANCE);
  await until({ gamePhase: 'calibrating', gameReady: 'true', gameCalibrationPlayers: 'missing|missing|missing', gameCalibrationPreview: 'false' }, 30000);
  const requests = await page.evaluate(() => (window as TestWindow).webcamRequests);
  await shot('game-calibration');
  await click(GAME_CALIBRATION_PREVIEW);
  await until({ gameCameraStatus: 'error', gameCameraMessage: /permission was denied/ });
  assert.equal(await page.evaluate(() => (window as TestWindow).webcamRequests), requests + 1);
  assert.equal((await data()).gamePhase, 'calibrating', 'no camera, no countdown');
  await page.keyboard.press('Escape');
  await until({ songScreen: 'list', songReady: 'true' }, 10000);
  assert.equal((await data()).gameCameraStatus, undefined);

  // A whole song with the autoplay ghost (?input=ghost): ready check, countdown, pause and
  // resume, scoring, results, Play again and back to Song Select; then four players. The test
  // routine's own choreography plays over silence.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const routine = new URL('./fixtures/song-70c63c8e/', import.meta.url);
  const song = validateSong(JSON.parse(await readFile(new URL('song.json', routine), 'utf8')));
  song.audio = { path: 'audio.wav', mimeType: 'audio/wav' };
  song.supportedPlayerCounts = [1, 2, 3, 4];
  const routineChoreography = await readFile(new URL('choreography.adpose', routine));
  validateSongChoreography(song, routineChoreography);
  await serveFixture(null, {
    song,
    choreography: bundleFixture().choreography,
    audio: silentWav(song.durationMs),
    entry: { id: song.songId, title: song.title, artist: song.artist, durationMs: song.durationMs, supportedPlayerCounts: song.supportedPlayerCounts, bundleRevision: song.bundleRevision, bundle: `${song.songId}/song.json` },
  }, routineChoreography);
  await page.goto('http://127.0.0.1:4173/?input=ghost');
  await page.locator('canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('canvas')?.style.opacity === '1', null, { timeout: 90000 });
  frame = await frameBox();
  await menuOn('main');
  await click(START);
  await menuOn('players');
  await pickPlayers(2);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'ready', playerSlots: 'Detected|Detected' }, 30000);
  await click(rowRect(0));
  await until({ songScreen: 'preview', songReady: 'true' }, 30000);
  await click(DANCE);
  // Both ghosts are tracked, so the countdown starts by itself.
  await until({ gamePhase: 'countdown' }, 30000);
  await until({ gamePhase: 'playing' }, 10000);
  await page.waitForTimeout(2000);
  await click(GAME_PAUSE);
  await until({ gamePhase: 'paused' }, 5000);
  const pausedAt = Number((await data()).gameTimeMs);
  await page.setViewportSize(mode === 'standard' ? { width: 1280, height: 800 } : { width: 1024, height: 768 });
  await until({ displayMode: mode === 'standard' ? 'widescreen' : 'standard', gamePhase: 'paused' });
  assert.deepEqual(await page.locator('canvas').evaluate((c) => [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height]), [640, 480]);
  await page.setViewportSize(viewport);
  await until({ displayMode: mode, gamePhase: 'paused' });
  frame = await frameBox();
  await page.waitForTimeout(1000);
  assert.equal(Number((await data()).gameTimeMs), pausedAt, 'the song holds while paused');
  await click(GAME_RESUME);
  await until({ gamePhase: 'countdown' }, 5000);
  await until({ gamePhase: 'playing' }, 10000);
  await shot('game-playing');
  await until({ gamePhase: 'results' }, 90000);
  await shot('game-results');
  const scores = ((await data()).gameScores ?? '').split('|').map(Number);
  assert.equal(scores.length, 2);
  for (const score of scores) assert.ok(score > 850000, `the ghost copies the routine: ${score}`);
  await click(RESULTS_RETRY);
  await until({ gamePhase: 'countdown' }, 30000);
  await click(GAME_PAUSE);
  await until({ gamePhase: 'paused' }, 5000);
  await click(GAME_QUIT);
  await until({ songScreen: 'list', songReady: 'true' }, 10000);
  assert.equal((await data()).gamePhase, undefined);

  // Four ghosts: the duet's two parts, each danced twice, all scored.
  await click(BACK);
  await menuOn('players');
  await pickPlayers(4);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'ready', playerSlots: 'Detected|Detected|Detected|Detected' }, 30000);
  await click(rowRect(0));
  await until({ songScreen: 'preview', songReady: 'true' }, 30000);
  await shot('preview-4p-ghost');
  await click(DANCE);
  await until({ gamePhase: 'playing' }, 30000);
  await page.waitForTimeout(2000);
  await shot('game-playing-4p');
  await until({ gamePhase: 'results', resultsScreen: 'stage' }, 90000);
  await shot('game-results-4p');
  const four = ((await data()).gameScores ?? '').split('|').map(Number);
  assert.equal(four.length, 4);
  for (const score of four) assert.ok(score > 850000, `each of four ghosts copies its part: ${score}`);
  await click(RESULTS_SONGS);
  await until({ songScreen: 'list', songReady: 'true' }, 10000);
  assert.deepEqual(errors, []);
  console.log('Browser flow passed: Settings, camera setup and permission denial on the calibration screen, the 1-4 players dial, Back and Escape, keyboard navigation, letterboxing, catalog, bundle loading, finite audio through the mixer, each song on its own stage, a scored two-player song with the autoplay ghost (countdown, pause, resume, results, Play again, quit), a scored four-player ghost song and no runtime errors.');
} catch (error) {
  console.error(error);
  if (testPage) console.error(await testPage.locator('canvas').evaluate((c) => JSON.stringify(c.dataset)).catch(() => ''));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
