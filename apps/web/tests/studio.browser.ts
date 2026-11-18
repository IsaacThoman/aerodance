// aerodance studio (apps/web/src/studio, at /studio/ in the build) from start to finish in Chromium,
// with a synthetic camera that the real bundled MediaPipe tracks: a new dance, its music (a silent
// MP3 made here) and tempo, a recorded take, a decision in Fix and a dragged joint, a scored
// playtest, and Add to the game, after which the game at / has the song in its saved custom songs.
// Run after `npm run build`. UI_GPU=1 (with UI_ANGLE=metal on a Mac) renders on the GPU;
// UI_RENDER=1 draws the WebGL scenes instead of skipping them.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { chromiumPath } from '../../../scripts/chromium.ts';

const index = path.resolve('dist/studio/index.html');
assert.ok(existsSync(index), `${index} is missing: run \`npm run build\` first`);

/** Silence as constant-bitrate MPEG-1 Layer III (128 kbps, 44.1 kHz): 417-byte frames, about 38.28 a second. */
function silentMp3(seconds: number): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat(Array.from({ length: Math.ceil(seconds * 44100 / 1152) }, () => frame));
}

const app = express();
app.get('/pose-fixture.jpg', (_req, res) => res.sendFile(path.resolve('apps/web/tests/fixtures/mediapipe-pose.jpg'), { dotfiles: 'allow' }));
app.use(express.static('dist'));
const server = app.listen(4186, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:4186';
const graphics = process.env.UI_GPU === '1'
  ? ['--enable-gpu', '--use-gl=angle', `--use-angle=${process.env.UI_ANGLE || 'gl'}`, '--disable-gpu-sandbox', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ executablePath: chromiumPath(false), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...graphics] });
