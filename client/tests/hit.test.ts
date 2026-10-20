import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TOUCH_PX, hit, widgetAt } from '../src/ui/hit.ts';
import type { Rect } from '../src/ui/draw.ts';
import { BACK as MENU_BACK, ONE_PLAYER, TWO_PLAYERS } from '../src/menu/layout.ts';
import { BACK, DANCE, GAME_CALIBRATION_CAMERA, GAME_CALIBRATION_PREVIEW, GAME_PAUSE, GAME_READY_BACK, PAGE_DOWN, PAGE_UP,
  RESULTS_RETRY, RESULTS_SONGS, rowRect } from '../src/game/layout.ts';

// The 1600x900 design on the smallest iPhone the app supports (iPhone SE, 667x375 points), in
// landscape: a touch target 44 points across is this many design units.
const SE = (MIN_TOUCH_PX * 1600) / 667;
type Shape = Parameters<typeof hit>[1] & { id: string };

/** How far (design units) the widget answers taps along a line through its centre, either way. */
function span(widgets: readonly Shape[], id: string, axis: 'x' | 'y', min: number) {
  const wdg = widgets.find((w) => w.id === id);
  if (!wdg) throw Error(id);
  const c = wdg.rect ? { x: wdg.rect.x + wdg.rect.w / 2, y: wdg.rect.y + wdg.rect.h / 2 } : { x: wdg.circle.x, y: wdg.circle.y };
  let total = 0;
  for (const dir of [-1, 1]) {
    let d = 0;
    while (widgetAt(widgets, { ...c, [axis]: c[axis] + dir * (d + 0.25) }, min)?.id === id) d += 0.25;
    total += d;
  }
  return total;
}
const points = (units: number) => (units * 667) / 1600;
const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) <= 0.5, message ?? `${actual} is not ${expected}`);

test('without touch, a widget answers a little past its edge, as before', () => {
  const button = { id: 'button', rect: { x: 100, y: 100, w: 200, h: 50 } };
  const bubble = { id: 'bubble', circle: { x: 500, y: 125, r: 30 } };
  assert.equal(widgetAt([button, bubble], { x: 92, y: 158 })?.id, 'button');
  assert.equal(widgetAt([button, bubble], { x: 91, y: 125 }), undefined);
  assert.equal(widgetAt([button, bubble], { x: 536, y: 125 })?.id, 'bubble');
  assert.equal(widgetAt([button, bubble], { x: 537, y: 125 }), undefined);
  assert.equal(widgetAt([button, bubble], null), undefined);
});

test('for touch, small widgets answer the 44 points around their centre, and big ones stay as they are', () => {
  const button = { id: 'button', rect: { x: 100, y: 100, w: 400, h: 50 } };
  const bubble = { id: 'bubble', circle: { x: 800, y: 125, r: 30 } };
  const widgets = [button, bubble];
  near(span(widgets, 'button', 'y', SE), SE);
  near(span(widgets, 'button', 'x', SE), 400 + 16, 'wide already: only padded');
  near(span(widgets, 'bubble', 'x', SE), SE);
  // A circle grows into a circle, not a square.
  assert.ok(hit({ x: 800 + SE / 2 * 0.7, y: 125 + SE / 2 * 0.7 }, bubble, SE));
  assert.ok(!hit({ x: 800 + SE / 2 * 0.8, y: 125 + SE / 2 * 0.8 }, bubble, SE));
});

