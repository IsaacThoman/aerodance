import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKED_HANDS, assignSlots, ownHand, personAt, playerRanks, slotsFor, tracksHands, wristsAt } from '../browser/hands.ts';
import { detailHands, handsDetail, isPoseDetail } from '../webcamRecord.ts';

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
  assert.equal(TRACKED_HANDS, 2, 'a worker\'s four WebGL contexts: the pose model\'s, its zoom glances\' or search\'s, and two hands\'');
  assert.ok(tracksHands(2), 'one person\'s two, or two people\'s one each');
  assert.ok(!tracksHands(4), 'two people\'s both');
});

test('players are ranked by where they stand: Player 1 furthest to the camera\'s right', () => {
  assert.deepEqual(playerRanks([at(100), at(500)]), [1, 0]);
  assert.deepEqual(playerRanks([at(500), at(100)]), [0, 1]);
  assert.deepEqual(playerRanks([null, at(100)]), [1, 0], 'someone not placed comes after');
  assert.deepEqual(playerRanks([at(300)]), [0]);
});

test('fresh slots go to the players people stand as; after that, people keep theirs', () => {
  // First seen: the person on the camera's right takes Player 1's slot, whatever order they're reported in.
  assert.deepEqual(assignSlots([null, null], [at(100), at(500)], 160, playerRanks([at(100), at(500)])), [1, 0]);
  // Once placed, where they stood last wins over where they stand now (they crossed over).
  assert.deepEqual(assignSlots([at(330), at(310)], [at(335), at(305)], 160, playerRanks([at(335), at(305)])), [0, 1]);
});

test('until the players are lined up, each person\'s slot is the player they stand as; after that, they keep it', () => {
  // Player 2 (on the camera's left) steps in first and takes a slot; then Player 1 joins on the right.
  const slots: (ReturnType<typeof at> | null)[] = [null, null];
  const alone = slotsFor(slots, [at(100)], 160, playerRanks([at(100)]), false);
  slots[alone[0]] = at(100);
  const both = [at(100), at(500)];
  assert.deepEqual(slotsFor(slots, both, 160, playerRanks(both), false), [1, 0], 'not yet lined up: Player 1\'s slot goes to the person on the right');
  assert.deepEqual(assignSlots(slots, both, 160, playerRanks(both)), [0, 1], '(where they stood last would have kept the first one in it)');
  // Lined up, people keep their slots as they cross.
  assert.deepEqual(slotsFor([at(500), at(100)], [at(330), at(310)], 160, playerRanks([at(330), at(310)]), true), [0, 1]);
  assert.deepEqual(slotsFor([at(500), at(100)], [at(310), at(330)], 160, playerRanks([at(310), at(330)]), false), [1, 0], 'not lined up: by where they stand now');
});

test('a detail asks for each player\'s hands', () => {
  assert.ok(isPoseDetail('hands:right/left') && isPoseDetail('hands:both') && isPoseDetail('world') && isPoseDetail('hands'));
  assert.ok(!isPoseDetail('hands:') && !isPoseDetail('hands:up') && !isPoseDetail('hands:left/right/left/right/left') && !isPoseDetail('right-hand'));
  assert.deepEqual(detailHands('hands'), [['left', 'right']]);
  assert.deepEqual(detailHands('hands:right/left'), [['right'], ['left']]);
  assert.deepEqual(detailHands('hands:both/left'), [['left', 'right'], ['left']]);
  assert.deepEqual(detailHands('world'), []);
  assert.deepEqual(detailHands(null), []);
  assert.equal(handsDetail(['right', 'left']), 'hands:right/left');
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
