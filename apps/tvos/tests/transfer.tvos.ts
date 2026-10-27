// Transfer songs with the Apple TV app, end to end from this Mac: the JavaScriptCore app runs in a
// tvOS simulator (or on an Apple TV) and shows its transfer code (Settings → Songs → Transfer
// songs, reached with the remote); the game in Chromium imports a song, opens the code's link and
// sends it. The app has no WebRTC, so it comes through the local pairing server's relay. The app
// saves it in its files and lists it in Settings and Song Select. Then the other way: the page
// removes its copy and joins again, and the app sends the song back.
//
//   node apps/tvos/tests/transfer.tvos.ts [--sim <udid>] [--out <dir>]
//   node apps/tvos/tests/transfer.tvos.ts --device <udid>
//
// Run after npm run build, and node scripts/tvos.ts build --game --sim (or without --sim for a
// device). The site is served on port 4892 (to an Apple TV at this Mac's network address).
// Screenshots go to --out (default .cache/transfer-tvos). CHROMIUM_PATH picks the Chromium.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import type { FileChooser, Page } from 'playwright';
import { createPairingServer } from '../../../packages/pairing/server.ts';
import { makeZip } from '../../../packages/pose/zip.ts';
import { menuLayout } from '../../web/src/menu/layout.ts';
import { DISPLAY_MODES } from '../../web/src/display.ts';
import type { Circle, Rect } from '../../web/src/ui/draw.ts';
import { bundleFixture, silentWav } from '../../web/tests/fixtures/songBundle.ts';
import { bundleFiles } from '../../web/tests/helpers/customSongs.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = path.resolve(option('--out') ?? '.cache/transfer-tvos');
mkdirSync(out, { recursive: true });
const BUNDLE_ID = process.env.TVOS_BUNDLE_ID || 'com.isaacthoman.aerodance';
const PORT = 4892;
const device = option('--device');
const lan = Object.entries(os.networkInterfaces()).filter(([name]) => name.startsWith('en'))
  .flatMap(([, addresses]) => addresses ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address;
const HERE = device ? `http://${lan}:${PORT}` : `http://127.0.0.1:${PORT}`;
const PAGE = `http://127.0.0.1:${PORT}`;

function simulator() {
  const given = option('--sim');
  if (given) return given;
  const list = JSON.parse(spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' }).stdout) as
    { devices: Record<string, { udid: string; name: string; state: string }[]> };
  const tvs = Object.entries(list.devices).filter(([runtime]) => runtime.includes('tvOS')).flatMap(([, devices]) => devices);
  const tv = tvs.find((d) => d.state === 'Booted') ?? tvs.find((d) => d.name === 'aerodance-phone');
  const udid = tv?.udid ?? spawnSync('xcrun', ['simctl', 'create', 'aerodance-phone', 'com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-1080p'], { encoding: 'utf8' }).stdout.trim();
  if (tv?.state !== 'Booted') spawnSync('xcrun', ['simctl', 'boot', udid]);
  return udid;
}
const sim = device ? '' : simulator();
const screenshot = (name: string) => {
  const file = path.join(out, `${name}.png`);
  if (device) spawnSync('xcrun', ['devicectl', 'device', 'capture', 'screenshot', '--device', device, '--destination', file, '--quiet'], { stdio: 'ignore' });
  else spawnSync('xcrun', ['simctl', 'io', sim, 'screenshot', file], { stdio: 'ignore' });
};

// The song the page sends: a few seconds of silent audio (many pieces).
const fixture = bundleFixture();
fixture.song.songId = 'tv-routine';
fixture.song.title = 'TV routine';
fixture.choreography.songId = 'tv-routine';
fixture.audio = silentWav(8000);
const zipPath = path.join(out, 'tv-routine.zip');
writeFileSync(zipPath, makeZip(new Map([...bundleFiles(fixture)].map(([p, bytes]) => [`tv-routine/${p}`, bytes]))));

type Report = { type: string; fps?: number; dataset?: Record<string, string> };
const reports: Report[] = [];
let tv: Record<string, string> = {};
const pairing = createPairingServer();
const app = express();
app.post('/__report', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  res.end();
  try {
    const report = JSON.parse(req.body as string) as Report;
    reports.push(report);
    if (report.dataset) tv = report.dataset;
  } catch { /* Not a report. */ }
});
app.use('/pair', (req, res, next) => { pairing.handle(req, res).then((handled) => { if (!handled) next(); }, next); });
app.use(express.static('dist'));
const server = app.listen(PORT, device ? '0.0.0.0' : '127.0.0.1');
server.on('upgrade', (req, socket, head) => {
  req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
  if (!pairing.upgrade(req, socket, head)) socket.destroy();
});
await new Promise((resolve) => server.once('listening', resolve));

const started = Date.now();
const log = (text: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${text}`);
/**
 * Waits until a report from the app (it reports every 2 s) passes `check`: one from report number
 * `since` on (by default, the latest), so a state that came and went since then counts too.
 */
async function tvUntil(what: string, check: (d: Record<string, string>) => boolean, since = Math.max(0, reports.length - 1), timeoutMs = device ? 120_000 : 600_000) {
  const start = Date.now();
  while (!reports.slice(since).some((r) => r.dataset && check(r.dataset))) {
    if (Date.now() - start > timeoutMs) throw Error(`Timed out waiting for the Apple TV app: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`Apple TV: ${what}`);
}
const progress = setInterval(() => {
  log(`… ${['menuScreen', 'menuReady', 'savedSongs', 'transferStatus', 'transferCode', 'transferDevice', 'transferSent', 'transferReceived', 'transferNotice'].map((k) => `${k}=${tv[k] ?? ''}`).join(' ')}`);
}, 15_000);

