import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusRing, focusRingOverlapsContent, updateFocusRing } from '../src/ui/focusRing.ts';
import type { CanvasUI, Widget } from '../src/ui/useCanvasUI.ts';

const button: Widget = { id: 'button', rect: { x: 100, y: 100, w: 300, h: 80 }, corner: 20 };
const uiState = () => ({ dt: 1 / 60, time: 0, hover: {}, dirty: false, requestFrame() {} }) as CanvasUI;

test('ring easing preserves CanvasUI.ease values and snap boundaries without dirtying content', () => {
  for (const dt of [0, 1 / 240, 1 / 60, 0.05, 0.1]) {
    for (const to of [0, 1]) {
      for (const k of [0, 0.0009, 0.0011, 0.5, 0.9989, 0.9991, 1]) {
        const ui = uiState();
        ui.dt = dt;
        const ring = createFocusRing();
        ring.k = k;
        // The original CanvasUI.ease contract, including the last frame snapping to target.
        const n = k + (to - k) * Math.min(1, dt * (to ? 14 : 10));
        const moving = Math.abs(n - to) > 1e-3;
        const dirty = updateFocusRing(ring, to ? button : undefined, ui);
        assert.equal(ring.k, moving ? n : to);
        if (moving || n !== k) assert.equal(dirty, true);
        assert.equal(ui.dirty, false);
      }
    }
  }
});

test('a settled ring repaints only when its 15 Hz color step changes', () => {
  const ui = uiState(), ring = createFocusRing();
  ring.k = 1;
  assert.equal(updateFocusRing(ring, button, ui), true);
  assert.equal(updateFocusRing(ring, button, ui), false);
  for (let frame = 1; frame <= 240; frame++) {
    const prev = ring.step;
    ui.time = frame / 60;
    assert.equal(updateFocusRing(ring, button, ui), Math.floor(ui.time * 15) !== prev);
    assert.equal(ui.dirty, false);
  }
  assert.equal(ring.step, 60);
});

test('outline changes and the last fade frame repaint independently of content', () => {
  const ui = uiState(), ring = createFocusRing();
  ring.k = 1;
  updateFocusRing(ring, button, ui);
  ui.hover.button = 1;
  assert.equal(updateFocusRing(ring, button, ui), true);
  assert.deepEqual(ring.shape, { x: 100, y: 97, w: 300, h: 80, r: 20 });
  assert.equal(updateFocusRing(ring, button, ui), false);
  assert.equal(updateFocusRing(ring, { ...button, corner: 10 }, ui), true);
  assert.equal(updateFocusRing(ring, { id: 'circle', circle: { x: 40, y: 50, r: 20 } }, ui), true);
  assert.deepEqual(ring.shape, { x: 20, y: 30, w: 40, h: 40, r: 20 });
  ring.k = 0.0011;
  ui.dt = 0.01;
  assert.equal(updateFocusRing(ring, undefined, ui), true);
  assert.equal(ring.k, 0);
  assert.equal(ring.shape, null);
  assert.equal(updateFocusRing(ring, undefined, ui), false);
  assert.equal(ui.dirty, false);
});

test('only short wide rows need content rasterized with the ring, including during fade-out', () => {
  const ui = uiState(), ring = createFocusRing();
  ring.k = 1;
  updateFocusRing(ring, { id: 'row', rect: { x: 0, y: 0, w: 300, h: 48 } }, ui);
  assert.equal(focusRingOverlapsContent(ring), true);
  updateFocusRing(ring, undefined, ui);
  assert.equal(focusRingOverlapsContent(ring), true);
  updateFocusRing(ring, button, ui);
  assert.equal(focusRingOverlapsContent(ring), false);
  updateFocusRing(ring, { id: 'circle', circle: { x: 40, y: 50, r: 20 } }, ui);
  assert.equal(focusRingOverlapsContent(ring), false);
  ring.shape = null;
  assert.equal(focusRingOverlapsContent(ring), false);
});
