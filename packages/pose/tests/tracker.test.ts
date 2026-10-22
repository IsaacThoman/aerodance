import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayerTracker } from '../browser/tracker.ts';
import { describeLooks } from '../browser/appearance.ts';
import type { DetectedLandmark } from '../browser/slots.ts';

const INPUT = { width: 640, height: 480 };
// What MediaPipe reports for somebody standing with their torso centred at (cx, cy) in the
// unmirrored camera picture: `size` scales them (smaller is farther back), `arms` raises their
// wrists (so two people side by side don't have the same joints).
function person(cx: number, { size = 1, arms = 0, cy = 0.45, confidence = 0.95 } = {}): DetectedLandmark[] {
  const at = (dx: number, dy: number) => ({ x: cx + dx * size, y: cy + dy * size, z: 0, visibility: confidence, presence: confidence });
  const p: DetectedLandmark[] = Array.from({ length: 33 }, () => at(0, -0.25));
  [[11, 0.07, -0.13], [13, 0.085, -0.01], [15, 0.09, 0.1 - arms], [23, 0.045, 0.11], [25, 0.05, 0.27], [27, 0.05, 0.43]]
    .forEach(([i, dx, dy]) => { p[i] = at(dx, dy); p[i + 1] = at(-dx, dy); });
  return p;
}
const RED = [0.6, 0.2, 0.1, 0.6, 0.2, 0.1, 0.6, 0.2, 0.1], BLUE = [0.15, 0.25, 0.1, 0.15, 0.25, 0.1, 0.15, 0.25, 0.1];

/** Feeds results at 30 per second from `start`; returns each result's players as playerId → torso x. */
function run(tracker: PlayerTracker, frames: { people: DetectedLandmark[][]; looks?: (number[] | null)[] }[], start = 0) {
  return frames.map(({ people, looks }, i) => new Map(tracker.update(people, INPUT, start + i * 33, looks)
    .map(p => [p.playerId, +((p.landmarks[11].x + p.landmarks[12].x) / 2).toFixed(3)])));
}
const repeat = <T>(n: number, frame: (i: number) => T) => Array.from({ length: n }, (_, i) => frame(i));

test('players are numbered left to right in the mirrored preview once everyone is in view, then followed', () => {
  const tracker = new PlayerTracker(2);
  // The first person in takes a number after two results; a second person then the other one.
  const first = run(tracker, [{ people: [person(0.3)] }, { people: [person(0.3)] }]);
  assert.equal(first[0].size, 0, 'two results before a number');
  assert.equal(first[1].size, 1);
  const both = run(tracker, repeat(3, () => ({ people: [person(0.3), person(0.7, { arms: 0.1 })] })), 100);
  // P1 on the left of the mirrored preview: the camera's right, larger x.
  assert.deepEqual([...both[2]].sort(), [[0, 0.7], [1, 0.3]]);
  // They walk apart and stay themselves, with no lane edge to lose them at (x = 0.5 was one).
  const walk = run(tracker, repeat(30, i => ({ people: [person(0.3 + i * 0.008), person(0.7 + i * 0.006, { arms: 0.1 })] })), 200);
  assert.ok(walk.every(m => m.size === 2 && m.get(0)! > m.get(1)!), 'both followed throughout');
});

test('one player is found at once, and a passer-by can neither push them out nor take their number', () => {
  const tracker = new PlayerTracker(1);
  assert.deepEqual([...run(tracker, [{ people: [person(0.5)] }])[0]], [[0, 0.5]]);
  const passing = run(tracker, repeat(40, i => ({ people: [person(0.5), person(0.05 + i * 0.025, { size: 0.7, arms: 0.2 })] })), 33);
  assert.ok(passing.every(m => m.get(0) === 0.5), 'the player keeps their number while somebody walks past');
});

