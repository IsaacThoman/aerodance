import { validatePoses } from '../choreography.ts';
import type { FrameSize, Landmark, PlayerCount, Pose } from '../choreography.ts';
import { detectedConfidence } from './slots.ts';
import type { DetectedLandmark } from './slots.ts';

/*
 * Who is who in the camera picture. MediaPipe reports the people it finds in no stable order,
 * and often misses one for a few frames, so each player is a person followed from frame to
 * frame, with a place in the line-up:
 *
 * - Each result's people are given to players all at once, in the cheapest way: a player just
 *   seen takes the person where they were heading (and nobody farther than that); a player
 *   missing for a moment takes a person seen twice near their place; and nobody's place in the
 *   left-to-right line-up changes unless they were followed through it. What a person looks
 *   like (their clothes' colours, appearance.ts) counts too, once it tells the players apart.
 * - A player's place is where they last stood clear of the others. Until everyone has been in
 *   view at once, numbers are provisional; then the players are numbered left to right (P1 on
 *   the left of the mirrored preview), and from then on each number follows its person.
 * - Players who come close enough to overlap can't be told apart by where they are, and the
 *   model may swap or merge them. Such players are tangled until they're apart again; then
 *   they're told apart by their looks when those differ clearly, and otherwise put back in the
 *   order they stood in before.
 * - A player whose person has looked like another player for a while becomes that player, and
 *   one whose person doesn't look like them while somebody else in view does takes them back.
 *
 * The camera looks for one more person than there are players, so a passer-by can't push a
 * player out of the model's results. Extra people are ignored while every player is found, and
 * somebody who has been in view beside all the players is a bystander: they can take a missing
 * player's number only once that player has been gone a while.
 */

const TORSO = [11, 12, 23, 24];
// Shoulders, elbows, wrists, hips, knees, ankles: what tells two people apart up close.
const LIMBS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const RELIABLE = 0.5;
/** Velocity decays over this long, so a prediction never runs far. */
const VELOCITY_MS = 300;
/** A player seen this recently is followed by motion; after that, found again near their place. */
const FRESH_MS = 250;
/** How far (in body sizes) a followed player may be from their prediction. */
const GATE = 0.7;
/** How far from their place a missing player may be found again: grows the longer they're gone. */
const RETURN = 1.0, RETURN_GROWTH = 2.0;
/** A player missing this long can be found anywhere, and gives up their number to a new person. */
const RESERVE_MS = 1500;
/** A person seen again within this long (near where they were) is the same person. */
const SEEN_GAP_MS = 1000;
/** Somebody seen in this many results beside all the players is a bystander... */
const BYSTANDER = 10;
/** ...who can only take the number of a player gone this long. */
const LONG_MS = 5000;
/**
 * Players closer than this (in body sizes) overlap; farther than APART they're clearly apart.
 * Side by side, shoulder to shoulder, two people are about 0.75 apart.
 */
const CLOSE = 0.6, APART = 0.9;
/** Tangled players untangle within this long of last overlapping, or not at all. */
const TANGLE_MS = 5000;
/** Frames of clear looks before they count. */
const LOOKS_SAMPLES = 5;
/** Players whose looks differ this much (mean per channel) can be told apart by them. */
const DISTINCT = 0.06;
/** A player whose person has looked this much more like another player's, lately, is that player. */
const DOUBT = 0.015;
/** A player's person looking this unlike them may be somebody else... */
const STRANGER = 0.05;
/** ...and somebody else in view looking this much more like them, lately, is them. */
const RECLAIM = 0.03;
/** How fast a player's looks are learnt: from a person who looks like them, or (slowly) unlike them. */
const LEARN = 0.1, LEARN_STRANGER = 0.01;
// Costs, in body sizes of mismatch: a player goes unmatched rather than pay MISS.
const MISS = 4, MOTION = 1, PLACE = 0.3, NEW = 1.5, ORDER = 3, LOOKS = 10, LOOKS_CAP = 2;

interface Body {
  landmarks: Landmark[];
  /** Torso centre, in picture heights (x scaled by the aspect ratio). */
  x: number; y: number;
  /** Torso length or shoulder width, whichever says more: the body's size in the picture. */
  scale: number;
  /** LIMBS in picture heights; null where unreliable. */
  limbs: ({ x: number; y: number } | null)[];
  /** What the person looks like (appearance.ts), when known. */
  looks: readonly number[] | null;
  /** When this result was taken. */
  seen: number;
  /** The same number for the same person from result to result (while they stay in view)... */
  chain: number;
  /** ...how many recent results they were in, this one included... */
  hits: number;
  /** ...and in how many every player was found without them. */
  extra: number;
}
interface Track { body: Body; vx: number; vy: number; seen: number; }
interface Player {
  track: Track | null;
  /** Where they last stood clear of everyone else (their line-up place until then). */
  place: number;
  /** Their looks, averaged over frames where they stood clear, and how many. */
  looks: number[] | null; samples: number;
  /** Per other player: how much more like them this player's person has looked lately. */
  doubt: number[];
  /** Per person nobody follows (by chain): how much more like this player they've looked than this player's person. */
  claims: Map<number, number>;
}

