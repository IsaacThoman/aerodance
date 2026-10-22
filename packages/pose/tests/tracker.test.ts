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
const GREEN = [0.2, 0.6, 0.1, 0.2, 0.6, 0.1, 0.2, 0.6, 0.1];

/** Feeds results at 30 per second from `start`; returns each result's players as playerId → torso x. */
function run(tracker: PlayerTracker, frames: { people: DetectedLandmark[][]; looks?: (number[] | null)[] }[], start = 0) {
  return frames.map(({ people, looks }, i) => new Map(tracker.update(people, INPUT, start + i * 33, looks)
    .map(p => [p.playerId, +((p.landmarks[11].x + p.landmarks[12].x) / 2).toFixed(3)])));
}
const repeat = <T>(n: number, frame: (i: number) => T) => Array.from({ length: n }, (_, i) => frame(i));

test('players are numbered left to right in the mirrored preview once everyone is in view, then followed', () => {
  const tracker = new PlayerTracker(2);
  // The first person in takes a number after two results: P1, whose line-up place they're nearest.
  const first = run(tracker, [{ people: [person(0.7)] }, { people: [person(0.7)] }]);
  assert.equal(first[0].size, 0, 'two results before a number');
  assert.deepEqual([...first[1]], [[0, 0.7]]);
  // A second person stands shoulder to shoulder on their left in the camera picture (the right
  // of the mirrored preview): once both are in view they're numbered left to right in the
  // preview, so P1 is the second person.
  const both = run(tracker, repeat(3, () => ({ people: [person(0.7), person(0.84, { arms: 0.1 })] })), 100);
  assert.deepEqual([...both[2]].sort(), [[0, 0.84], [1, 0.7]]);
  // They walk apart and stay themselves, with no lane edge to lose them at (x = 0.5 was one).
  const walk = run(tracker, repeat(30, i => ({ people: [person(0.7 - i * 0.012), person(0.84 + i * 0.004, { arms: 0.1 })] })), 200);
  assert.ok(walk.every(m => m.size === 2 && m.get(0)! > m.get(1)!), 'both followed throughout');
});

test('a player who walks to where a missing player stood keeps their own number', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(20, () => ({ people: [person(0.7), person(0.3, { arms: 0.1 })] })));
  // P1 leaves; P2 walks over to P1's place and stays there.
  run(tracker, repeat(90, () => ({ people: [person(0.3, { arms: 0.1 })] })), 700);
  const walk = run(tracker, repeat(60, i => ({ people: [person(0.3 + Math.min(1, i / 40) * 0.4, { arms: 0.1 })] })), 3700);
  assert.ok(walk.every(m => m.size === 1 && m.has(1)), 'still P2');
});

test('one player is found at once, and a passer-by can neither push them out nor take their number', () => {
  const tracker = new PlayerTracker(1);
  assert.deepEqual([...run(tracker, [{ people: [person(0.5)] }])[0]], [[0, 0.5]]);
  const passing = run(tracker, repeat(40, i => ({ people: [person(0.5), person(0.05 + i * 0.025, { size: 0.7, arms: 0.2 })] })), 33);
  assert.ok(passing.every(m => m.get(0) === 0.5), 'the player keeps their number while somebody walks past');
});

test('a player standing where a long-gone player stood keeps their number through a moment unseen', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(30, () => ({ people: [person(0.3, { arms: 0.1 }), person(0.7)] })));
  // P1 (0.7) leaves; P2 walks over to P1's old place and stands there; the model misses them.
  run(tracker, repeat(90, () => ({ people: [person(0.3, { arms: 0.1 })] })), 1000);
  run(tracker, repeat(40, i => ({ people: [person(0.3 + 0.4 * i / 39, { arms: 0.1 })] })), 4000);
  run(tracker, repeat(30, () => ({ people: [person(0.7, { arms: 0.1 })] })), 5400);
  run(tracker, repeat(9, () => ({ people: [] })), 6400);
  const back = run(tracker, repeat(30, () => ({ people: [person(0.7, { arms: 0.1 })] })), 6700);
  assert.deepEqual([...back.at(-1)!], [[1, 0.7]]);
});

