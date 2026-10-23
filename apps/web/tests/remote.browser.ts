// Run after npm run build. The TV remote the iPhone/iPad app shows (/remote/), in a phone-sized
// touch screen with a stand-in for the app's message handler: every button sends its key where it
// is drawn, once even when VoiceOver also clicks its label, held arrows repeat until let go (or
// the TV goes), Back follows the song, the app is told where its AirPlay picker goes, and the
// text fits an iPad held sideways. Then the game's own AirPlay bubble: on the main menu in the app, it says
// where it is, and takes the picker away when the menu moves on or the game goes to the TV; and its
// camera bubble, which opens the app's phone camera page. Last, that page in the app: it tells the
// app its stage, and its code screen's close button (and Escape) closes it, which a browser's doesn't have.
//
// REMOTE_BROWSER=webkit runs it in WebKit (the app's engine) instead of Chromium.
import assert from 'node:assert/strict';
import express from 'express';
import { chromium, webkit } from 'playwright';
import type { Page } from 'playwright';
import { leftCornerBubble, menuLayout } from '../src/menu/layout.ts';
import { DISPLAY_MODES } from '../src/display.ts';
import { MIN_TOUCH_PX } from '../src/ui/hit.ts';

type Sent = { key?: string; repeat?: boolean; airplay?: { x: number; y: number; w: number; h: number } | null; ready?: boolean };
type TestWindow = typeof window & { sent: Sent[]; __aerodanceRemote?: (state: unknown) => void };