const reliable = (p: Landmark) => p.confidence !== null && p.confidence >= RELIABLE;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const apart = (a: Body, b: Body) => distance(a, b) > APART * Math.max(a.scale, b.scale);
/** Mean absolute difference of two looks. */
export const looksDistance = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;

function measure(points: readonly DetectedLandmark[], looks: readonly number[] | null, aspect: number, now: number): Body | null {
  const landmarks = points.map(p => ({ x: p.x, y: p.y, z: p.z, confidence: detectedConfidence(p) }));
  try { validatePoses([{ playerId: 0, landmarks }]); } catch { return null; }
  const [ls, rs, lh, rh] = TORSO.map(i => landmarks[i]);
  if (![ls, rs, lh, rh].every(reliable)) return null;
  const torso = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2 * aspect, (ls.y + rs.y - lh.y - rh.y) / 2);
  const shoulders = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  return { landmarks, x: (ls.x + rs.x + lh.x + rh.x) / 4 * aspect, y: (ls.y + rs.y + lh.y + rh.y) / 4,
    scale: Math.max(torso, shoulders / 0.75, 0.01), looks, seen: now, chain: 0, hits: 1, extra: 0,
    limbs: LIMBS.map(i => reliable(landmarks[i]) ? { x: landmarks[i].x * aspect, y: landmarks[i].y } : null) };
}

/** Whether two results are one person: their joints mostly in the same places. */
function same(a: Body, b: Body) {
  let sum = 0, n = 0;
  a.limbs.forEach((p, i) => { const q = b.limbs[i]; if (p && q) { sum += distance(p, q); n++; } });
  return n >= 4 ? sum / n < 0.35 * Math.min(a.scale, b.scale) : distance(a, b) < 0.3 * Math.min(a.scale, b.scale);
}

/** How unlike a followed player's prediction a body is (in body sizes), or Infinity outside the gate. */
function motion(track: Track, body: Body, now: number) {
  const dt = Math.max(0, now - track.seen);
  const k = VELOCITY_MS * (1 - Math.exp(-dt / VELOCITY_MS));
  const dx = track.vx * k, dy = track.vy * k, s = track.body.scale;
  const position = Math.hypot(body.x - track.body.x - dx, body.y - track.body.y - dy) / s;
  if (position > GATE) return Infinity;
  let sum = 0, n = 0;
  body.limbs.forEach((p, i) => {
    const q = track.body.limbs[i];
    if (p && q) { sum += Math.hypot(p.x - q.x - dx, p.y - q.y - dy) / s; n++; }
  });
  return 0.5 * position + 0.5 * (n >= 4 ? sum / n : position) + 2 * Math.abs(Math.log(body.scale / s));
}

/**
 * The cheapest way to give each row at most one column (and each column at most one row):
 * a row left without one costs `miss`, and `extra` adds a cost for the whole choice. Rows and
 * columns are few (players, and the people in one result), so every choice is tried.
 */
function assign(costs: number[][], columns: number, miss: number, extra: (choice: readonly (number | null)[]) => number = () => 0): (number | null)[] {
  let best: (number | null)[] = costs.map(() => null), bestCost = Infinity;
  const choice: (number | null)[] = [];
  const used = new Set<number>();
  const visit = (row: number, total: number) => {
    if (total >= bestCost) return;
    if (row === costs.length) {
      const all = total + extra(choice);
      if (all < bestCost) { best = [...choice]; bestCost = all; }
      return;
    }
    choice[row] = null; visit(row + 1, total + miss);
    for (let c = 0; c < columns; c++) {
      if (used.has(c) || !Number.isFinite(costs[row][c])) continue;
      used.add(c); choice[row] = c; visit(row + 1, total + costs[row][c]); used.delete(c);
    }
  };
  visit(0, 0);
  return best;
}