test('a player missed for a moment beside a missing player\'s place isn\'t taken for them', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(30, () => ({ people: [person(0.62), person(0.38, { arms: 0.1 })] })));
  // P2 steps out; P1 drifts over toward P2's place, then walks back and is missed as P2 steps back in.
  run(tracker, repeat(18, () => ({ people: [person(0.62)] })), 1000);
  run(tracker, repeat(30, i => ({ people: [person(0.62 - 0.2 * Math.min(1, i / 20))] })), 1600);
  run(tracker, repeat(9, () => ({ people: [] })), 2600);
  const back = run(tracker, repeat(60, i => ({ people: [person(0.38, { arms: 0.1 }), ...(i >= 6 ? [person(0.62)] : [])] })), 2900);
  assert.deepEqual([...back.at(-1)!].sort(), [[0, 0.62], [1, 0.38]]);
});

test('a player whose number went to a bystander gets it back at their place, though the model keeps missing them', () => {
  const tracker = new PlayerTracker(2);
  const by = () => person(0.05, { size: 0.6, arms: 0.2 });
  run(tracker, repeat(300, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()] })));
  run(tracker, repeat(180, () => ({ people: [person(0.6), by()] })), 10000);
  // Back at their place, standing there, missed in one result in three.
  const back = run(tracker, repeat(60, i => ({ people: [person(0.6), ...(i % 3 === 2 ? [] : [person(0.25, { arms: 0.1 })]), by()] })), 16000);
  assert.ok(back.slice(-30).every((m, i) => m.get(1) === (i % 3 === 2 ? undefined : 0.25)), 'P2 again, whenever seen');
});

test('one player is found again anywhere, dressed differently', () => {
  const tracker = new PlayerTracker(1);
  run(tracker, repeat(60, () => ({ people: [person(0.9)], looks: [RED] })));
  run(tracker, repeat(90, () => ({ people: [] })), 2000);
  // Back on the far side in a jacket (or a sibling taking a turn): looks don't keep them out.
  const back = run(tracker, repeat(30, () => ({ people: [person(0.15)], looks: [BLUE] })), 5000);
  assert.deepEqual([...back.at(-1)!], [[0, 0.15]]);
});

test('a player who comes back elsewhere, recognised by their clothes, leaves nothing for somebody lingering at their old place', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 })], looks: [RED, BLUE] })));
  run(tracker, repeat(180, () => ({ people: [person(0.6)], looks: [RED] })), 2000);
  run(tracker, repeat(90, () => ({ people: [person(0.6), person(0.85, { arms: 0.1 })], looks: [RED, BLUE] })), 8000);
  // Somebody walks slowly to P2's old place, turns round there and walks off, while the model
  // misses P2 (so P2's clothes can't be compared with theirs).
  const walk = run(tracker, repeat(80, i => {
    const passer = person(0.02 + (i < 40 ? i : 80 - i) * 0.006, { arms: 0.2 });
    return i > 30 && i < 50 ? { people: [person(0.6), passer], looks: [RED, GREEN] } : { people: [person(0.6), person(0.85, { arms: 0.1 }), passer], looks: [RED, BLUE, GREEN] };
  }), 11000);
  assert.ok(walk.every(m => m.get(1) === undefined || m.get(1) === 0.85), 'P2 is never the passer-by');
});

test('a bystander missed for a moment is still a bystander', () => {
  const tracker = new PlayerTracker(2);
  const by = () => person(0.05, { size: 0.6, arms: 0.2 });
  run(tracker, repeat(300, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()] })));
  run(tracker, repeat(35, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 })] })), 10000);
  // Back in view as P2 steps out: they don't take P2's number when P2 has only just gone.
  const out = run(tracker, repeat(36, () => ({ people: [person(0.6), by()] })), 11200);
  assert.ok(out.every(m => !m.has(1)), 'P2 kept');
  const back = run(tracker, repeat(10, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()] })), 12400);
  assert.deepEqual([...back.at(-1)!].sort(), [[0, 0.6], [1, 0.25]]);
});

