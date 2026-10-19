// A phone as the Apple TV app's camera, end to end from this Mac: the JavaScriptCore app runs in
// a tvOS simulator (or on an Apple TV), and a phone page in Chromium (a synthetic portrait camera
// and the real MediaPipe model) pairs with it through a local pairing server. The app has no
// WebRTC, so the phone's poses and preview pictures come through the server's relay.
//
//   node client-tvos/jsc/tests/phone.tvos.ts [--sim <udid>] [--out <dir>]
//   node client-tvos/jsc/tests/phone.tvos.ts --device <udid>
//
// Run after npm run build, and node scripts/tvos-jsc.ts build --game --sim (or without --sim for
// a device). The simulator draws OpenGL ES in software, at about a frame a second, so there the
// test pairs in Connect Client with the 3D world left out: pairing, the relayed poses and
// preview pictures, and a phone that reloads. On an Apple TV it plays the whole game from the
// phone: calibration with the phone's picture, a song scored from its poses, and the phone
// reloading. The site is served on port 4891 (to the Apple TV at this Mac's network address).
// Screenshots go to --out (default .cache/phone-tvos). CHROMIUM_PATH picks the Chromium.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { createPairingServer } from '../../../packages/pairing/server.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = path.resolve(option('--out') ?? '.cache/phone-tvos');
mkdirSync(out, { recursive: true });
const BUNDLE_ID = process.env.TVOS_BUNDLE_ID || 'com.isaacthoman.aerodance.tv.jsc';
const PORT = 4891;
const device = option('--device');
// This Mac's address on its Wi-Fi or Ethernet (en*), not a virtual machine's bridge.
const lan = Object.entries(os.networkInterfaces()).filter(([name]) => name.startsWith('en'))
  .flatMap(([, addresses]) => addresses ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address;
// The app reaches the site at this Mac's address (an Apple TV) or its loopback (the simulator
// shares the Mac's network); the phone page, on this Mac, always at loopback.
const SITE = device ? `http://${lan}:${PORT}` : `http://127.0.0.1:${PORT}`;
const LOCAL = `http://127.0.0.1:${PORT}`;

/** The simulator to use: --sim, else a booted Apple TV, else a new one (booted). */
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

// The site: the game's build, its pairing server (relay included) and where the app reports.
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
app.get('/pose-fixture.jpg', (_req, res) => res.sendFile(path.resolve('client/tests/fixtures/mediapipe-pose.jpg'), { dotfiles: 'allow' }));
app.use(express.static('dist'));
const server = app.listen(PORT, device ? '0.0.0.0' : '127.0.0.1');
server.on('upgrade', (req, socket, head) => {
  req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
  if (!pairing.upgrade(req, socket, head)) socket.destroy();
});
await new Promise((resolve) => server.once('listening', resolve));

const started = Date.now();
const log = (text: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${text}`);
/** Waits until the app's reported state passes `check` (it reports every 2 s). */
async function tvUntil(what: string, check: (d: Record<string, string>) => boolean, timeoutMs = device ? 120_000 : 600_000) {
  const start = Date.now();
  while (!check(tv)) {
    if (Date.now() - start > timeoutMs) throw Error(`Timed out waiting for the Apple TV app: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`Apple TV: ${what}`);
}
const progress = setInterval(() => {
  const last = reports.at(-1);
  log(`… ${last?.fps ?? '?'} fps · ${['menuScreen', 'connectOpen', 'connectStatus', 'connectVideo', 'gamePhase', 'gameCalibrationProgress'].map((k) => `${k}=${tv[k] ?? ''}`).join(' ')}`);
}, 15_000);