export class PlayerTracker {
  playerCount: PlayerCount;
  players: Player[];
  /** Everyone in the last few results, to know who has been seen before. */
  recent: Body[] = [];
  chains = 0;
  /** Pairs of players ("a,b", a < b) that overlapped, and when they last did. */
  tangled = new Map<string, number>();
  /** Whether the players have been numbered in line-up order yet. */
  lined = false;
  constructor(playerCount: PlayerCount) {
    this.playerCount = playerCount;
    this.players = Array.from({ length: playerCount }, () => ({ track: null, place: NaN, looks: null, samples: 0, doubt: [], claims: new Map() }));
  }

  /**
   * The players' poses in one result: the detections in MediaPipe's order (with what each
   * person looks like, when known), the frame they came from and when it was taken.
   */
  update(detections: readonly (readonly DetectedLandmark[])[], input: FrameSize, now: number, looks: readonly (readonly number[] | null | undefined)[] = []): Pose[] {
    const aspect = input.width / input.height;
    this.players.forEach((p, id) => { if (!p.track) p.place = (this.playerCount - id - 0.5) / this.playerCount * aspect; });
    let bodies = detections.map((points, i) => measure(points, looks[i] ?? null, aspect, now)).filter((b): b is Body => b !== null);
    // Two results for one person (the model can add a ghost beside someone): keep the first, its surer one.
    bodies = bodies.filter((b, i) => !bodies.slice(0, i).some(a => same(a, b)));
    // Who was here before: each person continues the nearest one seen lately, if near enough.
    const recent = this.recent.filter(b => now - b.seen <= SEEN_GAP_MS);
    const continued = new Set<Body>();
    for (const body of bodies) {
      const before = recent.filter(b => !continued.has(b) && distance(body, b) <= (GATE + 0.8 * Math.min(1, (now - b.seen) / 1000)) * b.scale)
        .sort((a, b) => distance(body, a) - distance(body, b))[0];
      if (before) { continued.add(before); body.chain = before.chain; body.hits = before.hits + 1; body.extra = before.extra; }
      else body.chain = ++this.chains;
    }
    this.recent = [...bodies, ...recent.filter(b => !continued.has(b))];

    const found = this.match(bodies, now);
    if (found.size === this.playerCount) for (const body of bodies) if (![...found.values()].includes(body)) body.extra++;
    this.untangle(found);
    this.recognise(found);
    this.reclaim(found, bodies, now);
    for (const [id, body] of found) this.follow(id, body, now);
    this.tangle(found, now);
    return [...found].map(([playerId, body]) => ({ playerId, landmarks: body.landmarks })).sort((a, b) => a.playerId - b.playerId);
  }

  /** Gives this result's people to the players, all at once. */
  match(bodies: Body[], now: number): Map<number, Body> {
    const needed = this.playerCount === 1 ? 1 : 2;
    // Where each player is: just seen, or their place.
    const where = this.players.map(p => p.track && now - p.track.seen <= FRESH_MS ? p.track.body.x : p.place);
    const nearest = (p: Player, body: Body) => this.players.every((q, i) => q === p || !q.track || Math.abs(body.x - where[i]) > Math.abs(body.x - p.place));
    // Looks count for a player whose looks tell them from every other player.
    const recognisable = this.players.map((p, i) => p.samples >= LOOKS_SAMPLES && this.players.every((q, j) => i === j || !q.track || this.distinct(i, j)));
    const costs = this.players.map((p, i) => bodies.map(body => {
      const track = p.track;
      const away = Math.abs(body.x - p.place) / body.scale;
      let cost: number;
      if (track && now - track.seen <= FRESH_MS) cost = MOTION * motion(track, body, now);
      else if (body.hits < needed) return Infinity;
      // A bystander isn't a missing player (unless they've been gone a while)...
      else if (track && body.extra >= BYSTANDER && now - track.seen <= LONG_MS) return Infinity;
      // ...but somebody back near a missing player's place (and nearer it than anyone else's) is them...
      else if (track && away <= RETURN + RETURN_GROWTH * (now - track.seen) / 1000 && nearest(p, body)) cost = 0;
      // ...and anybody can take a number nobody has had, or one given up: where they are matters less.
      else if (!track || now - track.seen > RESERVE_MS) cost = NEW - PLACE * Math.max(0, away - 2);
      else return Infinity;
      cost += PLACE * away;
      // Looks say which player somebody is, but never stop a free player taking them.
      if (recognisable[i] && body.looks) cost += Math.min(LOOKS_CAP, LOOKS * looksDistance(p.looks!, body.looks));
      return cost;
    }));
    // Changing places in the line-up costs ORDER, unless the players were followed through it:
    // passing another found player, or the place of one seen lately.
    const order = (choice: readonly (number | null)[]) => {
      let total = 0;
      for (let a = 0; a < choice.length; a++) for (let b = 0; b < choice.length; b++) {
        const ca = choice[a], cb = choice[b], pa = this.players[a], pb = this.players[b];
        if (a === b || ca === null || (cb !== null && b < a) || !pa.track || !pb.track) continue;
        if (now - pa.track.seen > TANGLE_MS || now - pb.track.seen > TANGLE_MS) continue;
        const margin = 0.5 * bodies[ca].scale;
        if (Math.abs(pa.place - pb.place) < margin) continue;
        const after = bodies[ca].x - (cb === null ? pb.place : bodies[cb].x);
        if (after * Math.sign(pa.place - pb.place) < -margin) total += ORDER;
      }
      return total;
    };
    const choice = assign(costs, bodies.length, MISS, order);
    const found = new Map<number, Body>();
    choice.forEach((c, id) => {
      if (c === null) return;
      found.set(id, bodies[c]);
      // A player found again after a while starts a new track.
      const p = this.players[id];
      if (!p.track || now - p.track.seen > FRESH_MS) p.track = { body: bodies[c], vx: 0, vy: 0, seen: now };
    });
    // Until everyone has been in view at once, numbers are provisional: the first time they all
    // are, apart, they're numbered left to right (P1 on the left of the mirrored preview).
    if (!this.lined && found.size === this.playerCount) {
      const all = [...found.values()];
      if (all.every((a, i) => all.every((b, j) => i === j || apart(a, b)))) {
        this.lined = true;
        const players = [...found.keys()].sort((a, b) => found.get(b)!.x - found.get(a)!.x).map(id => ({ ...this.players[id], body: found.get(id)! }));
        players.forEach(({ body, ...p }, id) => { this.players[id] = { ...p, doubt: [], claims: new Map() }; found.set(id, body); });
        this.tangled.clear();
      }
    }
    return found;
  }