test('a player who comes back somewhere else doesn\'t lose their number to a passer-by at their old place', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 })] })));
  run(tracker, repeat(180, () => ({ people: [person(0.6)] })), 2000);
  // P2 comes back a while later beyond P1 (the camera's right of the line-up), then somebody
  // farther back walks across behind them, through P2's old place.
  const back = run(tracker, repeat(90, () => ({ people: [person(0.6), person(0.85, { arms: 0.1 })] })), 8000);
  assert.equal(back.at(-1)!.get(1), 0.85, 'P2 is back');
  const walk = run(tracker, repeat(120, i => ({ people: [person(0.6), person(0.85, { arms: 0.1 }), person(0.02 + i * 0.008, { size: 0.6, arms: 0.2 })] })), 11000);
  assert.ok(walk.every(m => m.get(1) === undefined || m.get(1) === 0.85), 'P2 is never the passer-by');
});

test('a passer-by their size walking through a player\'s old place doesn\'t get their number either', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 })] })));
  run(tracker, repeat(180, () => ({ people: [person(0.6)] })), 2000);
  run(tracker, repeat(90, () => ({ people: [person(0.6), person(0.85, { arms: 0.1 })] })), 8000);
  const walk = run(tracker, repeat(50, i => ({ people: [person(0.6), person(0.85, { arms: 0.1 }), person(0.02 + i * 0.012, { arms: 0.2 })] })), 11000);
  assert.ok(walk.every(m => m.get(1) === undefined || m.get(1) === 0.85), 'P2 is never the passer-by');
});

test('the people in front are numbered before somebody farther back', () => {
  // Two players and, between them and farther back, somebody watching: all in view from the start.
  const tracker = new PlayerTracker(2);
  const results = run(tracker, repeat(30, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), person(0.75, { size: 0.6, arms: 0.2 })] })));
  assert.deepEqual([...results.at(-1)!].sort(), [[0, 0.6], [1, 0.25]]);
});

test('somebody overlapping a player (a ghost of them) isn\'t a bystander, so the player can still be followed', () => {
  const tracker = new PlayerTracker(2);
  // The model keeps reporting a second, offset copy of P2 beside them.
  run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), person(0.3, { arms: 0.4 })] })));
  // Then just P2, where the copy was.
  const after = run(tracker, repeat(30, () => ({ people: [person(0.6), person(0.3, { arms: 0.4 })] })), 2000);
  assert.deepEqual([...after.at(-1)!].sort(), [[0, 0.6], [1, 0.3]]);
});

test('a bystander is known as one even after a player has left for good', () => {
  const tracker = new PlayerTracker(3);
  run(tracker, repeat(30, () => ({ people: [person(0.8), person(0.5, { arms: 0.1 }), person(0.2, { arms: 0.2 })] })));
  // P3 leaves for good; a bystander farther back watches beside P1 and P2.
  run(tracker, repeat(300, () => ({ people: [person(0.8), person(0.5, { arms: 0.1 }), person(0.05, { size: 0.6, arms: 0.3 })] })), 1000);
  // P1 is out of sight for two and a half seconds: the bystander doesn't take P1's number.
  const out = run(tracker, repeat(75, () => ({ people: [person(0.5, { arms: 0.1 }), person(0.05, { size: 0.6, arms: 0.3 })] })), 11000);
  assert.ok(out.every(m => !m.has(0)), 'P1 kept');
});

test('a player isn\'t given another player\'s person while that one is only just out of sight', () => {
  const tracker = new PlayerTracker(2);
  const by = () => person(0.93, { size: 0.6, arms: 0.2 });
  run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()], looks: [RED, BLUE, GREEN] })));
  // P1 is missed for three results while P2's clothes read like P1's (a reflection, a shadow).
  run(tracker, repeat(3, () => ({ people: [person(0.25, { arms: 0.1 }), by()], looks: [RED, GREEN] })), 2000);
  const after = run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()], looks: [RED, BLUE, GREEN] })), 2100);
  assert.ok(after.every(m => m.get(1) !== 0.93 && m.get(0) !== 0.93), 'nobody on the bystander');
  assert.deepEqual([...after.at(-1)!].sort(), [[0, 0.6], [1, 0.25]]);
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

