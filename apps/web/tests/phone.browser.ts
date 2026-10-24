// Run after npm run build. A phone as the game's camera, end to end in one Chromium: the
// game pairs through the real pairing server, a phone page joins it by typing the code,
// tracks a synthetic portrait camera with the real MediaPipe model and sends poses over a
// real WebRTC connection; the game calibrates and plays from them. The phone keeps tracking
// while dimmed, then leaves and comes back through the QR code's link.
//
// PHONE_BROWSER=webkit runs the phone page in WebKit (Safari's engine) as an iPhone, talking to
// the game in Chromium. PHONE_TRANSPORT=relay connects them through the pairing server's relay
// (as the Apple TV app does, having no WebRTC), with the preview as small pictures.
// PHONE_TRANSPORT=fallback makes the game's first WebRTC connection unable to connect, so the two
// fall back to the relay, then move to WebRTC by a probe once the song has ended. HEADED=1 shows both windows; BROWSER_GPU=metal renders on the Mac's GPU
// instead of SwiftShader (needed with UI_RENDER=1, which is too slow in software).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { chromium, webkit } from 'playwright';
import type { Browser, Page } from 'playwright';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';
import { MINUS, START, PLAYERS_GO } from '../src/menu/layout.ts';
import { DANCE, GAME_CALIBRATION_CAMERA, rowRect } from '../src/game/layout.ts';
import type { Rect } from '../src/ui/draw.ts';
import { createPairingServer } from '../../../packages/pairing/server.ts';

/** What the phone page's script adds to window: whether the synthetic dancer is in shot. */
type TestWindow = typeof window & { cameraVisible: boolean };

const fixture = bundleFixture();
const files = new Map([
  ['song.json', Buffer.from(JSON.stringify(fixture.song))],
  ['choreography.adpose', Buffer.from(choreographyBytes(fixture))],
  ['audio.wav', Buffer.from(fixture.audio)],
]);
files.set('checksums.json', Buffer.from(JSON.stringify({ schema: 'aerodance.checksums', schemaVersion: 1,
  files: [...files].map(([path, body]) => ({ path, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })),
})));
const pairing = createPairingServer();
const app = express();
app.use('/pair', (req, res, next) => { pairing.handle(req, res).then((handled) => { if (!handled) next(); }, next); });
app.get('/pose-fixture.jpg', (_req, res) => res.sendFile(path.resolve('apps/web/tests/fixtures/mediapipe-pose.jpg'), { dotfiles: 'allow' }));
app.get('/songs/manifest.json', (_req, res) => res.json({ version: 1, songs: [fixture.entry] }));
app.get('/songs/fixture/:file', (req, res) => {
  const body = files.get(req.params.file);
  if (!body) return res.sendStatus(404);
  res.type(req.params.file.endsWith('.wav') ? 'audio/wav' : req.params.file.endsWith('.adpose') ? 'application/octet-stream' : 'application/json').send(body);
});
app.use(express.static('dist'));
const server = app.listen(4183, '127.0.0.1');
server.on('upgrade', (req, socket, head) => {
  req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
  if (!pairing.upgrade(req, socket, head)) socket.destroy();
});
const relayed = process.env.PHONE_TRANSPORT === 'relay';
const fallback = process.env.PHONE_TRANSPORT === 'fallback';
await new Promise(resolve => server.once('listening', resolve));
const headless = process.env.HEADED !== '1';
const gpu = process.env.BROWSER_GPU === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ headless, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  ...gpu,
  // Plain loopback candidates: both ends run on this machine (and on a VPN, the others may not reach it).
  '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] });
const phoneBrowser: Browser = process.env.PHONE_BROWSER === 'webkit' ? await webkit.launch({ headless }) : browser;
const render = process.env.UI_RENDER === '1';
const errors: string[] = [];
const ORIGIN = 'http://127.0.0.1:4183';