  /** Whether two players' looks are known and differ enough to tell them apart. */
  distinct(a: number, b: number) {
    const pa = this.players[a], pb = this.players[b];
    return !!pa.looks && !!pb.looks && pa.samples >= LOOKS_SAMPLES && pb.samples >= LOOKS_SAMPLES && looksDistance(pa.looks, pb.looks) > DISTINCT;
  }

  /**
   * Puts right a player following another player's person: one whose person has looked more
   * like another player than like them for a while becomes that player (swapping with them if
   * that player's person has looked like the first).
   */
  recognise(found: Map<number, Body>) {
    for (const [id, body] of found) {
      const p = this.players[id];
      if (!body.looks || !p.looks) continue;
      const own = looksDistance(body.looks, p.looks);
      for (let other = 0; other < this.playerCount; other++) {
        if (other === id) continue;
        const margin = this.distinct(id, other) ? own - looksDistance(body.looks, this.players[other].looks!) : 0;
        p.doubt[other] = 0.7 * (p.doubt[other] ?? 0) + 0.3 * margin;
      }
    }
    for (const [id, body] of [...found]) {
      const p = this.players[id];
      const other = p.doubt.findIndex((d, i) => i !== id && d > DOUBT);
      if (other < 0 || found.get(id) !== body) continue;
      const q = this.players[other];
      if (found.has(other)) {
        // Each following the other's person: swap.
        if (!(q.doubt[id] > 0)) continue;
        const theirs = found.get(other)!;
        [p.track, q.track] = [q.track, p.track];
        found.set(id, theirs); found.set(other, body);
      } else {
        // The other player takes this person; this player is missing (and lost track of long ago).
        q.track = p.track; p.track = p.track && { ...p.track, seen: -Infinity };
        found.delete(id); found.set(other, body);
      }
      p.doubt = []; q.doubt = [];
    }
  }

  /**
   * Gives a player back their person: one whose person doesn't look like them, while somebody
   * nobody follows does (for a while), takes that somebody instead.
   */
  reclaim(found: Map<number, Body>, bodies: Body[], now: number) {
    const loose = bodies.filter(b => b.looks && ![...found.values()].includes(b));
    for (const [id, body] of [...found]) {
      const p = this.players[id];
      if (!body.looks || !p.looks || p.samples < LOOKS_SAMPLES) { p.claims.clear(); continue; }
      const own = looksDistance(body.looks, p.looks);
      const claims = new Map<number, number>();
      for (const other of loose) {
        const margin = own > STRANGER ? own - looksDistance(other.looks!, p.looks) : 0;
        claims.set(other.chain, 0.7 * (p.claims.get(other.chain) ?? 0) + 0.3 * margin);
      }
      p.claims = claims;
      const [chain, claim] = [...claims].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
      if (claim <= RECLAIM) continue;
      const other = loose.find(b => b.chain === chain)!;
      p.track = { body: other, vx: 0, vy: 0, seen: now };
      found.set(id, other);
      loose.splice(loose.indexOf(other), 1, body);
      p.claims.clear();
    }
  }

