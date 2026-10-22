import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { remoteLayout } from '../src/remote/layout.ts';
import { backAction, inApp, listen, post, screenName } from '../src/remote/bridge.ts';
import { phoneDesign } from '../src/phone/layout.ts';
import { MIN_TOUCH_PX } from '../src/ui/hit.ts';
import type { Circle, Rect } from '../src/ui/draw.ts';

// The remote's screens, in CSS pixels: iPhones upright (inside the safe area), iPads either way.
const SCREENS = {
  'iPhone SE': [375, 647], 'iPhone 18 Pro': [402, 791], 'iPhone 18 Pro Max': [440, 868],
  'iPad mini': [744, 1089], 'iPad Pro 11" upright': [834, 1150], 'iPad Pro 11" sideways': [1194, 790],
  'iPad Pro 13" sideways': [1376, 980], 'iPad in Split View': [507, 1150],
} as const;

const circleBox = (c: Circle): Rect => ({ x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 });
const inside = (r: Rect, w: number, h: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('the remote fits every iPhone and iPad screen: every button on it, apart and big enough to tap', () => {
  for (const [name, [cssW, cssH]] of Object.entries(SCREENS)) {
    const design = phoneDesign(cssW, cssH);
    const L = remoteLayout(design);
    const scale = cssW / L.w;
    assert.equal(L.landscape, cssW > cssH, name);
    // The labels the page lays over the buttons are these boxes, so they mustn't overlap either.
    // The app's AirPlay picker is at least a fingertip across, centred on the button (RemoteApp).
    const picker = Math.max(L.airplay.r * 2, MIN_TOUCH_PX / scale);
    const boxes: [string, Rect][] = [
      ['airplay', { x: L.airplay.x - picker / 2, y: L.airplay.y - picker / 2, w: picker, h: picker }], ['up', circleBox(L.up)], ['down', circleBox(L.down)], ['left', circleBox(L.left)],
      ['right', circleBox(L.right)], ['ok', circleBox(L.ok)], ['back', L.back],
      ['status', { x: L.status.x, y: L.status.y - 14, w: L.status.w, h: 28 }],
    ];
    for (const [i, [id, box]] of boxes.entries()) {
      assert.ok(inside(box, L.w, L.h), `${name}: ${id} at ${JSON.stringify(box)} is off a ${L.w}×${L.h} screen`);
      assert.ok(Math.min(box.w, box.h) * scale >= MIN_TOUCH_PX || id === 'status', `${name}: ${id} is ${Math.min(box.w, box.h) * scale} px across`);
      for (const [other, b] of boxes.slice(0, i)) assert.ok(!overlap(box, b), `${name}: ${id} overlaps ${other}`);
    }
    // The volume hint sits below Back, on the screen.
    assert.ok(L.hint.y > L.back.y + L.back.h && L.hint.y < L.h, `${name}: the hint is at ${L.hint.y}`);
    // Upright, Back is under the pad; sideways, beside it.
    if (L.landscape) assert.ok(L.back.x + L.back.w < L.left.x - L.left.r, `${name}: Back runs into the pad`);
    else assert.ok(L.back.y > L.down.y + L.down.r, `${name}: Back isn't under the pad`);
  }
});

test('the status line names what the TV shows, and Back says what it does', () => {
  assert.equal(screenName({}), 'Starting');
  assert.equal(screenName({ menuScreen: 'main', menuReady: 'true' }), 'Main menu');
  assert.equal(screenName({ menuScreen: 'players' }), 'Players');
  assert.equal(screenName({ menuScreen: 'main', songReady: 'true', songScreen: 'list' }), 'Choosing a song');
  assert.equal(screenName({ songReady: 'true', songScreen: 'preview' }), 'Song preview');
  assert.equal(screenName({ songReady: 'true', songScreen: 'preview', gamePhase: 'calibrating' }), 'Getting ready');
  assert.equal(screenName({ gamePhase: 'playing' }), 'Dancing');
  assert.equal(screenName({ gamePhase: 'paused' }), 'Paused');
  assert.equal(screenName({ gamePhase: 'results', resultsScreen: 'stage' }), 'Results');
  assert.equal(backAction({ menuScreen: 'players' }), 'back');
  assert.equal(backAction({ gamePhase: 'countdown' }), 'pause');
  assert.equal(backAction({ gamePhase: 'playing' }), 'pause');
  assert.equal(backAction({ gamePhase: 'paused' }), 'resume');
  assert.equal(backAction({ gamePhase: 'results' }), 'back');
});

test('the remote talks to the app through its message handler, and to nothing in a browser', () => {
  const page = globalThis as { webkit?: unknown; __aerodanceRemote?: (state: unknown) => void };
  assert.equal(inApp(), false);
  post({ key: 'Enter' });  // goes nowhere
  const sent: unknown[] = [];
  page.webkit = { messageHandlers: { aerodanceRemote: { postMessage: (message: unknown) => sent.push(message) } } };
  try {
    assert.equal(inApp(), true);
    const seen: unknown[] = [];
    const off = listen((state) => seen.push(state));
    assert.deepEqual(sent, [{ ready: true }], 'listening asks the app for its state');
    page.__aerodanceRemote?.({ page: { menuScreen: 'main', menuReady: 'true', fps: 60 } });
    page.__aerodanceRemote?.(null);
    assert.deepEqual(seen, [{ page: { menuScreen: 'main', menuReady: 'true' } }, { page: {} }], 'only strings come through');
    off();
    assert.equal(page.__aerodanceRemote, undefined);
    post({ key: 'Escape', repeat: false });
    assert.deepEqual(sent.at(-1), { key: 'Escape', repeat: false });
  } finally { delete page.webkit; }
});

// inject.js in a page of its own, with the app's message handler.
function injected(host: object = {}) {
  const sent: Record<string, unknown>[] = [];
  const events: { type: string; detail: unknown }[] = [];
  const context: Record<string, unknown> = {
    __aerodanceStart: { host },
    navigator: { userAgent: 'test' },
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    setInterval() {},
    addEventListener() {},
    dispatchEvent(event: { type: string; detail: unknown }) { events.push(event); },
    CustomEvent: class { constructor(type: string, init: { detail: unknown }) { Object.assign(this, { type }, init); } },
    webkit: { messageHandlers: { aerodance: { postMessage: (message: Record<string, unknown>) => sent.push(message) } } },
    document: { querySelector: () => null, createElement: () => ({}), head: { append() {} } },
  };
  context.window = context;
  context.globalThis = context;
  const source = readFileSync(new URL('../../ios/src/inject.js', import.meta.url), 'utf8')
    .replace('__SITE__', '').replace('__REPORT_URL__', '').replace('__FLOW__', '');
  runInNewContext(source, context);
  return { context, sent, events };
}

test('in the app, the game is told which screen it is on, and says where its AirPlay bubble is', () => {
  const { context, sent, events } = injected({ tv: false, screen: 'phone' });
  // (Objects from the page's own realm, compared by value.)
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(context.__aerodanceHost), { interrupted: false, tv: false, screen: 'phone' });
  const setHost = context.__aerodanceSetHost as (state: object) => void;
  setHost({ tv: false, screen: 'tv' });
  assert.deepEqual(plain(events.map((e) => e.detail)), [{ interrupted: false, tv: false, screen: 'tv' }], 'moving to the TV is a change');
  setHost({ tv: false, screen: 'tv' });
  assert.equal(events.length, 1, 'the same state again is not');

  const at = context.__aerodanceAirPlayAt as (rect: unknown) => void;
  at({ x: 600.5, y: 300, w: 44, h: 44, extra: 1 });
  at(null);
  at({ x: 1, y: 2, w: 'wide', h: 4 });
  assert.deepEqual(plain(sent.filter((m) => 'airplay' in m)), [{ airplay: { x: 600.5, y: 300, w: 44, h: 44 } }, { airplay: null }, { airplay: null }]);
});