async function open(viewport: { width: number; height: number }, mobile = false) {
  const target = mobile ? phoneBrowser : browser;
  // In Chromium, camera permission, as a real phone page has: without it, it offers one interface's candidates only.
  const context = await target.newContext({ viewport, ...(target === browser ? { permissions: ['camera'] } : {}), ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(`${viewport.width}: ${error.message}`));
  await page.addInitScript(({ render }) => {
    if (!render) for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        if (Reflect.get(Type.prototype, name)) Reflect.set(Type.prototype, name, () => {});
      }
    }
    // A phone held upright: a 480x640 camera with one dancer.
    const w = window as TestWindow;
    w.cameraVisible = true;
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fixture-camera', label: 'Fixture camera' }],
      getUserMedia: async () => {
        const image = new Image(); image.src = '/pose-fixture.jpg'; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 640;
        const g = canvas.getContext('2d'); let count = 0;
        if (!g) throw Error('2D canvas unavailable');
        const draw = () => {
          g.fillStyle = '#fff'; g.fillRect(0, 0, 480, 640);
          if (!w.cameraVisible) return;
          g.drawImage(image, 200, 0, 600, 667, 40 + Math.sin(count++ / 20) * 2, 80, 400, 445);
        };
        draw(); const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { clearInterval(timer); stop(); };
        }
        return stream;
      },
    } });
  }, { render });
  return page;
}
const until = (page: Page, key: string, value: string | RegExp) => page.waitForFunction(([key, source, flags]) => {
  const v = document.querySelector('canvas')?.dataset[key] ?? '';
  return flags === null ? v === source : new RegExp(source, flags).test(v);
}, [key, value instanceof RegExp ? value.source : value, value instanceof RegExp ? value.flags : null] as const);
const data = (page: Page, key: string) => page.locator('canvas').evaluate((c, key) => (c as HTMLCanvasElement).dataset[key] ?? '', key);