test('a bystander who takes the number of a player gone a while gives it back when they return', () => {
  for (const bystander of [0.05, 0.93]) {
    const tracker = new PlayerTracker(2);
    const by = () => person(bystander, { size: 0.6, arms: 0.2 });
    run(tracker, repeat(300, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()] })));
    // P2 leaves for six seconds: after five the bystander may play instead...
    const away = run(tracker, repeat(180, () => ({ people: [person(0.6), by()] })), 10000);
    assert.equal(away.at(-1)!.get(1), bystander, 'the bystander takes P2');
    // ...but P2 coming back to their place has it back.
    const back = run(tracker, repeat(30, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()] })), 16000);
    assert.deepEqual([...back.at(-1)!].sort(), [[0, 0.6], [1, 0.25]]);
  }
});

test('somebody dressed like a player does not take their number when the player hides their clothes for a moment', () => {
  const tracker = new PlayerTracker(2);
  const by = () => person(0.93, { size: 0.6, arms: 0.2 });
  run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()], looks: [RED, BLUE, RED] })));
  // P1 folds their arms over their shirt: they look unlike themselves for a few results.
  const covered = [0.45, 0.25, 0.1, 0.45, 0.25, 0.1, 0.45, 0.25, 0.1];
  run(tracker, repeat(15, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()], looks: [covered, BLUE, RED] })), 2000);
  const after = run(tracker, repeat(60, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), by()], looks: [RED, BLUE, RED] })), 2500);
  assert.deepEqual([...after.at(-1)!].sort(), [[0, 0.6], [1, 0.25]]);
});

test('a player whose number went to a bystander takes it back, told by their looks', () => {
  const tracker = new PlayerTracker(2);
  const by = () => person(0.05, { size: 0.6, arms: 0.2 });
  run(tracker, repeat(300, () => ({ people: [person(0.6), person(0.3, { arms: 0.1 }), by()], looks: [RED, BLUE, GREEN] })));
  run(tracker, repeat(600, () => ({ people: [person(0.6), by()], looks: [RED, GREEN] })), 10000);
  // P2 comes back somewhere else, which their place can't tell, but their clothes can (even when
  // the model misses them once, and can't read their clothes once, at first).
  const back = run(tracker, repeat(60, i => i === 3 ? { people: [person(0.6), by()], looks: [RED, GREEN] }
    : { people: [person(0.6), person(0.85, { arms: 0.1 }), by()], looks: [RED, i === 6 ? null : BLUE, GREEN] }), 30000);
  assert.deepEqual([...back.at(-1)!].sort(), [[0, 0.6], [1, 0.85]]);
});

test('players who overlap and part again are put back in their order, or told apart by their looks', () => {
  // Two people meet in the middle, overlapping, where the model's results cross (each result
  // nearer the other person's last place), and part: back where they came from, or crossed over.
  const meet = (crossed: boolean, looks: boolean) => {
    const tracker = new PlayerTracker(2);
    const frame = (red: number, blue: number) => ({ people: [person(red), person(blue, { arms: 0.1 })], ...(looks ? { looks: [RED, BLUE] } : {}) });
    run(tracker, repeat(20, () => frame(0.3, 0.7)));
    run(tracker, repeat(12, i => frame(0.3 + i * 0.016, 0.7 - i * 0.016)), 700);
    run(tracker, repeat(4, () => frame(0.53, 0.47)), 1100);
    const end = crossed ? 0.7 : 0.3;
    return run(tracker, repeat(15, i => frame(0.5 + (end - 0.5) * Math.min(1, (i + 1) / 10), 0.5 - (end - 0.5) * Math.min(1, (i + 1) / 10))), 1240).at(-1)!;
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

test('a player whose clothes change isn\'t taken for another player they only look less unlike', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(30, () => ({ people: [person(0.3), person(0.7, { arms: 0.1 })], looks: [RED, BLUE] })));
  // P2 (in red) takes their jacket off while P1 (in blue) is out of sight: now nearer blue than
  // red, but nothing like either.
  const changed = BLUE.map((v, i) => 0.65 * v + 0.35 * RED[i]);
  const after = run(tracker, repeat(30, () => ({ people: [person(0.3)], looks: [changed] })), 1000);
  assert.ok(after.every(m => !m.has(0)), 'never P1');
});

test('a player isn\'t carried off by somebody smaller (farther back) passing where they are missed', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(20, () => ({ people: [person(0.6), person(0.25, { arms: 0.1 })] })));
  // The model misses P1 just as a passer-by, half their size, walks across behind them.
  const passing = run(tracker, [
    ...repeat(3, i => ({ people: [person(0.25, { arms: 0.1 }), person(0.6 + i * 0.03, { size: 0.5, arms: 0.2 })] })),
    ...repeat(10, i => ({ people: [person(0.6), person(0.25, { arms: 0.1 }), person(0.69 + i * 0.03, { size: 0.5, arms: 0.2 })] })),
  ], 700);
  assert.ok(passing.every(m => m.get(0) === undefined || m.get(0) === 0.6), 'P1 is never the passer-by');
  assert.equal(passing.at(-1)!.get(0), 0.6);
});

