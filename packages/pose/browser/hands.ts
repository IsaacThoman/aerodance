/*
 * Hands for more than one person (pose.worker.ts). Each Hand Landmarker needs a WebGL context of
 * its own, and Chrome keeps at most four in a worker, dropping the oldest (the pose model's) past
 * that. The pose model has one, and a second pose landmarker may have another (one player's zoom
 * glances, two players' search), which leaves room for TRACKED_HANDS more:
 *
 *  - When the hands asked for fit (one person's two, or two people's paddle hands), each hand has
 *    a landmarker of its own in VIDEO mode, which follows it from frame to frame and skips the
 *    palm search while it keeps it. Each player may want a different hand (a left-handed
 *    player's paddle), so each person's are their player's, as the player tracker numbers them:
 *    until it has lined them up (the first time they're all in view), by where they stand, Player
 *    1 furthest to the camera's right (playerRanks); after that, the pose model reporting people
 *    in no lasting order, by where they stood last (their shoulders' middle in the picture:
 *    slotsFor).
 *  - When they don't (two people's both hands), one landmarker per side is shared, in IMAGE mode,
 *    looking afresh in each person's cuts: about half again the cost per hand, and it finds
 *    fewer.
 *
 * Players can stand close, so a hand found in the square cut round one person's wrist can be the
 * person beside them's: a hand nearer another person's wrist than its own person's is left out.
 */

/** The most people whose hands are looked for. */
export const MAX_HAND_PEOPLE = 2;
/** How many hands can each have a following landmarker (the WebGL contexts a worker has left beside the pose landmarkers'). */
export const TRACKED_HANDS = 2;

/**
 * A paired phone tracking slower than this many poses a second for this long with the hand model
 * on drops it, the world landmarks carrying on (PhoneLink). A webcam never drops them, with one
 * person or two (WebcamPoseSource.dropHands).
 */
export const HANDS_MIN_HZ = 15;
export const HANDS_SLOW_MS = 4000;

export interface PicturePoint { x: number; y: number; }
interface Seen { x: number; y: number; visibility?: number; }

/**
 * A slot whose person hasn't been seen for this long (ms) is free again: they may come back
 * somewhere else, farther than assignSlots lets anybody take a slot from where it was last.
 */
export const SLOT_FORGET_MS = 1000;
/** Sure enough of a joint to place a person by it (as the worker's cuts). */
const SEEN = 0.3;
// MediaPipe pose-33: shoulders, hips and wrists.
const SHOULDERS = [11, 12] as const, HIPS = [23, 24] as const, WRISTS = [15, 16] as const;