const app = express();
app.use(express.static('dist'));
const server = app.listen(4184, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const engine = process.env.REMOTE_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch(engine === chromium ? {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} : {});

const sent = (page: Page) => page.evaluate(() => (window as TestWindow).sent);
const keys = async (page: Page) => (await sent(page)).filter((m) => m.key);
const dataset = (page: Page) => page.evaluate(() => ({ ...document.querySelector('canvas')?.dataset }));
const centre = async (page: Page, label: string) => {
  const box = await page.getByRole('button', { name: label, exact: true }).boundingBox();
  assert.ok(box, `no ${label} button`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

try {
  // An iPhone held upright, inside its safe area.
  const page = await browser.newPage({ viewport: { width: 402, height: 791 }, hasTouch: true, isMobile: engine === chromium });
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => {
    const w = window as TestWindow & { webkit?: unknown };
    w.sent = [];
    w.webkit = { messageHandlers: { aerodanceRemote: { postMessage: (message: Sent) => w.sent.push(JSON.parse(JSON.stringify(message))) } } };
  });
  await page.goto('http://127.0.0.1:4184/remote/');
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.remoteReady === 'true');
  assert.deepEqual((await sent(page))[0], { ready: true }, 'the page asks the app for its state first');
  await page.evaluate(() => (window as TestWindow).__aerodanceRemote?.({ page: { menuScreen: 'main', menuReady: 'true' } }));
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.remoteScreen === 'On the TV · Main menu');
  assert.equal(await page.getByRole('status').textContent(), 'On the TV · Main menu');

  // The AirPlay picker goes over the drawn button, top right, at least a fingertip across.
  const picker = (await sent(page)).findLast((m) => 'airplay' in m)?.airplay;
  assert.ok(picker && picker.w >= MIN_TOUCH_PX && picker.h >= MIN_TOUCH_PX, `the AirPlay picker is ${JSON.stringify(picker)}`);
  assert.ok(picker.x > 402 / 2 && picker.y < 120, `the AirPlay picker is at ${JSON.stringify(picker)}, not top right`);

  // Each button, tapped where its label says it is, sends its key once.
  const buttons = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', OK: 'Enter', Back: 'Escape' };
  for (const [label, key] of Object.entries(buttons)) {
    const before = (await keys(page)).length;
    const at = await centre(page, label);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForFunction((n) => (window as TestWindow).sent.filter((m) => m.key).length > n, before);
    await page.waitForTimeout(150);
    assert.deepEqual((await keys(page)).slice(before), [{ key, repeat: false }], `${label} sent the wrong keys`);
  }

  // A held arrow: once at once, then repeating until it's let go. OK doesn't repeat.
  const down = await centre(page, 'Down');
  let before = (await keys(page)).length;
  await page.mouse.move(down.x, down.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.screenshot({ path: '/tmp/aerodance-remote-held.png' });
  await page.waitForTimeout(1050);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const held = (await keys(page)).slice(before);
  assert.deepEqual(held[0], { key: 'ArrowDown', repeat: false });
  assert.ok(held.length >= 5 && held.slice(1).every((m) => m.key === 'ArrowDown' && m.repeat), `holding Down for 1.2 s sent ${JSON.stringify(held)}`);
  const afterRelease = (await keys(page)).length;
  await page.waitForTimeout(500);
  assert.equal((await keys(page)).length, afterRelease, 'Down kept repeating after it was let go');
  // The TV going lets go of a held arrow, though the finger is still down.
  before = (await keys(page)).length;
  await page.mouse.move(down.x, down.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.evaluate(() => (window as TestWindow).__aerodanceRemote?.({ page: {}, shown: false }));
  await page.waitForTimeout(100);
  const whenGone = (await keys(page)).length;
  await page.waitForTimeout(600);
  assert.equal((await keys(page)).length, whenGone, 'Down kept repeating after the TV went');
  assert.ok(whenGone - before >= 2, 'Down didn\'t repeat before the TV went');
  await page.mouse.up();
  await page.evaluate(() => (window as TestWindow).__aerodanceRemote?.({ page: { menuScreen: 'main', menuReady: 'true' }, shown: true }));

  // VoiceOver presses a label with a click: one key, and none more when it also touches the canvas.
  before = (await keys(page)).length;
  await page.getByRole('button', { name: 'Up', exact: true }).evaluate((el: HTMLElement) => el.click());
  const up = await centre(page, 'Up');
  await page.touchscreen.tap(up.x, up.y);
  await page.getByRole('button', { name: 'Up', exact: true }).evaluate((el: HTMLElement) => el.click());
  await page.waitForTimeout(200);
  assert.deepEqual((await keys(page)).slice(before), [{ key: 'ArrowUp', repeat: false }, { key: 'ArrowUp', repeat: false }],
    'a label click, then a touch with its click, should be two presses');

  const ok = await centre(page, 'OK');
  before = (await keys(page)).length;
  await page.mouse.move(ok.x, ok.y);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  assert.deepEqual((await keys(page)).slice(before), [{ key: 'Enter', repeat: false }], 'a held OK repeated');

  // Back pauses a song that's on, and resumes a paused one.
  await page.evaluate(() => (window as TestWindow).__aerodanceRemote?.({ page: { gamePhase: 'playing' } }));
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.remoteScreen === 'On the TV · Dancing');
  await page.evaluate(() => (window as TestWindow).__aerodanceRemote?.({ page: { gamePhase: 'paused' } }));
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.remoteBack === 'resume');
  await page.screenshot({ path: '/tmp/aerodance-remote.png' });
  await page.close();

  // A 4:3 iPad held sideways: the narrowest column, and every line of text still on screen.
  const wide = await browser.newPage({ viewport: { width: 1024, height: 744 } });
  await wide.addInitScript(() => {
    const w = window as typeof window & { offscreen: string[] };
    w.offscreen = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (value, x, y, maxWidth) {
      const width = this.measureText(value).width;
      const left = this.textAlign === 'center' ? x - width / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? x - width : x;
      const a = this.getTransform().transformPoint({ x: left, y }), b = this.getTransform().transformPoint({ x: left + width, y });
      if (a.x < -0.5 || b.x > this.canvas.width + 0.5) w.offscreen.push(value);
      if (maxWidth === undefined) fillText.call(this, value, x, y);
      else fillText.call(this, value, x, y, maxWidth);
    };
  });
  await wide.goto('http://127.0.0.1:4184/remote/');
  await wide.waitForFunction(() => document.querySelector('canvas')?.dataset.remoteReady === 'true');
  await wide.waitForTimeout(300);
  assert.deepEqual(await wide.evaluate(() => (window as typeof window & { offscreen: string[] }).offscreen), [], 'text runs off the screen');
  await wide.screenshot({ path: '/tmp/aerodance-remote-ipad-sideways.png' });
  await wide.close();

  // Outside the app the page says what it's for.
  const outside = await browser.newPage({ viewport: { width: 402, height: 791 } });
  await outside.goto('http://127.0.0.1:4184/remote/');
  await outside.waitForFunction(() => document.querySelector('canvas')?.dataset.remoteReady === 'true');
  assert.equal((await dataset(outside)).remoteScreen, 'Opens from the aerodance app');
  await outside.close();

  // The game's AirPlay bubble, in the app (on the phone), on an iPhone's main menu.
  const game = await browser.newPage({ viewport: { width: 852, height: 393 }, hasTouch: true, isMobile: engine === chromium });
  game.setDefaultTimeout(90000);
  await game.addInitScript(() => {
    const w = window as typeof window & { placed: unknown[]; opened: number; __aerodanceHost?: unknown; __aerodanceAirPlayAt?: unknown; __aerodanceOpenCamera?: unknown };
    w.placed = [];
    w.opened = 0;
    w.__aerodanceHost = { interrupted: false, tv: false, screen: 'phone' };
    w.__aerodanceAirPlayAt = (rect: unknown) => w.placed.push(rect);
    w.__aerodanceOpenCamera = () => { w.opened++; };
  });
  await game.goto('http://127.0.0.1:4184/?input=ghost');
  await game.waitForFunction(() => document.querySelector('canvas')?.dataset.menuReady === 'true' && document.querySelector('canvas')?.dataset.menuScreen === 'main');
  await game.waitForFunction(() => !!(window as typeof window & { placed: unknown[] }).placed.at(-1));
  const placed = () => game.evaluate(() => (window as typeof window & { placed: ({ x: number; y: number; w: number; h: number } | null)[] }).placed.at(-1));
  const bubble = await placed();
  const frame = await game.locator('canvas').boundingBox();
  assert.ok(bubble && frame, 'the bubble said nothing');
  assert.ok(bubble.w >= MIN_TOUCH_PX && bubble.x + bubble.w <= frame.x + frame.width + 0.5 && bubble.y + bubble.h <= frame.y + frame.height + 0.5
    && bubble.x > frame.x + frame.width / 2 && bubble.y > frame.y + frame.height / 2, `the bubble is at ${JSON.stringify(bubble)} in a frame at ${JSON.stringify(frame)}`);
  await game.screenshot({ path: '/tmp/aerodance-airplay-bubble.png' });
  const design = DISPLAY_MODES[(await dataset(game)).displayMode === 'standard' ? 'standard' : 'widescreen'];
  // The camera bubble, bottom left: a tap opens the app's phone camera page.
  const opened = () => game.evaluate(() => (window as typeof window & { opened: number }).opened);
  const camera = leftCornerBubble(design.w);
  const tapCamera = () => game.touchscreen.tap(frame.x + camera.x / design.w * frame.width, frame.y + camera.y / design.h * frame.height);
  await tapCamera();
  await game.waitForFunction(() => (window as typeof window & { opened: number }).opened > 0);
  assert.equal(await opened(), 1, 'the camera bubble opened the camera page more than once');
  // Start: the menu moves on, and the picker goes at once.
  const { START } = menuLayout(design.w);
  await game.touchscreen.tap(frame.x + (START.x + START.w / 2) / design.w * frame.width, frame.y + (START.y + START.h / 2) / design.h * frame.height);
  await game.waitForFunction(() => document.querySelector('canvas')?.dataset.menuScreen === 'players');
  assert.equal(await placed(), null, 'the AirPlay picker stayed after Start');
  // Back on the main menu it comes back; on the TV it goes.
  await game.keyboard.press('Escape');
  await game.waitForFunction(() => !!(window as typeof window & { placed: unknown[] }).placed.at(-1));
  await game.evaluate(() => { (window as typeof window & { __aerodanceHost?: unknown }).__aerodanceHost = { interrupted: false, tv: true, screen: 'tv' }; });
  await game.waitForFunction(() => (window as typeof window & { placed: unknown[] }).placed.at(-1) === null);
  // On the TV the camera bubble goes too.
  await game.waitForTimeout(500);
  await tapCamera();
  await game.waitForTimeout(300);
  assert.equal(await opened(), 1, 'the camera bubble opened the camera page with the game on the TV');
  await game.close();

  // The phone camera page in the app, upright.
  type CameraWindow = typeof window & { said: { stage?: string; dim?: boolean; close?: boolean }[] };
  const pair = await browser.newPage({ viewport: { width: 402, height: 791 }, hasTouch: true, isMobile: engine === chromium });
  pair.setDefaultTimeout(30000);
  await pair.addInitScript(() => {
    const w = window as CameraWindow & { webkit?: unknown };
    w.said = [];
    w.webkit = { messageHandlers: { aerodanceCamera: { postMessage: (message: unknown) => w.said.push(JSON.parse(JSON.stringify(message))) } } };
  });
  const said = () => pair.evaluate(() => (window as CameraWindow).said);
  await pair.goto('http://127.0.0.1:4184/pair/');
  await pair.waitForFunction(() => document.querySelector('canvas')?.dataset.phoneStage === 'code');
  assert.deepEqual((await said()).at(-1), { stage: 'code', dim: false }, 'the page didn\'t tell the app its stage');
  const close = await centre(pair, 'Close');
  assert.ok(close.x > 402 / 2 && close.y < 120, `the close button is at ${JSON.stringify(close)}, not top right`);
  await pair.screenshot({ path: '/tmp/aerodance-camera-page-app.png' });
  await pair.touchscreen.tap(close.x, close.y);
  await pair.waitForFunction(() => (window as CameraWindow).said.some((m) => m.close));
  // Escape closes it too.
  await pair.evaluate(() => { (window as CameraWindow).said = []; });
  await pair.keyboard.press('Escape');
  await pair.waitForFunction(() => (window as CameraWindow).said.some((m) => m.close));
  await pair.close();

  // In a browser it has no close button.
  const browserPair = await browser.newPage({ viewport: { width: 402, height: 791 } });
  await browserPair.goto('http://127.0.0.1:4184/pair/');
  await browserPair.waitForFunction(() => document.querySelector('canvas')?.dataset.phoneStage === 'code');
  assert.equal(await browserPair.getByRole('button', { name: 'Close', exact: true }).count(), 0, 'a browser\'s camera page has a close button');
  await browserPair.close();
  console.log(`remote browser test passed (${engine.name()})`);
} finally {
  await browser.close();
  server.close();
}
