import test from 'node:test';
import assert from 'node:assert/strict';
import { glassTextureSize } from '../src/ui/glassTexture.ts';

test('hover and press motion reuse the initial texture capacity', () => {
  const initial = glassTextureSize(201, 144, 640, 480);
  let size = initial;
  for (let frame = 0; frame < 480; frame++) {
    const w = 201 + Math.round(Math.sin(frame / 8) * 2);
    const h = 144 + Math.round(Math.cos(frame / 8) * 2);
    size = glassTextureSize(w, h, 640, 480, size.w, size.h);
    assert.deepEqual(size, initial, `frame ${frame}`);
    assert.ok(size.w >= w && size.h >= h, 'all required pixels fit');
  }
});

test('a larger panel grows capacity, and closing it reclaims the excess', () => {
  const main = glassTextureSize(201, 144, 640, 480);
  const panel = glassTextureSize(580, 410, 640, 480, main.w, main.h);
  assert.ok(panel.w >= 580 && panel.h >= 410);
  const reopened = glassTextureSize(201, 144, 640, 480, panel.w, panel.h);
  assert.deepEqual(reopened, main);
});

test('small changes across a size bucket do not repeatedly shrink and grow', () => {
  const initial = glassTextureSize(208, 144, 640, 480);
  let size = initial;
  for (let frame = 0; frame < 60; frame++) {
    size = glassTextureSize(frame % 2 ? 209 : 207, frame % 2 ? 145 : 143, 640, 480, size.w, size.h);
    assert.deepEqual(size, initial);
  }
});

test('capacity remains inside smaller and non-aligned drawing buffers', () => {
  for (const [bufferW, bufferH, neededW, neededH] of [[320, 240, 300, 220], [639, 479, 638, 476], [8, 8, 7, 7]]) {
    const size = glassTextureSize(neededW, neededH, bufferW, bufferH, 640, 480);
    assert.ok(size.w >= neededW && size.h >= neededH);
    assert.ok(size.w <= bufferW && size.h <= bufferH);
  }
});