// Drives the app like a Siri Remote, waiting on its state between presses.
const wait = (state: Record<string, string>) => ['wait', state, 900_000];
const toConnectClient = [
  wait({ menuScreen: 'main', menuReady: 'true' }), ['sleep', 1000],
  // Settings (two down from nothing focused), then the status pill above it opens Connect Client,
  // where the camera is the phone (the app has no webcam) and Enter starts pairing.
  ['key', 'ArrowDown'], ['sleep', 300], ['key', 'ArrowDown'], ['sleep', 300], ['key', 'Enter'],
  wait({ menuScreen: 'settings', menuReady: 'true' }), ['sleep', 1000], ['key', 'ArrowUp'], ['sleep', 300], ['key', 'Enter'],
  wait({ connectOpen: 'true', connectReady: 'true' }), ['sleep', 1000], ['key', 'Enter'],
];
const toCalibration = [
  wait({ menuScreen: 'main', menuReady: 'true' }), ['sleep', 1000], ['key', 'Enter'],
  wait({ menuScreen: 'players', menuReady: 'true' }), ['sleep', 500], ['key', 'Enter'],
  wait({ songScreen: 'list', songReady: 'true', catalog: 'ready' }), ['sleep', 500], ['key', 'Enter'],
  wait({ songScreen: 'preview', previewState: 'playing', stageReady: 'true' }), ['sleep', 3000], ['key', 'Enter'],
  // The calibration screen: Enter starts the camera, which for the phone is pairing.
  wait({ gamePhase: 'calibrating', gameReady: 'true' }), ['sleep', 1000], ['key', 'Enter'],
];
// The simulator leaves the 3D world out, to keep its software renderer's frames short.
const lite = '&aeroHide=sky,ground,city,lake,lamps,trees,traffic,grass,flowers,tulips,windmills,butterflies,birds,balloons,clouds,bubbles,sparkles,jet,flare,shadows,reflection&diag=nodancers';
const config = { script: 'game.js', url: `http://aerodance.local/?quality=tv${device ? '' : lite}`, site: SITE, fit: 'fill', pixelated: true,
  label: 'phone-tvos', report: `${SITE}/__report`, drive: device ? toCalibration : toConnectClient };
