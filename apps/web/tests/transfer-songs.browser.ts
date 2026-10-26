// Run after `npm run build`. Settings → Songs → Transfer songs between two copies of the game, each
// in its own browser profile, through the real pairing server: one imports a song and shows its
// code; the other opens the code's QR link (/?transfer=<code>), joins, and receives the song when
// the first sends it, then lists it in Settings and Song Select. Then the other way round: the
// second imports another song and joins the first's code by typing it on the keypad, and sends it.
//
// TRANSFER_TRANSPORT=relay makes the code's side connect through the pairing server's relay, as
// the Apple TV app does (it has no WebRTC). BROWSER_GPU=metal with UI_RENDER=1 renders on the
// Mac's GPU; UI_ARTIFACTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import type { FileChooser } from 'playwright';
import { makeZip } from '../../../packages/pose/zip.ts';
import { createPairingServer } from '../../../packages/pairing/server.ts';
import { menuLayout } from '../src/menu/layout.ts';
import { gameLayout } from '../src/game/layout.ts';
import { DISPLAY_MODES } from '../src/display.ts';
import type { Circle, Rect } from '../src/ui/draw.ts';
import { bundleFixture, silentWav } from './fixtures/songBundle.ts';
import { bundleFiles } from './helpers/customSongs.ts';

const design = DISPLAY_MODES.widescreen;
const { BACK, PLAYERS_BACK, PLAYERS_GO, SETTINGS, SONG_IMPORT, SONG_TRANSFER, SONG_TRASH, START, TRANSFER_LINK } = menuLayout(design.w);
const { BACK: SONGS_BACK } = gameLayout(design.w);
const relayed = process.env.TRANSFER_TRANSPORT === 'relay';
const render = process.env.UI_RENDER === '1';
type Expected = Record<string, string | RegExp>;
type Match = { re: string } | { is: string };

// Two songs, a few seconds of silent audio each (about 100 KB: many pieces).
function songZip(id: string, title: string) {
  const fixture = bundleFixture();
  fixture.song.songId = id;
  fixture.song.title = title;
  fixture.choreography.songId = id;
  fixture.audio = silentWav(6000);
  return Buffer.from(makeZip(new Map([...bundleFiles(fixture)].map(([p, bytes]) => [`${id}/${p}`, bytes]))));
}
const work = await mkdtemp(path.join(tmpdir(), 'aerodance-transfer-'));
const firstZip = path.join(work, 'first.zip'), secondZip = path.join(work, 'second.zip');
await writeFile(firstZip, songZip('first-routine', 'First routine'));
await writeFile(secondZip, songZip('second-routine', 'Second routine'));

const pairing = createPairingServer();
const app = express();
app.use('/pair', (req, res, next) => { pairing.handle(req, res).then((handled) => { if (!handled) next(); }, next); });
// No published songs: Song Select lists only what's been imported or sent.
app.get('/songs/manifest.json', (_req, res) => res.json({ version: 1, songs: [] }));
app.use(express.static('dist'));
const server = app.listen(4185, '127.0.0.1');
server.on('upgrade', (req, socket, head) => {
  req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
  if (!pairing.upgrade(req, socket, head)) socket.destroy();
});
await new Promise((resolve) => server.once('listening', resolve));
const ORIGIN = 'http://127.0.0.1:4185';
const gpu = process.env.BROWSER_GPU === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...gpu, '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] });
const errors: string[] = [];

/** One copy of the game in its own profile (its own saved songs), named by its user agent. */
async function device(name: string, userAgent: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, userAgent });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  if (!render) await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) if (Reflect.get(Type.prototype, fn)) Reflect.set(Type.prototype, fn, () => {});
    }
  });
  let chosen: ((chooser: FileChooser) => void) | null = null;
  page.on('filechooser', (chooser) => chosen?.(chooser));
  let frame = { x: 0, y: 0, width: 1, height: 1 };
  const d = {
    page,
    async load(query = '') {
      await page.goto(`${ORIGIN}/${query}`);
      await page.waitForFunction(() => document.querySelector('canvas')?.style.opacity === '1', null, { timeout: 90000 });
      const box = await page.locator('.canvas-frame').boundingBox();
      assert.ok(box);
      frame = box;
    },
    async click(shape: Rect | Circle) {
      const p = 'w' in shape ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 } : shape;
      await page.mouse.click(frame.x + (p.x / design.w) * frame.width, frame.y + (p.y / design.h) * frame.height);
    },
    async until(expected: Expected, timeout?: number) {
      const entries = Object.entries(expected).map(([k, v]): [string, Match] => [k, v instanceof RegExp ? { re: v.source } : { is: v }]);
      try {
        await page.waitForFunction((list) => {
          const data = document.querySelector('canvas')?.dataset;
          return data && list.every(([k, m]) => ('re' in m ? new RegExp(m.re).test(data[k] ?? '') : data[k] === m.is));
        }, entries, timeout ? { timeout } : undefined);
      } catch (error) {
        const data = await page.evaluate(() => ({ ...document.querySelector('canvas')?.dataset }));
        throw Error(`${name} never had ${JSON.stringify(expected)}: ${JSON.stringify(data)}`, { cause: error });
      }
    },
    data: (key: string) => page.evaluate((k) => document.querySelector('canvas')?.dataset[k] ?? '', key),
    async importZip(file: string) {
      const chooser = new Promise<FileChooser>((resolve) => { chosen = resolve; });
      await d.click(SONG_IMPORT);
      await (await chooser).setFiles([file]);
      chosen = null;
      await d.until({ songImport: 'done', savedSongs: /^[1-9]/ });
    },
    async shot(file: string) { if (process.env.UI_ARTIFACTS) await page.screenshot({ path: `${process.env.UI_ARTIFACTS}/${file}.png` }); },
  };
  return d;
}