  /** Where a player is now: found this time, or last seen. */
  at(id: number, found: Map<number, Body>) { return found.get(id) ?? this.players[id].track?.body; }

  /** Notes which players overlap now (or vanished just now beside someone), and who stands clear. */
  tangle(found: Map<number, Body>, now: number) {
    for (const [key, at] of this.tangled) if (now - at > TANGLE_MS) this.tangled.delete(key);
    for (let a = 0; a < this.playerCount; a++) for (let b = a + 1; b < this.playerCount; b++) {
      const pa = this.at(a, found), pb = this.at(b, found);
      if (!pa || !pb || (!found.has(a) && !found.has(b))) continue;
      if (!found.has(a) || !found.has(b)) { const gone = this.players[found.has(a) ? b : a].track!; if (now - gone.seen > 2 * FRESH_MS) continue; }
      if (distance(pa, pb) < CLOSE * Math.max(pa.scale, pb.scale)) this.tangled.set(`${a},${b}`, now);
    }
    for (const [id, body] of found) {
      const p = this.players[id];
      const clear = this.players.every((_, other) => { const q = other === id ? undefined : this.at(other, found); return !q || apart(body, q); });
      if (!clear || [...this.tangled.keys()].some(key => key.split(',').includes(String(id)))) continue;
      p.place = body.x;
      // Looks are learnt from a person who doesn't look like them (who may be somebody else) only slowly.
      if (body.looks && !p.doubt.some(d => d > 0)) {
        const rate = !p.looks || p.samples < LOOKS_SAMPLES || looksDistance(body.looks, p.looks) <= STRANGER ? LEARN : LEARN_STRANGER;
        p.looks = p.looks ? p.looks.map((v, i) => (1 - rate) * v + rate * body.looks![i]) : [...body.looks];
        p.samples++;
      }
    }
  }

  /**
   * Tangled players who are all found and apart again get their identities back: by their
   * looks when those differ clearly, otherwise in the left-to-right order they stood in before.
   */
  untangle(found: Map<number, Body>) {
    const groups: number[][] = [];
    for (const key of this.tangled.keys()) {
      const [a, b] = key.split(',').map(Number);
      const joined = groups.filter(g => g.includes(a) || g.includes(b));
      for (const g of joined) groups.splice(groups.indexOf(g), 1);
      groups.push([...new Set([a, b, ...joined.flat()])]);
    }
    for (const group of groups) {
      if (!group.every(id => found.has(id))) continue;
      const bodies = group.map(id => found.get(id)!);
      if (!bodies.every((a, i) => bodies.every((b, j) => i === j || apart(a, b)))) continue;
      for (const key of [...this.tangled.keys()]) if (key.split(',').some(id => group.includes(Number(id)))) this.tangled.delete(key);
      let order: Body[];
      if (bodies.every(b => b.looks) && group.every(a => group.every(b => a === b || this.distinct(a, b)))) {
        order = assign(group.map(id => bodies.map(b => looksDistance(this.players[id].looks!, b.looks!))), bodies.length, Infinity).map(i => bodies[i!]);
      } else {
        const byPlace = [...group].sort((a, b) => this.players[a].place - this.players[b].place);
        const byX = [...bodies].sort((a, b) => a.x - b.x);
        order = group.map(id => byX[byPlace.indexOf(id)]);
      }
      if (order.every((body, i) => body === bodies[i])) continue;
      // Each player takes over the track of the person they turned out to be.
      const tracks = group.map(id => this.players[id].track);
      group.forEach((id, i) => { this.players[id].track = tracks[bodies.indexOf(order[i])]; found.set(id, order[i]); });
    }
  }

  follow(id: number, body: Body, now: number) {
    const track = this.players[id].track!;
    const dt = now - track.seen;
    if (dt > 0 && dt <= VELOCITY_MS) {
      track.vx = 0.5 * track.vx + 0.5 * (body.x - track.body.x) / dt;
      track.vy = 0.5 * track.vy + 0.5 * (body.y - track.body.y) / dt;
    } else if (dt > VELOCITY_MS) { track.vx = 0; track.vy = 0; }
    track.body = { ...body, scale: dt > 0 ? 0.7 * track.body.scale + 0.3 * body.scale : body.scale };
    track.seen = now;
  }
}