const appLog: string[] = [];
const appPath = `client-tvos/jsc/build/Build/Products/Release-${device ? 'appletvos' : 'appletvsimulator'}/aerodance.app`;
const launch = device
  ? () => {
    assert.equal(spawnSync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, '--quiet', appPath], { stdio: 'inherit' }).status, 0, 'install the app (node scripts/tvos-jsc.ts build --game first)');
    return spawn('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, '--terminate-existing', '--quiet', BUNDLE_ID, '--config', JSON.stringify(config)], { stdio: 'ignore' });
  }
  : () => {
    spawnSync('xcrun', ['simctl', 'terminate', sim, BUNDLE_ID], { stdio: 'ignore' });
    assert.equal(spawnSync('xcrun', ['simctl', 'install', sim, appPath], { stdio: 'inherit' }).status, 0, 'install the app (node scripts/tvos-jsc.ts build --game --sim first)');
    const child = spawn('xcrun', ['simctl', 'launch', '--console-pty', sim, BUNDLE_ID, '--config', JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => appLog.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => appLog.push(d.toString()));
    return child;
  };
const appProcess = launch();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
let phone: Page | null = null;

/** A phone page with a synthetic portrait camera (one dancer), as client/tests/phone.browser.ts has. */
async function openPhone(url: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  page.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
  await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) if (Reflect.get(Type.prototype, name)) Reflect.set(Type.prototype, name, () => {});
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fixture-camera', label: 'Fixture camera' }],
      getUserMedia: async () => {
        const image = new Image(); image.src = '/pose-fixture.jpg'; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 640;
        const g = canvas.getContext('2d'); let count = 0;
        if (!g) throw Error('2D canvas unavailable');
        const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 480, 640); g.drawImage(image, 200, 0, 600, 667, 40 + Math.sin(count++ / 20) * 2, 80, 400, 445); };
        draw(); const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
        for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); }; }
        return stream;
      },
    } });
  });
  await page.goto(url);
  return page;
}
const phoneState = (key: string) => phone?.locator('canvas').evaluate((c, key) => (c as HTMLCanvasElement).dataset[key] ?? '', key) ?? Promise.resolve('');
async function phoneUntil(key: string, value: string) {
  const start = Date.now();
  while ((await phoneState(key)) !== value) {
    if (Date.now() - start > 120_000) throw Error(`Timed out waiting for the phone: ${key}=${value}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`phone: ${key}=${value}`);
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fpsWhile = (check: (d: Record<string, string>) => boolean) => reports.filter((r) => r.type === 'game' && r.dataset && check(r.dataset) && r.fps).map((r) => r.fps as number);

try {
  const codeKey = device ? 'gamePairing' : 'connectPairing';
  await tvUntil('a pairing code', (d) => /^\d{6}$/.test(d[codeKey] ?? ''));
  const code = tv[codeKey];
  screenshot('1-pairing');
  // The phone opens the QR code's link (/phone/#code on the site).
  phone = await openPhone(`${LOCAL}/phone/#${code}`);
  await phoneUntil('phoneStage', 'linked');
  await phoneUntil('phoneCameraStatus', 'connected');
  await tvUntil('the phone connected, tracking', (d) => d.connectStatus === 'connected' && /poses\/s/.test(d.connectMessage ?? ''));
  const videoKey = device ? 'gameCalibrationVideo' : 'connectVideo';
  await tvUntil('the phone’s picture in the preview', (d) => d[videoKey] === 'true');
  assert.equal(await phoneState('phoneVideo'), 'true', 'the phone sends pictures while the app previews');
  await pause(device ? 1500 : 8000);
  screenshot('2-preview');

  if (device) {
    await tvUntil('calibrated, counting down', (d) => d.gamePhase === 'countdown' || d.gamePhase === 'playing');
    await phoneUntil('phoneVideo', 'false');
    await tvUntil('playing from the phone’s poses', (d) => d.gamePhase === 'playing');
    await pause(8000);
    screenshot('3-playing');
    await tvUntil('the song’s results', (d) => d.gamePhase === 'results', 120_000);
    assert.ok(Number(tv.gameScores?.split(',')[0] ?? 0) > 0, `scored from the phone's poses (${tv.gameScores})`);
    await pause(2000);
    screenshot('4-results');
  }

  // The phone reloads (its browser was put away): the app loses it, then gets it back.
  await phone.reload();
  await tvUntil('lost the phone', (d) => ['connecting', 'initializing'].includes(d.connectStatus ?? ''));
  await phoneUntil('phoneStage', 'linked');
  await tvUntil('the phone back, tracking', (d) => d.connectStatus === 'connected' && /poses\/s/.test(d.connectMessage ?? ''));
  if (!device) {
    await tvUntil('its picture back', (d) => d.connectVideo === 'true');
    screenshot('3-relinked');
  }

  const playing = fpsWhile((d) => d.gamePhase === 'playing');
  console.log(`Apple TV phone camera passed (${device ? 'on an Apple TV' : 'in the tvOS simulator'}, phone page in Chromium, through the relay):`, JSON.stringify({
    phone: tv.connectMessage, ...(device ? { score: tv.gameScores, appFpsPlaying: playing.length ? `${Math.min(...playing)}–${Math.max(...playing)}` : 'n/a' } : {}),
    seconds: Math.round((Date.now() - started) / 1000), screenshots: out,
  }));
  assert.deepEqual(errors, []);
} catch (error) {
  console.error('Apple TV state:', JSON.stringify(tv));
  console.error('Phone state:', await phone?.locator('canvas').evaluate((c) => JSON.stringify((c as HTMLCanvasElement).dataset)).catch(() => ''));
  console.error('Errors:', errors);
  if (appLog.length) console.error('App log (tail):', appLog.join('').split('\n').slice(-30).join('\n'));
  screenshot('failure');
  process.exitCode = 1;
  console.error(error);
} finally {
  clearInterval(progress);
  appProcess.kill();
  if (!device) spawnSync('xcrun', ['simctl', 'terminate', sim, BUNDLE_ID], { stdio: 'ignore' });
  await browser.close();
  pairing.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
