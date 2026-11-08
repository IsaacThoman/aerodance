import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'uqr';
import { drawQr } from '../src/connect/pairing.ts';
import { DISPLAY_MODES, RENDER_SIZE } from '../src/display.ts';
import type { Rect } from '../src/ui/draw.ts';

for (const [mode, design] of Object.entries(DISPLAY_MODES)) {
  for (const link of ['https://dance.test/?transfer=123456', 'https://dance.test/pair/#123456']) {
    test(`QR stays square and pixel aligned in ${mode}: ${link}`, () => {
      const sx = RENDER_SIZE.w / design.w, sy = RENDER_SIZE.h / design.h;
      const offset = { x: 3, y: -17 };
      const fills: Rect[] = [];
      const g = {
        getTransform: () => ({ a: sx, d: sy, e: offset.x, f: offset.y }),
        save() {}, restore() {}, setTransform() {},
        fillRect(x: number, y: number, w: number, h: number) { fills.push({ x, y, w, h }); },
      } as unknown as CanvasRenderingContext2D;
      const box = { x: 120, y: 180, w: 236, h: 260 };
      const rect = drawQr(g, link, box);
      // At most one buffer pixel's rounding error, measured in design units.
      assert.ok(Math.abs(rect.w - rect.h) <= Math.max(1 / sx, 1 / sy));
      assert.ok(rect.w <= box.w && rect.h <= box.h);
      assert.ok(Math.abs(rect.x + rect.w / 2 - (box.x + box.w / 2)) <= 0.5 / sx);
      assert.ok(Math.abs(rect.y + rect.h / 2 - (box.y + box.h / 2)) <= 0.5 / sy);
      for (const fill of fills) {
        assert.ok(Object.values(fill).every(Number.isInteger), 'all edges land on buffer pixels');
        assert.ok(fill.w > 0 && fill.h > 0, 'no modules disappear');
      }
      // Every module centre retains the encoded data, including the white quiet zone.
      const { data } = encode(link, { ecc: 'M', border: 0 });
      const n = data.length + 4;
      const background = fills[0];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const px = background.x + (x + 0.5) * background.w / n;
        const py = background.y + (y + 0.5) * background.h / n;
        const dark = fills.slice(1).some(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
        assert.equal(dark, !!data[y - 2]?.[x - 2]);
      }
    });
  }
}
