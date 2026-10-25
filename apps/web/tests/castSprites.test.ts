import test from 'node:test';
import assert from 'node:assert/strict';
import { CREW, layoutCast, paintSprite, spriteGrid, spriteInk } from '../src/game/castSprites.ts';
import { CUTOUT, clearShift, faceFront } from '../src/ui/cutout.ts';
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

test('the cast stands close, bodies overlapping, with every face and hand in view', () => {
  const { body: B, head: D, hand: N } = CUTOUT;
  // Bodies alone may overlap: each the step after the one before.
  const trunk: Cutout = { w: 2, h: 2, cx: 0, part: new Uint8Array([B, B, B, B]) };
  assert.deepEqual(layoutCast([trunk, trunk, trunk], 1).x, [0, 1, 2]);
  assert.deepEqual(layoutCast([trunk, trunk], 3).x, [0, 3]);
  // Nothing comes within a pixel of a head: a head over a body, two wide.
  const headed: Cutout = { w: 2, h: 2, cx: 0, part: new Uint8Array([D, D, B, B]) };
  assert.deepEqual(layoutCast([headed, headed], 1).x, [0, 3]);
  // A hand may cover under half of another, and lie over a body (hands are drawn on top).
  const reach: Cutout = { w: 4, h: 2, cx: 0, part: new Uint8Array([B, B, N, N, B, B, N, N]) };
  const { x, width } = layoutCast([reach, reach], 1);
  // One step over would cover half the first hand; two leaves it whole, under the second body.
  assert.deepEqual(x, [0, 2]);
  assert.equal(width, 7);
  // A hand never covers a head, but may come right up to one: a one-wide dancer with its head
  // on top, then one with a hand held up two to the left of its middle.
  const tall: Cutout = { w: 1, h: 3, cx: 0, part: new Uint8Array([D, B, B]) };
  const raised: Cutout = { w: 3, h: 3, cx: 2, part: new Uint8Array([N, 0, 0, 0, 0, 0, 0, 0, B]) };
  // Two along, the hand would be on the head; three along, it's beside it.
  assert.deepEqual(layoutCast([tall, raised], 2).x, [0, 1]);
  assert.deepEqual(layoutCast([cut]), { x: [0], width: 4 });
});

test('a sprite\'s hands are their own layer, drawn over every body', () => {
  const { body: B, hand: N } = CUTOUT;
  const withHand: Cutout = { w: 2, h: 1, cx: 0, part: new Uint8Array([B, N]) };
  const ink = spriteInk(0)!;
  const body = paintSprite(withHand, 0, 'body'), hands = paintSprite(withHand, 0, 'hands');
  assert.deepEqual(pixel(body, 0, 0), [...ink.fill, 255]);
  assert.deepEqual(pixel(body, 1, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(hands, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(hands, 1, 0), [...ink.fill, 255]);
  // Each layer casts its own shadow.
  assert.deepEqual(pixel(body, 1, 1), [...ink.shadow, 255]);
  assert.deepEqual(pixel(hands, 2, 1), [...ink.shadow, 255]);
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

test('every head gets the same front-facing eyes: two upright lines in its middle', () => {
  const { head: D, eye: E } = CUTOUT;
  // A 9x12 head with a squashed eye where a turn left it, at the 16:9 grid.
  const cut: Cutout = { w: 9, h: 12, cx: 4, part: new Uint8Array(9 * 12).fill(D) };
  cut.part[5 * 9 + 7] = E;
  faceFront(cut, 9.52, 7.14);
  const eyes: string[] = [];
  for (let y = 0; y < cut.h; y++) for (let x = 0; x < cut.w; x++) if (cut.part[y * cut.w + x] === E) eyes.push(`${x},${y}`);
  // Columns 3 and 6, rows 5-7: one pixel wide and three tall, 0.37 units (3 pixels) apart.
  assert.deepEqual(eyes, ['3,5', '6,5', '3,6', '6,6', '3,7', '6,7']);
  // Square pixels (4:3) set them further apart, at the same height.
  const square: Cutout = { w: 12, h: 12, cx: 6, part: new Uint8Array(144).fill(D) };
  faceFront(square, 9.52, 9.52);
  const columns = new Set<number>();
  square.part.forEach((p, i) => { if (p === E) columns.add(i % 12); });
  assert.deepEqual([...columns].sort((a, b) => a - b), [4, 8]);
});