try {
  const mac = await device('Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36');
  const phone = await device('iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');

  // The Mac imports a song, then shows its code.
  await mac.load(relayed ? '?transport=relay' : '');
  await mac.until({ menuScreen: 'main', menuReady: 'true' });
  await mac.click(SETTINGS);
  await mac.until({ menuScreen: 'settings', menuReady: 'true', savedSongs: '0' });
  await mac.importZip(firstZip);
  await mac.shot('transfer-settings');
  await mac.click(SONG_TRANSFER);
  await mac.until({ menuScreen: 'transfer', menuReady: 'true', transferStatus: 'waiting', transferCode: /^\d{6}$/, transferSongs: '1' });
  const code = await mac.data('transferCode');
  await mac.shot('transfer-code');

  // The phone opens the QR code's link: the game, joining the code. It comes off the address.
  await phone.load(`?transfer=${code}`);
  await phone.until({ menuScreen: 'transfer', transferStatus: 'connected', transferDevice: 'Mac', transferSongs: '0' });
  assert.equal(new URL(phone.page.url()).search, '');
  await mac.until({ transferStatus: 'connected', transferDevice: 'iPhone', transferTransport: relayed ? 'relay' : 'webrtc' });
  await phone.until({ transferTransport: relayed ? 'relay' : 'webrtc' });

  // The Mac sends it; the phone saves it.
  await mac.click(SONG_TRASH(0));
  await mac.until({ transferSent: '1', transferNotice: 'Sent “First routine” to iPhone.' });
  await phone.until({ transferReceived: '1', transferNotice: 'Received “First routine”.', transferSongs: '1' });
  await mac.shot('transfer-sent');
  await phone.shot('transfer-received');

  // The phone lists it in Settings and Song Select.
  await phone.click(BACK);
  await phone.until({ menuScreen: 'settings', menuReady: 'true', savedSongs: '1' });
  // Leaving the screen ends the transfer: the Mac waits on the same code for another device.
  await mac.until({ transferStatus: 'waiting', transferCode: code });
  await phone.click(BACK);
  await phone.until({ menuScreen: 'main', menuReady: 'true' });
  await phone.click(START);
  await phone.until({ menuScreen: 'players', menuReady: 'true' });
  await phone.click(PLAYERS_GO);
  await phone.until({ songScreen: 'list', songReady: 'true', catalog: 'ready', customSongCount: '1', songCount: '1' });
  await phone.click(SONGS_BACK);
  await phone.until({ menuScreen: 'players', menuReady: 'true' });

  // Then the phone imports another song, types the Mac's code and sends that one back.
  await phone.click(PLAYERS_BACK);
  await phone.until({ menuScreen: 'main', menuReady: 'true' });
  await phone.click(SETTINGS);
  await phone.until({ menuScreen: 'settings', menuReady: 'true', savedSongs: '1' });
  await phone.importZip(secondZip);
  await phone.click(SONG_TRANSFER);
  await phone.until({ menuScreen: 'transfer', transferStatus: 'waiting', transferSongs: '2' });
  await phone.click(TRANSFER_LINK);
  await phone.until({ transferStatus: 'entering', transferMode: 'enter' });
  await phone.page.keyboard.type(code.slice(0, 4));
  await phone.until({ menuReady: 'true' });
  await phone.shot('transfer-keypad');
  await phone.page.keyboard.type(code.slice(4));
  await phone.until({ transferStatus: 'connected', transferDevice: 'Mac' });
  await mac.until({ transferStatus: 'connected', transferDevice: 'iPhone' });
  // The first song is on both now: only the second has a send button, the first's row a tick.
  const rows = await phone.page.evaluate(() => document.querySelector('canvas')?.dataset.transferSongs);
  assert.equal(rows, '2');
  await phone.click(SONG_TRASH(1));
  await mac.until({ transferReceived: '1', transferNotice: 'Received “Second routine”.', transferSongs: '2' });
  await phone.until({ transferSent: '1' });
  await mac.shot('transfer-both');
  // Sending the first again does nothing: the Mac has it (its row has no button).
  await phone.click(SONG_TRASH(0));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await phone.data('transferSent'), '1');

  // The Mac's Songs panel lists both.
  await mac.click(BACK);
  await mac.until({ menuScreen: 'settings', menuReady: 'true', savedSongs: '2' });
  await phone.until({ transferStatus: 'ended' });

  assert.deepEqual(errors, []);
  console.log(`transfer-songs browser test passed (${relayed ? 'relay' : 'WebRTC'})`);
} finally {
  await browser.close();
  pairing.close();
  server.closeAllConnections();
  server.close();
  await rm(work, { recursive: true, force: true });
}