const seen = (p: Seen | undefined): p is Seen => !!p && (p.visibility ?? 1) >= SEEN;
const pixels = (p: Seen, width: number, height: number): PicturePoint => ({ x: p.x * width, y: p.y * height });
const dist = (a: PicturePoint, b: PicturePoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whether this many hands (every player's asked for, together) each get a following landmarker (or share one per side). */
export const tracksHands = (handCount: number) => handCount <= TRACKED_HANDS;

/**
 * Which player each person is (0-based), by where they stand: Player 1 furthest to the camera's
 * right, as the mirror shows them on the left, and so on leftwards; anyone not placed after them.
 */
export function playerRanks(people: readonly (PicturePoint | null)[]): number[] {
  const order = people.map((at, i) => ({ at, i })).sort((a, b) => (a.at && b.at ? b.at.x - a.at.x : a.at ? -1 : b.at ? 1 : a.i - b.i));
  const ranks = people.map(() => 0);
  order.forEach(({ i }, rank) => { ranks[i] = rank; });
  return ranks;
}

/** Where a person is in the picture (pixels): their shoulders' middle, else their hips', else null. */
export function personAt(points: readonly Seen[], width: number, height: number): PicturePoint | null {
  for (const [a, b] of [SHOULDERS, HIPS]) {
    if (seen(points[a]) && seen(points[b])) return pixels({ x: (points[a].x + points[b].x) / 2, y: (points[a].y + points[b].y) / 2 }, width, height);
  }
  return null;
}

/** A person's wrists that are seen (pixels). */
export function wristsAt(points: readonly Seen[], width: number, height: number): PicturePoint[] {
  return WRISTS.filter((i) => seen(points[i])).map((i) => pixels(points[i], width, height));
}

/**
 * Which slot each person goes to (a different slot each, -1 for none), given where each slot's
 * person was last seen (null: a slot nobody has had, or whose person was never placed or has been
 * gone a while) and where this frame's people are (null: not placed this frame). The matching that
 * moves people least wins; a slot nobody has had costs `fresh` pixels to take (so a person far from
 * everyone seen before takes it rather than another's slot), a pixel more if it isn't the one
 * `prefer` gives them (the player they stand as: playerRanks). Anybody can go without one, for
 * `fresh` and two pixels more: so a bystander, or a copy of a player the pose model makes from what
 * it can see of them, doesn't take a player's slot only because it's free (and push that player
 * into the other's), and a person farther than that from every slot's person gets none.
 */
export function assignSlots(slots: readonly (PicturePoint | null)[], people: readonly (PicturePoint | null)[], fresh: number, prefer?: readonly number[]): number[] {
  const cost = (slot: number, person: number) => {
    const was = slots[slot], now = people[person];
    if (!was) return fresh + (prefer && prefer[person] !== slot ? 1 : 0);
    // Someone not placed this frame: no evidence either way, so keeping the order costs nothing.
    if (!now) return slot === person ? 0 : fresh;
    return dist(was, now);
  };
  const without = fresh + 2;
  let best: number[] = [], bestCost = Infinity;
  // Every way of giving the people different slots or none (at most a handful: two slots, a few people).
  const walk = (person: number, chosen: number[], total: number) => {
    if (total >= bestCost) return;
    if (person === people.length) { best = chosen.slice(); bestCost = total; return; }
    for (let slot = 0; slot < slots.length; slot++) {
      if (chosen.includes(slot)) continue;
      chosen.push(slot);
      walk(person + 1, chosen, total + cost(slot, person));
      chosen.pop();
    }
    chosen.push(-1);
    walk(person + 1, chosen, total + without);
    chosen.pop();
  };
  walk(0, [], 0);
  return people.map((_, i) => best[i] ?? -1);
}

/**
 * Which slot each person goes to (assignSlots), given whether the player tracker has lined the
 * players up yet. Until then its numbers go by where people stand now (the first one in view isn't
 * Player 1 if they stand to Player 2's side), so slots do too, and only after that by where their
 * people stood last.
 */
export function slotsFor(slots: readonly (PicturePoint | null)[], people: readonly (PicturePoint | null)[], fresh: number, ranks: readonly number[], lined: boolean): number[] {
  return assignSlots(lined ? slots : slots.map(() => null), people, fresh, ranks);
}

/** Whether a hand (its wrist, pixels) is its own person's: no nearer any other person's wrist than to its own. */
export function ownHand(hand: PicturePoint, own: PicturePoint, others: readonly PicturePoint[]): boolean {
  const d = dist(hand, own);
  return others.every((other) => dist(hand, other) >= d);
}

/** Sure enough of a hand's side to move it to the other cut's. */
const SURE = 0.8;
/** A hand found in the cut round one of a person's wrists: the cut's side, its picture points (wrist 0, middle knuckle 9), and the side the Hand Landmarker names it with how sure it is. */
export interface CutHand { side: 'left' | 'right'; named: 'left' | 'right'; score: number; landmarks: readonly PicturePoint[]; }

/** With one side looked for, a hand named the other side is taken for it only with that side's wrist within this many of its sizes. */
const TOGETHER = 2;
/**
 * Each hand found in a person's cuts (`asked`: how many of their sides were looked for) on the
 * side it is. The cuts follow the pose's wrists, and the pose mixes them up when the arms cross,
 * so with both sides looked for, the Hand Landmarker's own handedness puts a hand surely named the
 * other side back on it. With one side looked for (a paddle hand) it does only while the person's
 * other wrist (`wrists`, those seen, in picture fractions; `aspect` the picture's width over its
 * height) is beside the hand, within TOGETHER of its sizes: a hand turned edge-on to the camera, as
 * a paddle is held, is often named the other side. Both players of the first recorded two-player
 * sessions lost their paddle hand to that in 1-3% of their poses, every one looked at the right
 * hand; on trackbench's two-player ping-pong scenes such a hand was the other one 79% of the time
 * with the other wrist beside it, 4% otherwise (1.4% for a hand named its own side).
 */
export function onTheirSides<H extends CutHand>(found: readonly H[], asked: number, wrists: Partial<Record<'left' | 'right', PicturePoint>> = {}, aspect = 4 / 3): H[] {
  if (asked < 2) {
    const d = (a: PicturePoint, b: PicturePoint) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    return found.flatMap(h => {
      const other = wrists[h.side === 'left' ? 'right' : 'left'], [w, middle, index, little] = [0, 9, 5, 17].map(i => h.landmarks[i]);
      const beside = other && d(w, other) < TOGETHER * Math.max(d(w, middle), d(index, little));
      return h.named !== h.side && h.score >= SURE && beside ? [{ ...h, side: h.named }] : [h];
    });
  }
  const [a, b] = found;
  if (a && b) {
    // Both cuts found the same hand (the wrists crossed or met): keep it once, on its own side.
    const palm = Math.hypot(a.landmarks[0].x - a.landmarks[9].x, a.landmarks[0].y - a.landmarks[9].y);
    if (Math.hypot(a.landmarks[0].x - b.landmarks[0].x, a.landmarks[0].y - b.landmarks[0].y) < palm * 0.5) {
      const keep = [a, b].sort((x, y) => y.score - x.score)[0];
      return [{ ...keep, side: keep.named }];
    }
    // Both on the wrong side, surely: the pose swapped the wrists.
    const wrong = (h: H) => h.named !== h.side && h.score >= SURE;
    if (wrong(a) && wrong(b)) return [{ ...a, side: b.side }, { ...b, side: a.side }];
    return [...found];
  }
  // One hand, surely the other side's.
  if (a && a.named !== a.side && a.score >= SURE) return [{ ...a, side: a.named }];
  return [...found];
}