const game = await open({ width: 1280, height: 800 });
// Its first connection gathers no candidates (relayed ones only, and there's no TURN server), so it never connects.
if (fallback) await game.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  let made = 0;
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) { super(made++ ? config : { ...config, iceTransportPolicy: 'relay' }); }
  };
});
const phone = await open({ width: 390, height: 844 }, true);
try {
  // A layout rect, or a circle (clicked at its centre).
  const click = async (r: Rect | { x: number; y: number }) => {
    const frame = await game.locator('.canvas-frame').boundingBox();
    assert.ok(frame, 'the canvas frame is laid out');
    const [w, h] = 'w' in r ? [r.w, r.h] : [0, 0];
    await game.mouse.click(frame.x + (r.x + w / 2) / 1600 * frame.width, frame.y + (r.y + h / 2) / 900 * frame.height);
  };
  await game.goto(relayed ? `${ORIGIN}/?transport=relay` : ORIGIN);
  await until(game, 'menuReady', 'true');
  await click(START); await until(game, 'menuScreen', 'players'); await until(game, 'menuReady', 'true');
  // Start opens the dial on 2; one phone dances one player.
  await click(MINUS); await until(game, 'menuPlayers', '1');
  await click(PLAYERS_GO); await until(game, 'songReady', 'true'); await click(rowRect(0));
  await until(game, 'previewState', 'playing'); await until(game, 'stageReady', 'true');

  // Calibration: the phone is two back from the default camera (after it, No camera wraps
  // round); picking it shows the pairing code without a press.
  await click(DANCE); await until(game, 'gamePhase', 'calibrating'); await until(game, 'gameReady', 'true');
  await click(GAME_CALIBRATION_CAMERA.prev);
  await click(GAME_CALIBRATION_CAMERA.prev);
  await until(game, 'gamePairing', /^\d{6}$/);
  const code = await data(game, 'gamePairing');
  assert.equal(await data(game, 'gameCameraStatus'), 'connecting');

  // The phone types the code.
  await phone.goto(`${ORIGIN}/pair/`);
  await until(phone, 'phoneStage', 'code');
  await phone.keyboard.type(code);
  await until(phone, 'phoneStage', 'linked');
  await until(phone, 'phoneCameraStatus', 'connected');
  await until(game, 'gameCameraStatus', 'connected');
  await until(game, 'gameCalibrationPreview', 'true');
  assert.equal(await data(phone, 'phoneTransport'), relayed || fallback ? 'relay' : 'webrtc');
  assert.equal(await data(game, 'gamePairing'), '', 'the code goes once the phone is connected');
  // The calibration preview shows the phone's own picture under the skeletons.
  await until(phone, 'phoneVideo', 'true');
  await until(game, 'gameCalibrationVideo', 'true');
  if (relayed || fallback) {
    // Pictures, not a video track.
    assert.equal(await game.evaluate(() => document.querySelectorAll('video').length), 0);
  } else {
    const received = await game.evaluate(() => Math.max(...[...document.querySelectorAll('video')].map((v) => Math.max(v.videoWidth, v.videoHeight))));
    assert.ok(received > 0 && received <= 320, `the phone's picture is small (${received}px on its long side)`);
  }
  if (process.env.UI_ARTIFACTS) {
    await game.screenshot({ path: `${process.env.UI_ARTIFACTS}/phone-game.png` });
    // Once the game has the player, the phone's preview shows their skeleton.
    await until(game, 'gameCalibrationProgress', /^(0\.[5-9]|1)/);
    await phone.screenshot({ path: `${process.env.UI_ARTIFACTS}/phone-setup.png` });
  }

  // The phone's poses calibrate the player and start the song; the phone dims.
  await until(game, 'gamePhase', 'countdown');
  await until(phone, 'phoneDim', 'true');
  await until(phone, 'phoneVideo', 'false');
  await until(game, 'gamePhase', 'playing');

  await until(game, 'gamePhase', 'results');
  // The song over, a probe moves a relayed phone to WebRTC without it unlinking.
  if (fallback) {
    await until(phone, 'phoneTransport', 'webrtc');
    assert.equal(await data(phone, 'phoneStage'), 'linked');
  }

  // Still tracking long after dimming (more than the camera's 10 s watchdog).
  await phone.waitForTimeout(12000);
  assert.equal(await data(phone, 'phoneCameraStatus'), 'connected');
  assert.equal(await data(game, 'gameCameraStatus'), 'connected');

  // The phone leaves and opens the QR code's link: the game loses it, then it rejoins and
  // its poses come back.
  await phone.goto('about:blank');
  await until(game, 'gameCameraStatus', /^(connecting|initializing)$/);
  await phone.goto(`${ORIGIN}/pair/#${code}`);
  await until(phone, 'phoneStage', 'linked');
  await until(phone, 'phoneCameraStatus', 'connected');
  await until(game, 'gameCameraStatus', 'connected');
  await until(game, 'gameCameraMessage', /poses\/s/);

  // Leaving the song keeps the phone; closing the page ends its link.
  await phone.close();
  assert.deepEqual(errors, []);
  const how = relayed ? 'through the relay' : fallback ? 'WebRTC after a fallback to the relay' : 'WebRTC';
  console.log(`Phone camera passed (game in Chromium, phone in ${phoneBrowser.browserType().name()}, ${how}): pairing by code, real ${relayed ? 'relayed' : 'WebRTC'} poses from a portrait phone camera, calibration and a song from them, tracking while dimmed, and rejoining from the link.`);
} catch (error) {
  console.error('Game state:', await game.locator('canvas').evaluate(c => JSON.stringify(c.dataset)).catch(() => ''));
  console.error('Phone state:', await phone.locator('canvas').evaluate(c => JSON.stringify(c.dataset)).catch(() => ''));
  console.error('Errors:', errors);
  throw error;
} finally {
  await browser.close();
  if (phoneBrowser !== browser) await phoneBrowser.close();
  pairing.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