test('a missing player doesn\'t take their neighbour, who is being followed toward their place', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(20, () => ({ people: [person(0.62), person(0.45, { arms: 0.1 })] })));
  // P2 is missed while P1 lurches toward where P2 stood: nearer P1's last place than P2's.
  const lurch = run(tracker, repeat(30, i => ({ people: [person(0.62 - Math.min(1, i / 15) * 0.09 + (i % 2 ? 0.025 : -0.025), { arms: 0.15 * (i % 3) })] })), 700);
  assert.ok(lurch.every(m => !m.has(1)), 'never P2');
});

test('a missing player\'s number doesn\'t go to somebody new beyond another player', () => {
  const tracker = new PlayerTracker(3);
  run(tracker, repeat(20, () => ({ people: [person(0.8), person(0.5, { arms: 0.1 }), person(0.2, { arms: 0.2 })] })));
  run(tracker, repeat(60, () => ({ people: [person(0.5, { arms: 0.1 }), person(0.2, { arms: 0.2 })] })), 700);
  // Two seconds after P1 (on the camera's right) left, somebody steps in between P2 and P3.
  const newcomer = run(tracker, repeat(40, () => ({ people: [person(0.5, { arms: 0.1 }), person(0.2, { arms: 0.2 }), person(0.35, { arms: 0.25 })] })), 2700);
  assert.deepEqual([...newcomer.at(-1)!].sort(), [[1, 0.5], [2, 0.2]]);
});

test('players merged into one result are told apart again when they part', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(20, () => ({ people: [person(0.3), person(0.7, { arms: 0.1 })] })));
  run(tracker, repeat(12, i => ({ people: [person(0.3 + i * 0.016), person(0.7 - i * 0.016, { arms: 0.1 })] })), 700);
  // The model sees one of them while they overlap, and its one result slides onto the other one.
  run(tracker, repeat(10, i => ({ people: [person(0.49 + i * 0.006, { arms: 0.1 })] })), 1100);
  const parted = run(tracker, repeat(30, i => ({ people: [person(0.55 + Math.min(1, i / 10) * 0.15, { arms: 0.1 }), person(0.45 - Math.min(1, i / 10) * 0.15)] })), 1450);
  assert.deepEqual([...parted.at(-1)!].sort(), [[0, 0.7], [1, 0.3]], 'each back on their own side');
});

test('players back from a while away are told apart by their looks at once', () => {
  const tracker = new PlayerTracker(2);
  run(tracker, repeat(30, () => ({ people: [person(0.3), person(0.7, { arms: 0.1 })], looks: [RED, BLUE] })));
  run(tracker, repeat(60, () => ({ people: [] })), 1000);
  // They come back on each other's sides: their places say otherwise, their clothes don't.
  const back = run(tracker, repeat(2, () => ({ people: [person(0.7), person(0.3, { arms: 0.1 })], looks: [RED, BLUE] })), 3000);
  assert.deepEqual([...back[1]].sort(), [[0, 0.3], [1, 0.7]]);
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
