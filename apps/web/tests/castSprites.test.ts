import test from 'node:test';
import assert from 'node:assert/strict';
import { CREW, layoutCast, paintSprite, spriteGrid, spriteInk } from '../src/game/castSprites.ts';
import { CUTOUT, clearShift } from '../src/ui/cutout.ts';
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

test('the cast stands side by side on one floor, each a pixel clear of the ones before', () => {
  // A 2x4 dancer with a hand out to the right on its second row.
  const reach: Cutout = { w: 3, h: 4, cx: 0, part: new Uint8Array([B, B, 0, B, B, B, B, B, 0, B, B, 0]) };
  const { x, width } = layoutCast([reach, reach, reach]);
  // Columns 0-2, 4-6 and 8-10: the hand at column 2 keeps column 3 clear of the next body.
  assert.deepEqual(x, [0, 4, 8]);
  assert.equal(width, 12);
  // A short dancer tucks in under the one before's hand.
  const short: Cutout = { w: 1, h: 1, cx: 0, part: new Uint8Array([B]) };
  assert.deepEqual(layoutCast([reach, short]).x, [0, 3]);
  // Already a pixel clear, it doesn't move further: middles one apart if they can be.
  assert.deepEqual(layoutCast([short, short]).x, [0, 2]);
  assert.deepEqual(layoutCast([cut]), { x: [0], width: 4 });
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

test('a hand held against the body slides out sideways until a pixel is clear between them', () => {
  // A 3-wide body in columns 3-5 of a 12x3 frame, and a hand overlapping its right edge.
  const W = 12, H = 3, mask = (cols: number[]) => {
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (const x of cols) m[y * W + x] = 1;
    return m;
  };
  const body = mask([3, 4, 5]), hand = mask([5, 6]);
  // To the right: from column 5 to 7, leaving column 6 clear.
  assert.equal(clearShift(body, hand, W, H, 1), 2);
  // To the left: past the body to columns 0-1, leaving column 2 clear.
  assert.equal(clearShift(body, hand, W, H, -1), 5);
  // Already clear: it stays.
  assert.equal(clearShift(body, mask([8, 9]), W, H, 1), 0);
  // Touching (no clear pixel) counts as held.
  assert.equal(clearShift(body, mask([6]), W, H, 1), 1);
  // No room within the limit.
  assert.equal(clearShift(body, hand, W, H, 1, 1, 1), null);
});