test('a missing player comes back to their number, and a bystander beside the players does not take it', () => {
  const tracker = new PlayerTracker(2);
  const lineUp = () => ({ people: [person(0.25), person(0.6, { arms: 0.1 }), person(0.92, { size: 0.6, arms: 0.2 })] });
  // Two players and, at the edge, a bystander who is in view all along.
  run(tracker, repeat(30, lineUp));
  // P1 (camera's right of the players, x 0.6) vanishes for a second: the bystander stays a bystander.
  const gone = run(tracker, repeat(30, () => ({ people: [person(0.25), person(0.92, { size: 0.6, arms: 0.2 })] })), 1000);
  assert.ok(gone.every(m => !m.has(0) && m.get(1) === 0.25), 'nobody takes the missing player\'s number');
  const back = run(tracker, repeat(3, lineUp), 2000);
  assert.deepEqual([...back[2]].sort(), [[0, 0.6], [1, 0.25]], 'the player is back as P1');
});

test('players who overlap and part again are put back in their order, or told apart by their looks', () => {
  // Two people walk together, overlap (the model sees one of them), and walk apart: back to the
  // sides they came from, or having crossed.
  const meet = (crossed: boolean, looks: boolean) => {
    const tracker = new PlayerTracker(2);
    const frame = (red: number, blue: number) => ({ people: [person(red), person(blue, { arms: 0.1 })], ...(looks ? { looks: [RED, BLUE] } : {}) });
    run(tracker, repeat(20, () => frame(0.3, 0.7)));
    run(tracker, repeat(12, i => frame(0.3 + i * 0.015, 0.7 - i * 0.015)), 700);
    run(tracker, repeat(10, () => ({ people: [person(0.5)], ...(looks ? { looks: [RED] } : {}) })), 1100);
    const end = crossed ? 0.7 : 0.3;
    return run(tracker, repeat(15, i => frame(0.5 + (end - 0.5) * Math.min(1, (i + 1) / 10), 0.5 - (end - 0.5) * Math.min(1, (i + 1) / 10))), 1430).at(-1)!;
  };
  // P1 is the blue one (on the camera's right at first), P2 the red one.
  assert.deepEqual([...meet(false, false)].sort(), [[0, 0.7], [1, 0.3]], 'back in order');
  assert.deepEqual([...meet(false, true)].sort(), [[0, 0.7], [1, 0.3]], 'back in order, looks agreeing');
  assert.deepEqual([...meet(true, true)].sort(), [[0, 0.3], [1, 0.7]], 'crossed, told apart by looks');
  // Without looks, crossing over while overlapping can't be told from parting where they were.
  assert.deepEqual([...meet(true, false)].sort(), [[0, 0.7], [1, 0.3]], 'crossed unseen: put back in order');
});

test('a player following the wrong person is put right by their looks', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(20, () => ({ people: [person(0.3), person(0.7, { arms: 0.1 })], looks: [RED, BLUE] })));
  // The model's results swap who is where in one step (each person jumps to the other's side
  // too far to follow), but say so by their looks: within a few results the numbers follow them.
  const after = run(tracker, repeat(20, () => ({ people: [person(0.62), person(0.38, { arms: 0.1 })], looks: [RED, BLUE] })), 700);
  assert.deepEqual([...after.at(-1)!].sort(), [[0, 0.38], [1, 0.62]]);
});

test('ghosts, unreliable torsos and broken landmarks are not players', () => {
  const tracker = new PlayerTracker(2);
  const ghost = person(0.31).map(p => ({ ...p, x: p.x + 0.003 }));
  const unreliable = person(0.7); unreliable[23] = { ...unreliable[23], visibility: 0.1 };
  const broken = person(0.5); broken[1] = { ...broken[1], x: NaN };
  const results = run(tracker, repeat(5, () => ({ people: [person(0.3), ghost, unreliable, broken] })));
  assert.deepEqual(results.map(m => m.size), [0, 1, 1, 1, 1], 'one person, after two results');
});

test('looks are the clothes\' colours on the chest, waist and thighs', () => {
  // A picture that is red above y = 0.5 and blue below.
  const width = 64, height = 48, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(y < height / 2 ? [200, 0, 0, 255] : [0, 0, 200, 255], (y * width + x) * 4);
  const looks = describeLooks({ data, width, height }, person(0.5, { cy: 0.4 }));
  assert.ok(looks);
  assert.deepEqual(looks.slice(0, 2), [1, 0], 'red chest');
  assert.deepEqual(looks.slice(6, 8), [0, 0], 'blue thighs');
  const unreliable = person(0.5); unreliable[11] = { ...unreliable[11], visibility: 0.2 };
  assert.equal(describeLooks({ data, width, height }, unreliable), null);
});
