import test from 'node:test';
import assert from 'node:assert/strict';
import { CREW, layoutCast, paintSprite, spriteInk } from '../src/game/castSprites.ts';
import { CUTOUT, seams } from '../src/ui/cutout.ts';
import type { Cutout } from '../src/ui/cutout.ts';
import { DANCER_TOP, dancerWidth } from '../src/ui/draw.ts';

const { body: B, head: H, leftHand: L, eye: E } = CUTOUT;
const cutout = (w: number, part: number[], depth = part.map(() => 100), cx = w / 2, ppu = 1): Cutout =>
  ({ w, h: part.length / w, ppu, cx, part: new Uint8Array(part), depth: new Uint8Array(depth) });
const pixel = (s: ReturnType<typeof paintSprite>, x: number, y: number, pad = 4) => {
  const i = ((y + pad) * s.width + x + pad) * 4;
  return [...s.data.slice(i, i + 4)];
};

test('a dancer is shaded from the player\'s light colour at the top to their dark at the bottom, its eyes cut out', () => {
  // A column of four pixels, the second an eye.
  const s = paintSprite(cutout(1, [H, E, B, B]), 0), [light, color] = spriteInk(0);
  assert.deepEqual([s.width, s.height], [9, 12]);
  assert.deepEqual(pixel(s, 0, 0), [...light, 255]);
  assert.deepEqual(pixel(s, 0, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(s, 0, 2), [...color, 255]);
  // Three quarters of the way down: halfway from its colour to its dark.
  const [, , dark] = spriteInk(0);
  assert.deepEqual(pixel(s, 0, 3).slice(0, 3), color.map((c, i) => Math.round(c + (dark[i] - c) / 2)));
  // The padding is clear.
  assert.deepEqual([...s.data.slice(0, 4)], [0, 0, 0, 0]);
});

test('a dancer nobody follows is white, and each player\'s is in their own colours', () => {
  const s = paintSprite(cutout(1, [H, B]), -1);
  assert.deepEqual(pixel(s, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(s, 0, 1), [255, 255, 255, 255]);
  assert.equal(new Set([0, 1, 2, 3].map((id) => spriteInk(id).join())).size, 4);
});

test('a part behind a nearer one is cut away along their seam', () => {
  // A hand in front of the body (nearer), and beside the body at the same depth.
  const front = cutout(4, [B, B, B, L], [100, 100, 100, 200]);
  assert.deepEqual([...seams(front, 1)], [0, 0, 1, 0]);
  assert.deepEqual([...seams(front, 2)], [0, 1, 1, 0]);
  assert.deepEqual([...seams(cutout(2, [B, L]), 1)], [0, 0]);
  // Not between pixels of one part, nor its eyes and head.
  assert.deepEqual([...seams(cutout(2, [B, B], [100, 200]), 1)], [0, 0]);
  assert.deepEqual([...seams(cutout(2, [H, E], [100, 200]), 1)], [0, 0]);
});

test('the cast stands side by side, as tall as the vector dancers', () => {
  const a = cutout(2, [B, B, B, B, B, B], undefined, 1), b = cutout(4, [B, B, B, B, B, B, B, B], undefined, 1);
  // Short poses are drawn as tall as the dancer stands; their pixels a character unit each.
  const at = layoutCast([a, b], DANCER_TOP);
  assert.deepEqual(at.scale, [1, 1]);
  assert.deepEqual(at.x, [0, dancerWidth(DANCER_TOP) * 0.8]);
  assert.equal(at.left, -1);
  assert.equal(at.right, at.x[1] + 3);
  // A taller pose in the crew shrinks every dancer to fit it.
  const tall = cutout(1, Array(68).fill(B), undefined, 0.5, 34 / DANCER_TOP);
  assert.ok(Math.abs(layoutCast([a], DANCER_TOP, [a, tall]).scale[0] - 0.5) < 1e-9);
});

test('the crew is four different moves', () => {
  assert.equal(CREW.length, 4);
  assert.equal(new Set(CREW.map((pose) => JSON.stringify(pose))).size, 4);
  for (const pose of CREW) for (const held of Object.values(pose)) {
    assert.equal(held.length, 7);
    assert.ok(Math.abs(Math.hypot(...held.slice(3)) - 1) < 1e-3);
  }
});
