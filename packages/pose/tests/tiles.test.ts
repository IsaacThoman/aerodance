import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evenTiles, fromTile, mergeTiles, tilesAround, tilesDiffer } from '../browser/tiles.ts';

// Somebody standing with their torso centred at x (a fraction of the strip or picture), arms
// reaching `reach` to each side.
const person = (x: number, { reach = 0.1, confidence = 0.95 } = {}) => Array.from({ length: 33 }, (_, i) => {
  const side = i % 2 ? 1 : -1;
  const dx = i >= 11 && i <= 24 ? ([15, 16, 17, 18, 19, 20, 21, 22].includes(i) ? reach : 0.04) * side : 0;
  return { x: x + dx, y: i < 11 ? 0.2 : i < 23 ? 0.35 : 0.6, z: 0.1, visibility: confidence, presence: confidence };
});
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('three or four players get a strip each, spread across the picture; fewer get none', () => {
  assert.equal(evenTiles(1), null);
  assert.equal(evenTiles(2), null);
  const four = evenTiles(4)!;
  assert.equal(four.length, 4);
  assert.ok(four.every(t => near(t.width, 0.35) && t.x >= 0 && t.x + t.width <= 1));
  assert.ok(near(four[0].x, 0) && near(four[3].x, 0.65), 'the outer strips stay inside the picture');
  assert.equal(evenTiles(3)!.length, 3);
});

test('strips centre on where the players stand, as wide as their spacing allows', () => {
  const tiles = tilesAround([0.7, 0.3, 0.5]);
  assert.deepEqual(tiles.map(t => +(t.x + t.width / 2).toFixed(3)), [0.3, 0.5, 0.7]);
  assert.ok(near(tiles[0].width, 0.3), 'one and a half times the gap, at least 0.3');
  assert.ok(near(tilesAround([0.2, 0.8, 0.5])[0].width, 0.45));
  assert.ok(near(tilesAround([0.1, 0.9])[0].width, 0.5), 'at most half the picture');
  assert.ok(!tilesDiffer(tiles, tilesAround([0.71, 0.3, 0.5]), 0.05));
  assert.ok(tilesDiffer(tiles, tilesAround([0.8, 0.3, 0.5]), 0.05));
});

test('a strip\'s result is put back into the picture, with joints beyond its cut edges unsure', () => {
  const tile = { x: 0.4, width: 0.2 };
  // Arms reaching out past both sides of the strip.
  const raw = person(0.5, { reach: 0.6 }), points = fromTile(raw, tile);
  assert.ok(near(points[11].x, 0.4 + raw[11].x * 0.2), 'x maps into the picture');
  assert.ok(near(points[0].z, 0.02), 'z scales with x');
  assert.ok(points[16].x < 0.4 && points[16].visibility <= 0.2 && points[16].presence <= 0.2, 'a wrist past the left cut is unsure');
  assert.ok(points[15].x > 0.6 && points[15].visibility <= 0.2, 'and past the right one');
  assert.equal(points[11].visibility, 0.95, 'joints inside the strip keep their confidence');
  // The picture's own edges aren't cuts.
  const edge = fromTile(person(0.1, { reach: 0.3 }), { x: 0, width: 0.3 });
  assert.equal(edge[16].visibility, 0.95);
});

test('somebody two strips both see counts once, from the strip they are farther inside', () => {
  const left = { x: 0, width: 0.6 }, right = { x: 0.4, width: 0.6 };
  // The same person at x 0.55 of the picture: near the left strip's cut edge, well inside the right one.
  const fromLeft = fromTile(person(0.55 / 0.6), left), fromRight = fromTile(person((0.55 - 0.4) / 0.6), right);
  const other = fromTile(person(0.2 / 0.6), left);
  const merged = mergeTiles([{ points: fromLeft, tile: left }, { points: other, tile: left }, { points: fromRight, tile: right }], 4 / 3);
  assert.equal(merged.length, 2);
  assert.ok(merged.includes(fromRight) && merged.includes(other), 'the copy from inside the right strip, and the other person');
  // Two people side by side in different strips are both kept.
  const a = fromTile(person(0.5), { x: 0, width: 0.5 }), b = fromTile(person(0.5), { x: 0.5, width: 0.5 });
  assert.equal(mergeTiles([{ points: a, tile: { x: 0, width: 0.5 } }, { points: b, tile: { x: 0.5, width: 0.5 } }], 4 / 3).length, 2);
});