// The remote: Settings (Down to Start, Down to Settings), then Up, which from no cursor lands on
// the last widget there, Transfer songs. Then, once the song has come and the page has joined
// again without it, Up to the song's send button (the last widget) and send it back. Then Menu
// back to Settings and the main screen, on to Song Select, and back to Settings to remove it.
const wait = (state: Record<string, string>) => ['wait', state, 900_000];
const drive = [
  wait({ menuScreen: 'main', menuReady: 'true' }), ['sleep', 1000], ['key', 'ArrowDown'], ['key', 'ArrowDown'], ['key', 'Enter'],
  wait({ menuScreen: 'settings', menuReady: 'true', savedSongs: '0' }), ['sleep', 500], ['key', 'ArrowUp'], ['key', 'Enter'],
  wait({ menuScreen: 'transfer', menuReady: 'true', transferStatus: 'waiting' }),
  wait({ transferReceived: '1' }), wait({ transferStatus: 'waiting' }), wait({ transferStatus: 'connected', transferDevice: 'Mac' }),
  ['sleep', 3000], ['key', 'ArrowUp'], ['key', 'Enter'],
  // Each state the test checks stays a report or two (they come every 2 s).
  wait({ transferSent: '1' }), ['sleep', 4000], ['key', 'Escape'],
  wait({ menuScreen: 'settings', menuReady: 'true', savedSongs: '1' }), ['sleep', 4000], ['key', 'Escape'],
  // Back on the main screen the cursor is on Settings (where it left): Up to Start.
  wait({ menuScreen: 'main', menuReady: 'true' }), ['sleep', 500], ['key', 'ArrowUp'], ['key', 'Enter'],
  wait({ menuScreen: 'players', menuReady: 'true' }), ['sleep', 500], ['key', 'Enter'],
  wait({ songScreen: 'list', songReady: 'true', catalog: 'ready', customSongCount: '1' }), ['sleep', 4000],
  // Back to Settings (the cursor returns to Start, then Down to Settings), Up twice to the song's
  // remove button (before Transfer songs), and two presses remove it (there are no dialogs).
  ['key', 'Escape'], wait({ menuScreen: 'players', menuReady: 'true' }), ['sleep', 500], ['key', 'Escape'],
  wait({ menuScreen: 'main', menuReady: 'true' }), ['sleep', 500], ['key', 'ArrowDown'], ['key', 'Enter'],
  wait({ menuScreen: 'settings', menuReady: 'true', savedSongs: '1' }), ['sleep', 500], ['key', 'ArrowUp'], ['key', 'ArrowUp'], ['key', 'Enter'],
  wait({ songRemoving: 'tv-routine' }), ['sleep', 2500], ['key', 'Enter'],
  wait({ savedSongs: '0' }),
];
const lite = '?aeroHide=sky,ground,city,lake,lamps,trees,traffic,grass,flowers,tulips,windmills,butterflies,birds,balloons,clouds,bubbles,sparkles,jet,flare,shadows,reflection&diag=nodancers,nobloom,nostageshadows';
const config = { script: 'game.js', url: `http://aerodance.local/${device ? '' : lite}`, site: HERE, fit: 'fill', pixelated: true,
  label: 'transfer-tvos', report: `${HERE}/__report`, drive };