const errors: string[] = [];
let page: Page | undefined;
const started = Date.now();
const step = (text: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const studio = page = await context.newPage();
  studio.setDefaultTimeout(90_000);
  studio.on('pageerror', error => { if (errors.length < 2) console.error('Browser error:', error.stack); errors.push(error.message); });
  await studio.addInitScript(skipDraws => {
    // Flow assertions only: the coach views' WebGL draws are skipped (as in ui-flow.browser.ts).
    // MediaPipe's worker has its own WebGL prototypes and still runs the real model.
    if (skipDraws) for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'])
        if (Reflect.get(Type.prototype, name)) Reflect.set(Type.prototype, name, () => {});
    }
    // A camera that sees one person head to toe, swaying slightly (as in webcam.browser.ts).
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fixture-camera', label: 'Fixture camera' }],
      getUserMedia: async () => {
        const image = new Image(); image.src = '/pose-fixture.jpg'; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const g = canvas.getContext('2d');
        if (!g) throw Error('2D canvas unavailable');
        let count = 0;
        const draw = () => {
          g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480);
          g.drawImage(image, 200, 0, 600, 667, 140 + Math.sin(count++ / 20) * 8, 40, 360, 400);
        };
        draw();
        const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
        for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); }; }
        return stream;
      },
    } });
  }, process.env.UI_RENDER !== '1');

  /** What a data-* value must be: exactly a string, matching a pattern, or a number at least or below a bound. */
  type Want = string | RegExp | { atLeast: number } | { below: number };
  /** Waits until the Studio's root element reports every key (data-*) as wanted. */
  const until = (want: Record<string, Want>, timeout?: number) => studio.waitForFunction(want => {
    const data = document.querySelector<HTMLElement>('.studio')?.dataset;
    return !!data && want.every(([key, w]) => {
      const v = data[key] ?? '';
      return typeof w === 'string' ? v === w : 'source' in w ? new RegExp(w.source).test(v)
        : v !== '' && ('atLeast' in w ? Number(v) >= w.atLeast : Number(v) < w.below);
    });
  }, Object.entries(want).map(([key, w]) => [key, w instanceof RegExp ? { source: w.source } : w] as const), { timeout });
  const atLeast = (n: number) => ({ atLeast: n }), below = (n: number) => ({ below: n });
  const data = async () => studio.locator('.studio').evaluate(el => ({ ...(el as HTMLElement).dataset }));
  const revision = async () => Number((await data()).revision);
  const goTo = async (station: string) => {
    await studio.locator(`.station-tab[data-station=${station}]`).click();
    await until({ station, ready: 'true' });
  };

  // 1. The library starts empty; a new dance gets its title in the dialog and opens at Song.
  await studio.goto(`${origin}/studio/`);
  await until({ screen: 'library', ready: 'true', projects: '0' });
  await studio.getByText('No dances yet').waitFor();
  await studio.getByRole('button', { name: 'New dance', exact: true }).click();
  await studio.getByLabel('Song title').fill('Studio test');
  await studio.getByRole('button', { name: 'Start', exact: true }).click();
  await until({ screen: 'project', station: 'song', audio: 'none' });
  assert.equal(await studio.locator('.project-name strong').textContent(), 'Studio test');
  step('Library: empty, a new dance made');

  // 2. The music: a 20-second silent MP3. Silence has no beat, so the tempo is typed in.
  await studio.locator('input[type=file][accept*=".mp3"]').setInputFiles({ name: 'studio-test.mp3', mimeType: 'audio/mpeg', buffer: silentMp3(20) });
  await until({ audio: 'ready', error: '' });
  await studio.getByText(/No steady beat stood out|Found the beat|Best guess/).waitFor();
  const beforeTempo = await revision();
  await studio.getByLabel('Tempo (BPM)').fill('120');
  await studio.getByLabel('Tempo (BPM)').press('Enter');
  await until({ revision: atLeast(beforeTempo + 1) });
  step(`Song: music ready, tempo set (revision ${beforeTempo} → ${await revision()})`);

  // 3. Record: the camera sees the person, Record counts in a bar, and a few seconds are kept.
  await goTo('record');
  await studio.getByRole('button', { name: 'Turn the camera on', exact: true }).click();
  await studio.getByText('You\'re in view.').waitFor({ timeout: 180_000 });
  await studio.locator('.rec-controls[data-ready=true]').waitFor({ timeout: 60_000 });
  step('Record: the camera sees the person');
  await studio.locator('.rec-controls .rec-go').click();
  await studio.locator('.rec-controls[data-phase=recording]').waitFor();
  // A bar of 120 BPM counts in for two seconds; then four seconds of dancing.
  await studio.waitForFunction(() => Number(document.querySelector<HTMLElement>('.studio')?.dataset.time) >= 4500, undefined, { timeout: 60_000 });
  await studio.locator('.rec-controls .rec-go').click();
  await studio.locator('.rec-controls[data-phase=idle]').waitFor({ timeout: 60_000 });
  await until({ takes: atLeast(1), clips: atLeast(1), busy: '' });
  const recorded = await data();
  assert.equal(recorded.error, '', 'recording raised no error');
  step(`Record: ${recorded.takes} take, ${recorded.clips} clip (${await studio.locator('.rec-controls .note').allInnerTexts().then(t => t.join(' '))})`);

  // 4. Fix: an item settled with its own button, then a joint dragged in the pose editor.
  await goTo('fix');
  await studio.locator('.inbox-state[data-ready=true]').waitFor();
  await until({ issues: /^\d+$/ });
  let issues = Number((await data()).issues);
  if (issues > 0) {
    // The first item a decision settles (not one only dancing it again does).
    let settled = '';
    for (let i = 0; i < issues && !settled; i++) {
      const item = studio.locator('.inbox-state > .inbox > .inbox-item').nth(i);
      if ((await item.getAttribute('class'))?.includes(' open') !== true) await item.locator('.inbox-row').click();
      const action = item.locator('.inbox-body .button-row button').filter({ hasNotText: /^Record/ }).first();
      if (await action.count()) {
        settled = `${await item.getAttribute('data-kind')}: ${await action.innerText()}`;
        await action.click();
      }
    }
    assert.ok(settled, 'an item in the inbox has a decision to settle it');
    await until({ issues: below(issues) });
    step(`Fix: settled ${settled} (${issues} → ${(await data()).issues} to look at)`);
    issues = Number((await data()).issues);
  } else step('Fix: nothing to look at');
  // Drag a wrist: the pose editor reports each handle's page position (data-joints) while paused.
  const editor = studio.locator('.pose-editor[data-joints]');
  await editor.waitFor();
  const beforeDrag = await revision();
  const joints = JSON.parse(await editor.getAttribute('data-joints') ?? '{}') as Record<string, [number, number]>;
  const joint = 'leftWrist' in joints ? 'leftWrist' : Object.keys(joints)[0];
  assert.ok(joint, 'the pose editor shows handles');
  const [x, y] = joints[joint];
  await studio.mouse.move(x, y);
  await studio.mouse.down();
  await studio.mouse.move(x + 20, y - 30, { steps: 6 });
  await studio.mouse.up();
  await until({ revision: atLeast(beforeDrag + 1) });
  step(`Fix: dragged the ${joint} (revision ${beforeDrag} → ${await revision()})`);

  // 5. Playtest: the whole song (20 s) danced with the camera, scored and kept.
  await goTo('playtest');
  const overlay = studio.locator('.playtest-overlay');
  // The stretch settled in Fix is still selected, and it's the part left unscored: the station
  // won't start on a stretch with nothing to score, so dance everything instead.
  await studio.locator('.playtest-reason').filter({ hasText: 'Nothing in the selected stretch is scored' }).waitFor({ timeout: 120_000 });
  await studio.getByRole('button', { name: 'Dance it all', exact: true }).click();
  await studio.locator('.playtest-overlay[data-can-start=true]').waitFor({ timeout: 120_000 });
  await studio.locator('.playtest-start').click();
  await studio.locator('.playtest-overlay[data-phase]:not([data-phase=idle])').waitFor().catch(() => {});
  await studio.locator('.playtest-overlay[data-ended=saved]').waitFor({ timeout: 120_000 });
  await studio.waitForFunction(() => /^\d+$/.test(document.querySelector<HTMLElement>('li[data-attempt]')?.dataset.accuracy ?? ''), undefined, { timeout: 60_000 });
  assert.ok(Number(await overlay.getAttribute('data-attempts')) >= 1, 'an attempt was kept');
  const accuracy = await studio.locator('li[data-attempt]').first().getAttribute('data-accuracy');
  assert.match(await studio.locator('li[data-attempt] em').first().innerText(), /\d+%/, 'the attempt shows its accuracy');
  // The person the camera sees is the one who recorded the routine, standing as they stood then.
  assert.ok(Number(accuracy) >= 60, `dancing the routine as recorded earns most of its points (${accuracy}%)`);
  step(`Playtest: an attempt kept, ${accuracy}% of the points`);

  // 6. Share: the artist named, then Add to the game; the game at / then has it saved.
  await goTo('share');
  const beforeArtist = await revision();
  await studio.locator('[data-share-field=artist]').fill('Test Artist');
  await studio.locator('[data-share-field=artist]').press('Tab');
  await until({ revision: atLeast(beforeArtist + 1) });
  await studio.locator('.share-side[data-share=ready]').waitFor({ timeout: 60_000 });
  await studio.locator('[data-share-action=add]').click();
  await studio.locator('.share-side[data-in-game=current]').waitFor({ timeout: 120_000 });
  await studio.getByText('It\'s in the game on this device').waitFor();
  const songId = await studio.locator('.share-side').getAttribute('data-song-id');
  assert.ok(songId, 'the share station names the song it added');
  step(`Share: added to the game as ${songId}`);

  await studio.goto(`${origin}/`);
  await studio.waitForFunction(() => document.querySelector('canvas')?.dataset.menuReady === 'true');
  const saved = await studio.evaluate(() => new Promise<{ id: string; title: string; artist: string }[]>((resolve, reject) => {
    const request = indexedDB.open('aerodance-custom-songs');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const all = request.result.transaction('songs').objectStore('songs').getAll();
      all.onsuccess = () => { request.result.close(); resolve((all.result as { id: string; entry: { title: string; artist: string } }[]).map(s => ({ id: s.id, title: s.entry.title, artist: s.entry.artist }))); };
      all.onerror = () => reject(all.error);
    };
  }));
  assert.deepEqual(saved, [{ id: songId, title: 'Studio test', artist: 'Test Artist' }], 'the game keeps the song the Studio added');
  step('Game: the song is among its saved custom songs');

  assert.deepEqual(errors, []);
  console.log(`Studio browser flow passed in ${((Date.now() - started) / 1000).toFixed(0)} s: new dance, music and tempo, a recorded take, a Fix decision and a dragged joint, a scored playtest, and the song in the game.`);
} catch (error) {
  if (page) {
    console.error('Studio state:', await page.locator('.studio').evaluate(el => JSON.stringify((el as HTMLElement).dataset)).catch(() => ''));
    console.error('Studio notes:', await page.locator('.note, [role=status], [role=alert]').allInnerTexts().catch(() => []));
    // STUDIO_TEST_SHOTS=<folder> keeps a screenshot of the page as it failed.
    if (process.env.STUDIO_TEST_SHOTS) await page.screenshot({ path: path.join(process.env.STUDIO_TEST_SHOTS, 'studio-browser-failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
