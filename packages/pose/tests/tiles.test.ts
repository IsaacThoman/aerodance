import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evenTiles, fromTile, hidden, mergeTiles } from '../browser/tiles.ts';

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
  // Nor two people, one partly behind (so higher in the picture) the other, whose torsos are
  // close but whose joints aren't.
  const front = fromTile(person(0.55 / 0.6, { reach: 0.05 }), left);
  const behind = fromTile(person((0.57 - 0.4) / 0.6, { reach: 0.4 }).map(p => ({ ...p, y: p.y - 0.1 })), right);
  assert.equal(mergeTiles([{ points: front, tile: left }, { points: behind, tile: right }], 4 / 3).length, 2);
});

test('a copy two strips disagree about the arms and legs of is still one person', () => {
  const left = { x: 0, width: 0.6 }, right = { x: 0.4, width: 0.6 };
  const fromLeft = fromTile(person(0.5 / 0.6), left);
  // The right strip puts the same torso's elbows, wrists, knees and ankles well off to one side.
  const fromRight = fromTile(person((0.5 - 0.4) / 0.6).map((p, i) => [13, 14, 15, 16, 25, 26, 27, 28].includes(i) ? { ...p, x: p.x + 0.2 } : p), right);
  assert.equal(mergeTiles([{ points: fromLeft, tile: left }, { points: fromRight, tile: right }], 4 / 3).length, 1);
});

test('a strip following somebody another strip keeps, or nobody, has the people the others keep hidden from it next', () => {
  const tiles = evenTiles(3)!;
  // Two people: one in the first strip only, one where the second and third overlap, whom both follow.
  const a = fromTile(person(0.3), tiles[0]);
  const b = fromTile(person((0.65 - tiles[1].x) / tiles[1].width), tiles[1]), copy = fromTile(person((0.65 - tiles[2].x) / tiles[2].width), tiles[2]);
  const found = [{ points: a, tile: tiles[0] }, { points: b, tile: tiles[1] }, { points: copy, tile: tiles[2] }];
  const kept = mergeTiles(found, 4 / 3);
  assert.equal(kept.length, 2);
  const hide = hidden(found, kept, tiles);
  const keeper = kept.includes(b) ? 1 : 2, follower = 3 - keeper;
  assert.deepEqual(hide[0], [], 'a strip whose person is kept sees everything');
  assert.deepEqual(hide[keeper], []);
  // The other strip has the person it copied hidden (and not the first strip's, who isn't in it).
  assert.equal(hide[follower].length, 1);
  const box = hide[follower][0], person2 = kept.includes(b) ? b : copy;
  assert.ok(person2.every(p => p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1), 'all of them');
  // A strip that found nobody has everyone the others keep in it hidden.
  const empty = hidden([{ points: a, tile: tiles[0] }, { points: b, tile: tiles[1] }], [a, b], tiles);
  assert.deepEqual(empty[2].length, 1);
  assert.deepEqual(empty[0], []);
  // Strips each following their own person see everything, neighbours reaching into them too.
  const left = { x: 0, width: 0.6 }, right = { x: 0.4, width: 0.6 };
  const l = fromTile(person(0.36 / 0.6, { reach: 0.08 }), left), r = fromTile(person((0.64 - 0.4) / 0.6, { reach: 0.08 }), right);
  const both = [{ points: l, tile: left }, { points: r, tile: right }];
  assert.deepEqual(hidden(both, mergeTiles(both, 4 / 3), [left, right]), [[], []]);
});
