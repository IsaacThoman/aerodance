import test from 'node:test';
import assert from 'node:assert/strict';
import { CREW, layoutCast, paintSprite, spriteGrid, spriteInk } from '../src/game/castSprites.ts';
import { CUTOUT } from '../src/ui/cutout.ts';
import type { Cutout } from '../src/ui/cutout.ts';

const { body: B, eye: E } = CUTOUT;
// A 3x2 dancer: a body pixel, an eye and a body pixel, over a row of body.
const cut: Cutout = { w: 3, h: 2, cx: 1, part: new Uint8Array([B, E, B, B, B, B]) };
const pixel = (s: ReturnType<typeof paintSprite>, x: number, y: number) => [...s.data.slice((y * s.width + x) * 4, (y * s.width + x) * 4 + 4)];

test('a sprite is the player\'s colour with its eyes and a one-pixel shadow down and right', () => {
  const s = paintSprite(cut, 0), ink = spriteInk(0)!;
  assert.deepEqual([s.width, s.height], [4, 3]);
  assert.deepEqual(pixel(s, 0, 0), [...ink.fill, 255]);
  assert.deepEqual(pixel(s, 1, 0), [...ink.eyes, 255]);
  // Right of the top row and under the bottom one, offset by a pixel.
  assert.deepEqual(pixel(s, 3, 1), [...ink.shadow, 255]);
  assert.deepEqual(pixel(s, 1, 2), [...ink.shadow, 255]);
  assert.deepEqual(pixel(s, 3, 2), [...ink.shadow, 255]);
  // Nothing up and left of it.
  assert.deepEqual(pixel(s, 0, 2), [0, 0, 0, 0]);
  assert.deepEqual(pixel(s, 3, 0), [0, 0, 0, 0]);
});

test('a dancer nobody follows is a white silhouette with its eyes cut out and no shadow', () => {
  const s = paintSprite(cut, -1);
  assert.deepEqual(pixel(s, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(s, 1, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(s, 3, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(s, 1, 2), [0, 0, 0, 0]);
});

test('each player\'s sprite is in their own colours', () => {
  const fills = [0, 1, 2, 3].map((id) => spriteInk(id)!.fill.join());
  assert.equal(new Set(fills).size, 4);
  assert.equal(spriteInk(-1), null);
});

test('the cast lays out on whole pixels, step apart by their bodies\' middles', () => {
  const wide: Cutout = { w: 9, h: 2, cx: 6, part: new Uint8Array(18) };
  const { x, width } = layoutCast([cut, wide, cut], 5);
  // Middles at 0, 5 and 10 from the first's: left edges at -1, -1 and 9.
  assert.deepEqual(x, [0, 0, 10]);
  for (const n of x) assert.ok(Number.isInteger(n));
  // From the first two's left edges (-1) to the last's right edge (12) and its shadow.
  assert.equal(width, 14);
  assert.deepEqual(layoutCast([cut], 5), { x: [0], width: 4 });
});

test('cutouts render at the overlay\'s resolution: 4:3-wide pixels in widescreen, square in 4:3', () => {
  // The 640x480 buffer under 1600x900 and 1200x900 design units, dancers 60 units tall.
  const wide = spriteGrid({ a: 640 / 1600, d: 480 / 900 }, 60);
  assert.deepEqual(wide, { ppu: 9.52, ppuX: 7.14 });
  const standard = spriteGrid({ a: 640 / 1200, d: 480 / 900 }, 60);
  assert.equal(standard.ppu, standard.ppuX);
});

test('the crew has a moment for each of up to four dancers', () => {
  assert.equal(CREW.length, 4);
  assert.equal(new Set(CREW.map((p) => `${p.take}:${p.seconds}`)).size, 4);
});
