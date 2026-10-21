import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const injected = readFileSync(new URL('../../ios/src/inject.js', import.meta.url), 'utf8')
  .replace('__SITE__', '').replace('__REPORT_URL__', '').replace('__FLOW__', '');

test('iOS scripted taps follow the current display mode, including a move from iPad to TV', () => {
  const events: { type: string; clientX: number; clientY: number }[] = [];
  const ready: (() => void)[] = [];
  const frame = { left: 20, top: 30, width: 800, height: 600 };
  const canvas = {
    dataset: { displayMode: 'standard' },
    dispatchEvent(event: typeof events[number]) {
      events.push(event);
      if (event.type === 'pointerup') {
        canvas.dataset.displayMode = 'widescreen';
        Object.assign(frame, { width: 1280, height: 720 });
      }
    },
  };
  const context: Record<string, unknown> = {
    __aerodanceStart: { drive: [['tap', 978, 818], ['tap', 1322, 818]] },
    navigator: { userAgent: 'test' },
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    setInterval() {},
    addEventListener(type: string, fn: () => void) { if (type === 'DOMContentLoaded') ready.push(fn); },
    document: {
      querySelector(selector: string) {
        if (selector === '.canvas-frame canvas') return canvas;
        if (selector === '.canvas-frame') return { getBoundingClientRect: () => frame };
        return null;
      },
      createElement: () => ({}),
      head: { append() {} },
    },
    PointerEvent: class {
      constructor(type: string, init: object) { Object.assign(this, { type }, init); }
    },
  };
  context.window = context;
  runInNewContext(injected, context);
  ready.forEach((fn) => fn());
  assert.deepEqual(events.map((e) => e.type), ['pointermove', 'pointerdown', 'pointerup', 'pointermove', 'pointerdown', 'pointerup']);
  // Compact Dance! centre in an 800×600 iPad frame, then widescreen Dance! on TV.
  assert.equal(events[2].clientX, 672);
  assert.ok(Math.abs(events[2].clientY - 575.3333333333334) < 1e-6);
  assert.ok(Math.abs(events[5].clientX - 1077.6) < 1e-6);
  assert.ok(Math.abs(events[5].clientY - 684.4) < 1e-6);
});
