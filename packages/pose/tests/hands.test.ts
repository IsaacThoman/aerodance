import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKED_HANDS, assignSlots, ownHand, personAt, tracksHands, wristsAt } from '../browser/hands.ts';

const W = 640, H = 480;
const at = (x: number, y = 200) => ({ x, y });
/** A person facing the camera, their middle at picture fraction x; joints seen unless listed. */
function person(x: number, unseen: number[] = []) {
  const points = Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 1 }));
  const set = (i: number, dx: number, y: number) => { points[i] = { x: x + dx, y, visibility: unseen.includes(i) ? 0 : 1 }; };
  set(11, 0.06, 0.35); set(12, -0.06, 0.35); set(23, 0.04, 0.6); set(24, -0.04, 0.6);
  set(15, 0.12, 0.5); set(16, -0.12, 0.5);
  return points;
}

test('one person\'s two hands or two people\'s one each are followed; two people\'s both hands share a pair', () => {
  assert.equal(TRACKED_HANDS, 2, 'a worker\'s four WebGL contexts: the pose model\'s, two hands\', one to spare');
  assert.ok(tracksHands(1, 2));
  assert.ok(tracksHands(2, 1));
  assert.ok(!tracksHands(2, 2));
});

test('a person is placed by their shoulders, else their hips, else not at all; their wrists are the ones seen', () => {
  assert.deepEqual(personAt(person(0.5), W, H), { x: 0.5 * W, y: 0.35 * H });
  assert.deepEqual(personAt(person(0.5, [11]), W, H), { x: 0.5 * W, y: 0.6 * H });
  assert.equal(personAt(person(0.5, [11, 23]), W, H), null);
  assert.equal(wristsAt(person(0.5), W, H).length, 2);
  assert.deepEqual(wristsAt(person(0.5, [15]), W, H), [{ x: 0.38 * W, y: 0.5 * H }]);
});

test('people keep their slots whatever order the pose model reports them in', () => {
  const slots = [at(200), at(450)];
  assert.deepEqual(assignSlots(slots, [at(205), at(440)], 160), [0, 1]);
  assert.deepEqual(assignSlots(slots, [at(440), at(205)], 160), [1, 0], 'reported the other way round');
  // Crossing over, a frame at a time: still the nearest.
  assert.deepEqual(assignSlots([at(300), at(340)], [at(335), at(305)], 160), [1, 0]);
});

test('the first frame takes the slots in order; a newcomer takes a free slot rather than another\'s', () => {
  assert.deepEqual(assignSlots([null, null], [at(100), at(500)], 160), [0, 1]);
  // One person seen so far, in slot 1; someone new far from them takes slot 0.
  assert.deepEqual(assignSlots([null, at(500)], [at(100), at(505)], 160), [0, 1]);
  // One person alone keeps their slot.
  assert.deepEqual(assignSlots([at(100), at(500)], [at(495)], 160), [1]);
  // Someone not placed this frame (shoulders and hips unseen) keeps the order.
  assert.deepEqual(assignSlots([at(100), at(500)], [null, at(495)], 160), [0, 1]);
});

test('more people than slots: the ones that fit worst go without, so a bystander doesn\'t take a player\'s slot', () => {
  assert.deepEqual(assignSlots([at(100), at(300)], [at(100), at(300), at(500)], 160), [0, 1, -1]);
  assert.deepEqual(assignSlots([at(100)], [at(500), at(100)], 160), [-1, 0]);
  assert.deepEqual(assignSlots([null], [at(500), at(100)], 160), [0, -1], 'nobody seen yet: the first');
});

test('a hand nearer another person\'s wrist than its own person\'s isn\'t theirs', () => {
  const own = at(300), other = at(360);
  assert.ok(ownHand(at(310), own, [other]));
  assert.ok(!ownHand(at(350), own, [other]), 'the person beside them\'s');
  assert.ok(ownHand(at(350), own, []), 'alone, any hand found is theirs');
});