const appLog: string[] = [];
const appPath = `apps/tvos/build/Build/Products/Release-${device ? 'appletvos' : 'appletvsimulator'}/aerodance.app`;
const launch = device
  ? () => {
    assert.equal(spawnSync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, '--quiet', appPath], { stdio: 'inherit' }).status, 0, 'install the app (node scripts/tvos.ts build --game first)');
    return spawn('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, '--terminate-existing', '--quiet', BUNDLE_ID, '--config', JSON.stringify(config)], { stdio: 'ignore' });
  }
  : () => {
    spawnSync('xcrun', ['simctl', 'terminate', sim, BUNDLE_ID], { stdio: 'ignore' });
    // A fresh install: no songs from an earlier run.
    spawnSync('xcrun', ['simctl', 'uninstall', sim, BUNDLE_ID], { stdio: 'ignore' });
    assert.equal(spawnSync('xcrun', ['simctl', 'install', sim, appPath], { stdio: 'inherit' }).status, 0, 'install the app (node scripts/tvos.ts build --game --sim first)');
    const child = spawn('xcrun', ['simctl', 'launch', '--console-pty', sim, BUNDLE_ID, '--config', JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => appLog.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => appLog.push(d.toString()));
    return child;
  };
const appProcess = launch();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
const design = DISPLAY_MODES.widescreen;
const { BACK, SETTINGS, SONG_IMPORT, SONG_TRASH } = menuLayout(design.w);
let page: Page | null = null;
let frame = { x: 0, y: 0, width: 1, height: 1 };
let chosen: ((chooser: FileChooser) => void) | null = null;
const click = async (shape: Rect | Circle) => {
  const p = 'w' in shape ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 } : shape;
  await page!.mouse.click(frame.x + (p.x / design.w) * frame.width, frame.y + (p.y / design.h) * frame.height);
};
const pageState = () => page!.evaluate(() => ({ ...document.querySelector('canvas')?.dataset }) as Record<string, string>);
async function pageUntil(want: Record<string, string>) {
  const start = Date.now();
  for (;;) {
    const state = await pageState();
    if (Object.entries(want).every(([k, v]) => state[k] === v)) break;
    if (Date.now() - start > 300_000) throw Error(`Timed out waiting for the page: ${JSON.stringify(want)} (${JSON.stringify(state)})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`page: ${JSON.stringify(want)}`);
}
async function load(query = '') {
  await page!.goto(`${PAGE}/${query}`);
  await page!.waitForFunction(() => document.querySelector('canvas')?.style.opacity === '1', null, { timeout: 120_000 });
  const box = await page!.locator('.canvas-frame').boundingBox();
  assert.ok(box);
  frame = box;
}

try {
  await tvUntil('its transfer code', (d) => d.menuScreen === 'transfer' && d.transferStatus === 'waiting' && /^\d{6}$/.test(d.transferCode ?? ''));
  const code = tv.transferCode;
  screenshot('1-code');

  // The page (a Mac) imports the song, then opens the code's link and sends it.
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' });
  page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('filechooser', (chooser) => chosen?.(chooser));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) if (Reflect.get(Type.prototype, fn)) Reflect.set(Type.prototype, fn, () => {});
    }
  });
  await load();
  await pageUntil({ menuScreen: 'main', menuReady: 'true' });
  await click(SETTINGS);
  await pageUntil({ menuScreen: 'settings', menuReady: 'true', savedSongs: '0' });
  const chooser = new Promise<FileChooser>((resolve) => { chosen = resolve; });
  await click(SONG_IMPORT);
  await (await chooser).setFiles([zipPath]);
  await pageUntil({ songImport: 'done', savedSongs: '1' });
  await load(`?transfer=${code}`);
  await pageUntil({ menuScreen: 'transfer', transferStatus: 'connected', transferDevice: 'Apple TV', transferTransport: 'relay' });
  await tvUntil('connected to the Mac through the relay', (d) => d.transferStatus === 'connected' && d.transferDevice === 'Mac' && d.transferTransport === 'relay');
  await click(SONG_TRASH(0));
  await pageUntil({ transferSent: '1', transferNotice: 'Sent “TV routine” to Apple TV.' });
  await tvUntil('received the song', (d) => d.transferReceived === '1' && d.transferSongs === '1' && d.transferNotice === 'Received “TV routine”.');
  screenshot('2-received');

  // The page removes its copy (leaving the screen ends the transfer; the app waits again).
  await click(BACK);
  await pageUntil({ menuScreen: 'settings', menuReady: 'true', savedSongs: '1' });
  await tvUntil('waiting again', (d) => d.transferStatus === 'waiting');
  await click(SONG_TRASH(0));
  await pageUntil({ savedSongs: '0' });
  // It joins again, and the app sends the song back.
  const rejoined = reports.length;
  await load(`?transfer=${code}`);
  await pageUntil({ menuScreen: 'transfer', transferStatus: 'connected', transferSongs: '0' });
  await pageUntil({ transferReceived: '1', transferNotice: 'Received “TV routine”.', transferSongs: '1' });
  await tvUntil('sent it back', (d) => d.transferSent === '1', rejoined);
  screenshot('3-sent-back');

  // The app lists it in Settings and Song Select.
  await tvUntil('listed in Settings', (d) => d.menuScreen === 'settings' && d.savedSongs === '1', rejoined);
  screenshot('4-settings');
  await tvUntil('listed in Song Select', (d) => d.songScreen === 'list' && d.catalog === 'ready' && d.customSongCount === '1');
  screenshot('5-song-select');
  const listed = reports.length;
  await tvUntil('asked for a second press to remove it', (d) => d.songRemoving === 'tv-routine' && /Press again/.test(d.songNotice ?? ''), listed);
  screenshot('6-remove');
  await tvUntil('removed it', (d) => d.menuScreen === 'settings' && d.savedSongs === '0', listed);

  console.log(`Apple TV transfer passed (${device ? 'on an Apple TV' : 'in the tvOS simulator'}, through a local relay):`,
    JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), screenshots: out }));
  assert.deepEqual(errors, []);
} catch (error) {
  console.error('Apple TV state:', JSON.stringify(tv));
  console.error('Page state:', page ? JSON.stringify(await pageState().catch(() => ({}))) : '');
  console.error('Errors:', errors);
  if (appLog.length) console.error('App log (tail):', appLog.join('').split('\n').slice(-40).join('\n'));
  screenshot('failure');
  process.exitCode = 1;
  console.error(error);
} finally {
  writeFileSync(path.join(out, 'reports.ndjson'), reports.map((r) => JSON.stringify(r)).join('\n') + '\n');
  clearInterval(progress);
  appProcess.kill();
  if (!device) spawnSync('xcrun', ['simctl', 'terminate', sim, BUNDLE_ID], { stdio: 'ignore' });
  await browser.close();
  pairing.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