test('where grown areas overlap, the widget drawn nearest the tap wins', () => {
  // Rows 16 units apart: a tap goes to the nearer row, and one on a row always to that row.
  const rows = [0, 1, 2].map((i) => ({ id: `row-${i}`, rect: rowRect(i) }));
  const gapMiddle = rowRect(0).y + rowRect(0).h + 8;
  assert.equal(widgetAt(rows, { x: 400, y: gapMiddle - 1 }, SE)?.id, 'row-0');
  assert.equal(widgetAt(rows, { x: 400, y: gapMiddle + 1 }, SE)?.id, 'row-1');
  assert.equal(widgetAt(rows, { x: 400, y: rowRect(1).y + 1 }, SE)?.id, 'row-1');
  // Widgets drawn over each other: the first in the list, as before.
  const under = { id: 'under', rect: { x: 0, y: 0, w: 100, h: 100 } };
  const over = { id: 'over', rect: { x: 40, y: 40, w: 20, h: 20 } };
  assert.equal(widgetAt([under, over], { x: 50, y: 50 }, SE)?.id, 'under');
  assert.equal(widgetAt([over, under], { x: 50, y: 50 }, SE)?.id, 'over');
});

test('on an iPhone SE, the game’s small targets answer 44 points across, or up to their neighbours', () => {
  const asRect = (id: string, rect: Rect) => ({ id, rect });
  // Song Select: back, the songs and the page arrows.
  const list: Shape[] = [{ id: 'back', circle: BACK }, ...[0, 1, 2, 3].map((i) => asRect(`row-${i}`, rowRect(i))),
    { id: 'page-up', circle: PAGE_UP }, { id: 'page-down', circle: PAGE_DOWN }];
  assert.ok(points(span(list, 'back', 'x', SE)) >= 44 - 0.5);
  assert.ok(points(span(list, 'page-up', 'y', SE)) >= 44 - 0.5);
  // Rows are 104 units apart: they answer every tap between them, 43.4 points each.
  near(span(list, 'row-1', 'y', SE), 104);
  // The page arrows give way to the songs beside them, halfway across the gap.
  assert.equal(widgetAt(list, { x: PAGE_UP.x - PAGE_UP.r - 8, y: PAGE_UP.y }, SE)?.id, 'row-0');

  const players: Shape[] = [{ id: 'back', circle: MENU_BACK }, asRect('one', ONE_PLAYER), asRect('two', TWO_PLAYERS)];
  assert.ok(points(span(players, 'one', 'y', SE)) >= 44 - 0.5);
  assert.ok(points(span(players, 'back', 'x', SE)) >= 44 - 0.5);

  const calibration: Shape[] = [{ id: 'quit', circle: GAME_READY_BACK }, asRect('start-camera', GAME_CALIBRATION_PREVIEW),
    asRect('camera-prev', GAME_CALIBRATION_CAMERA.prev), asRect('camera-next', GAME_CALIBRATION_CAMERA.next)];
  for (const id of ['quit', 'camera-prev', 'camera-next']) {
    for (const axis of ['x', 'y'] as const) assert.ok(points(span(calibration, id, axis, SE)) >= 44 - 0.5, `${id} ${axis}`);
  }
  assert.ok(points(span([{ id: 'pause', circle: GAME_PAUSE }], 'pause', 'y', SE)) >= 44 - 0.5);
  const preview: Shape[] = [{ id: 'back', circle: BACK }, asRect('dance', DANCE)];
  assert.ok(points(span(preview, 'dance', 'y', SE)) >= 44 - 0.5);
  // Results: two buttons side by side, wide enough already, so the gap between them stays a gap.
  const results: Shape[] = [asRect('retry', RESULTS_RETRY), asRect('quit', RESULTS_SONGS)];
  assert.ok(points(span(results, 'retry', 'y', SE)) >= 44 - 0.5);
  const between = (RESULTS_RETRY.x + RESULTS_RETRY.w + RESULTS_SONGS.x) / 2;
  assert.equal(widgetAt(results, { x: between - 3, y: RESULTS_RETRY.y + 40 }, SE)?.id, 'retry');
  assert.equal(widgetAt(results, { x: between, y: RESULTS_RETRY.y + 40 }, SE), undefined);
  assert.equal(widgetAt(results, { x: between + 3, y: RESULTS_RETRY.y + 40 }, SE)?.id, 'quit');
});
