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
 * With two players the model looks for one more person than there are players, so a passer-by
 * can't push a player out of its results (three or four are looked for in a strip each,
 * tiles.ts). Extra people are ignored while every player is found, and
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
/** How far (in body sizes) a followed player may be from their prediction, and how much bigger or smaller (log). */
const GATE = 0.7, GROWTH = 0.4;
/** How far from their place a missing player may be found again: grows the longer they're gone. */
const RETURN = 1.0, RETURN_GROWTH = 2.0;
/** A player missing this long can be found anywhere, and gives up their number to a new person. */
const RESERVE_MS = 1500;
/** Before they're first numbered, everyone must have been in this many results (not a glitch of the model's). */
const LINE = 10;
/** A person seen again within this long (near where they were) is the same person (a bystander, BYSTANDER_GAP_MS). */
const SEEN_GAP_MS = 1000, BYSTANDER_GAP_MS = 5000;
/** Somebody seen in this many results beside all the players just seen (and NEAR body sizes from any missing player's place) is a bystander... */
const BYSTANDER = 10, NEAR = 2;
/** ...who can only take the number of a player gone this long. */
const LONG_MS = 5000;
/**
 * For this long after somebody new takes a missing player's number (or the player takes it back
 * somewhere else), the player can have it back: somebody their size who came into view since,
 * standing at the player's place for RESTORE results running.
 */
const RESTORE_MS = 30000, RESTORE = 8;
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
/** ...and somebody else in view looking this much more like them, lately and in RECLAIM_RUN results running, is them. */
const RECLAIM = 0.03, RECLAIM_RUN = 10;
/** How fast a player's looks are learnt: from a person who looks like them, or (slowly) unlike them. */
const LEARN = 0.1, LEARN_STRANGER = 0.002;
// Costs, in body sizes of mismatch: a player goes unmatched rather than pay MISS.
const MISS = 4, MOTION = 1, PLACE = 0.3, BACK = 0.3, NEW = 1.5, SMALLER = 2, ORDER = 3, LOOKS = 15, LOOKS_CAP = 2.5;

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
  /** ...in how many every player was found without them... */
  extra: number;
  /** ...and since when they've been in view. */
  since: number;
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
  /**
   * Per person nobody follows (by chain): how much more like this player they've looked than
   * this player's person, lately, and in how many results running.
   */
  claims: Map<number, { margin: number; run: number }>;
  /** Who had this number before somebody new took it, and when; and when the last somebody new did. */
  former: { place: number; scale: number; looks: number[] | null; samples: number; at: number;
    /** Who has been back at the place (by chain), where they were first, and in how many results running. */
    back?: { chain: number; x: number; run: number; seen: number } } | null;
  anew: number;
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
    scale: Math.max(torso, shoulders / 0.75, 0.01), looks, seen: now, chain: 0, hits: 1, extra: 0, since: now,
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
  const size = Math.abs(Math.log(body.scale / s));
  if (position > GATE || size > GROWTH) return Infinity;
  let sum = 0, n = 0;
  body.limbs.forEach((p, i) => {
    const q = track.body.limbs[i];
    if (p && q) { sum += Math.hypot(p.x - q.x - dx, p.y - q.y - dy) / s; n++; }
  });
  return 0.5 * position + 0.5 * (n >= 4 ? sum / n : position) + 2 * size;
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
    this.players = Array.from({ length: playerCount }, () => ({ track: null, place: NaN, looks: null, samples: 0, doubt: [], claims: new Map(), former: null, anew: -Infinity }));
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
    // Who was here before: each person continues one seen lately, if near enough, the nearest
    // pairs first (so somebody new beside a person doesn't take over who they were).
    const recent = this.recent.filter(b => now - b.seen <= (b.extra >= BYSTANDER ? BYSTANDER_GAP_MS : SEEN_GAP_MS));
    const pairs = bodies.flatMap(body => recent.map(before => ({ body, before, d: distance(body, before) })))
      .filter(({ before, d }) => d <= (GATE + 0.8 * Math.min(1, (now - before.seen) / 1000)) * before.scale).sort((a, b) => a.d - b.d);
    const continued = new Set<Body>(), continuing = new Set<Body>();
    for (const { body, before } of pairs) {
      if (continued.has(before) || continuing.has(body)) continue;
      continued.add(before); continuing.add(body);
      body.chain = before.chain; body.hits = before.hits + 1; body.extra = before.extra; body.since = before.since;
    }
    for (const body of bodies) if (!continuing.has(body)) body.chain = ++this.chains;
    this.recent = [...bodies, ...recent.filter(b => !continued.has(b))];

    const found = this.match(bodies, now);
    this.untangle(found);
    this.recognise(found, now);
    this.reclaim(found, bodies, now);
    this.restore(found, bodies, now);
    // (Numbers are provisional until the players are numbered, so nobody is kept from one.)
    if (this.lined) this.witness(bodies, found, now);
    for (const [id, body] of found) this.follow(id, body, now);
    this.tangle(found, now);
    return [...found].map(([playerId, body]) => ({ playerId, landmarks: body.landmarks })).sort((a, b) => a.playerId - b.playerId);
  }

  /**
   * Counts who was in view beside the players: somebody nobody follows, while every player just
   * seen is found, who overlaps none of them (a ghost or somebody half hidden could be one) and
   * stands nowhere near a missing player's place (or the place of one whose number somebody new
   * took) can't be a player. A player is nobody's bystander.
   */
  witness(bodies: Body[], found: Map<number, Body>, now: number) {
    const players = [...found.values()];
    for (const body of players) body.extra = 0;
    if (!found.size || !this.players.every((p, id) => found.has(id) || !p.track || now - p.track.seen > 2 * FRESH_MS)) return;
    const places = this.players.flatMap((p, id) => [...(!found.has(id) && p.track ? [p.place] : []), ...(p.former ? [p.former.place] : [])]);
    for (const body of bodies) {
      if (players.includes(body) || players.some(f => distance(f, body) <= CLOSE * Math.max(f.scale, body.scale))) continue;
      if (places.every(x => Math.abs(body.x - x) / body.scale > NEAR)) body.extra++;
    }
  }

  /** Gives this result's people to the players, all at once. */
  match(bodies: Body[], now: number): Map<number, Body> {
    const needed = this.playerCount === 1 ? 1 : 2;
    // Where each player is: just seen, or their place.
    const where = this.players.map(p => p.track && now - p.track.seen <= FRESH_MS ? p.track.body.x : p.place);
    // A player whose number is given up, on whose place another player has stood since, isn't there any more.
    const givenUp = (p: Player) => !!p.track && now - p.track.seen > LONG_MS;
    const superseded = (p: Player, q: Player) => givenUp(p) && !givenUp(q) && Math.abs(p.place - q.place) < CLOSE * q.track!.body.scale;
    const nearest = (p: Player, body: Body) => this.players.every((q, i) => q === p || !q.track
      || (!superseded(p, q) && (superseded(q, p) || Math.abs(body.x - where[i]) > Math.abs(body.x - p.place))));
    // Looks count for a player whose looks tell them from every other player (so not for one player alone).
    const recognisable = this.players.map((p, i) => this.playerCount > 1 && p.samples >= LOOKS_SAMPLES && this.players.every((q, j) => i === j || !q.track || this.distinct(i, j)));
    const biggest = Math.max(...bodies.map(b => b.scale));
    // Which players would take which people as somebody new (rather than as themselves).
    const anew = this.players.map(() => new Set<number>());
    const costs = this.players.map((p, i) => bodies.map((body, b) => {
      const track = p.track;
      const away = Math.abs(body.x - p.place) / body.scale;
      let cost: number;
      // A bystander isn't a player (unless the player has been gone a while)...
      if (track && body.extra >= BYSTANDER && now - track.seen <= LONG_MS) return Infinity;
      if (track && now - track.seen <= FRESH_MS) cost = MOTION * motion(track, body, now);
      else if (body.hits < needed) return Infinity;
      // ...but somebody back near a missing player's place (and nearer it than anyone else's) is them...
      else if (track && away <= RETURN + RETURN_GROWTH * (now - track.seen) / 1000 && nearest(p, body)) {
        cost = BACK;
        if (body.extra >= BYSTANDER) anew[i].add(b);
      }
      // ...and anybody can take a number nobody has had, or one given up: where they are matters
      // less, and the people in front (bigger in the picture) come first.
      else if (!track || now - track.seen > RESERVE_MS) {
        cost = NEW - PLACE * Math.max(0, away - 2) + SMALLER * Math.log(biggest / body.scale);
        anew[i].add(b);
      }
      else return Infinity;
      cost += PLACE * away;
      // Looks say which player somebody is, but never stop a free player taking them.
      if (recognisable[i] && body.looks) cost += Math.min(LOOKS_CAP, LOOKS * looksDistance(p.looks!, body.looks));
      return cost;
    }));
    // Changing places in the line-up costs ORDER, unless the players were followed through it:
    // passing another found player, or the place of one seen lately. Players their looks tell
    // apart are told apart by those instead. (There's no line-up until they're numbered.)
    const order = (choice: readonly (number | null)[]) => {
      let total = 0;
      if (!this.lined) return total;
      for (let a = 0; a < choice.length; a++) for (let b = 0; b < choice.length; b++) {
        const ca = choice[a], cb = choice[b], pa = this.players[a], pb = this.players[b];
        if (a === b || ca === null || (cb !== null && b < a) || !pa.track || !pb.track) continue;
        if (recognisable[a] && recognisable[b] && bodies[ca].looks) continue;
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
      // A player found again after a while starts a new track; somebody new taking a missing
      // player's number leaves a note of who had it.
      const p = this.players[id];
      // (Only one who had it a while: not somebody who took it lately, while its note stands.)
      // (Not when their looks, which tell this player from the others, say it's the player themselves.)
      const themselves = recognisable[id] && bodies[c].looks && looksDistance(bodies[c].looks!, p.looks!) < STRANGER;
      if (p.track && anew[id].has(c) && !themselves) {
        if (now - p.anew > RESTORE_MS && (!p.former || now - p.former.at > RESTORE_MS)) p.former = { place: p.place, scale: p.track.body.scale, looks: p.looks, samples: p.samples, at: now };
        p.anew = now;
      }
      if (!p.track || now - p.track.seen > FRESH_MS) p.track = { body: bodies[c], vx: 0, vy: 0, seen: now };
    });
    // Until everyone has been in view at once, numbers are provisional: the first time they all
    // are, in a clear order (none overlapping another) and each for a moment, they're numbered
    // left to right (P1 on the left of the mirrored preview).
    if (!this.lined && found.size === this.playerCount) {
      const all = [...found.values()];
      if (all.every(b => b.hits >= LINE) && all.every((a, i) => all.every((b, j) => i === j || Math.abs(a.x - b.x) > CLOSE * Math.max(a.scale, b.scale)))) {
        this.lined = true;
        const players = [...found.keys()].sort((a, b) => found.get(b)!.x - found.get(a)!.x).map(id => ({ ...this.players[id], body: found.get(id)! }));
        // Each stands where they are now. Looks learnt while the numbers were provisional may be
        // anybody's: they're learnt afresh.
        players.forEach(({ body, ...p }, id) => { this.players[id] = { ...p, place: body.x, looks: null, samples: 0, doubt: [], claims: new Map(), former: null, anew: -Infinity }; found.set(id, body); });
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
  recognise(found: Map<number, Body>, now: number) {
    for (const [id, body] of found) {
      const p = this.players[id];
      if (!body.looks || !p.looks) continue;
      const own = looksDistance(body.looks, p.looks);
      for (let other = 0; other < this.playerCount; other++) {
        if (other === id) continue;
        // Only somebody who looks like the other player (not merely less unlike them) is them.
        const theirs = this.distinct(id, other) ? looksDistance(body.looks, this.players[other].looks!) : Infinity;
        const margin = theirs < STRANGER ? own - theirs : 0;
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
        if (!(q.doubt[id] > DOUBT / 3)) continue;
        const theirs = found.get(other)!;
        [p.track, q.track] = [q.track, p.track];
        found.set(id, theirs); found.set(other, body);
      } else {
        // The other player, missing for more than a moment, takes this person; this player is
        // missing from now (as if they had just gone out of sight).
        if (q.track && now - q.track.seen <= FRESH_MS) continue;
        q.track = p.track; p.track = p.track && { ...p.track, seen: now - FRESH_MS - 1 };
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
      const claims = new Map<number, { margin: number; run: number }>();
      for (const other of loose) {
        // Never a bystander (somebody dressed alike could be beside them), unless they came into
        // view since somebody new took this number: the player coming back.
        const theirs = looksDistance(other.looks!, p.looks);
        const margin = own > STRANGER && (other.extra < BYSTANDER || (now - p.anew <= RESTORE_MS && other.since > p.anew)) ? own - theirs : 0;
        const before = p.claims.get(other.chain);
        claims.set(other.chain, { margin: 0.7 * (before?.margin ?? 0) + 0.3 * margin, run: margin > 0 ? (before?.run ?? 0) + 1 : 0 });
      }
      p.claims = claims;
      const [chain] = [...claims].filter(([, c]) => c.margin > RECLAIM && c.run >= RECLAIM_RUN).sort((a, b) => b[1].margin - a[1].margin)[0] ?? [];
      if (chain === undefined) continue;
      const other = loose.find(b => b.chain === chain)!;
      p.track = { body: other, vx: 0, vy: 0, seen: now };
      found.set(id, other);
      loose.splice(loose.indexOf(other), 1, body);
      p.claims.clear();
    }
  }

  /**
   * Gives a number back to the player somebody new took it from, when somebody their size who has
   * come into view since is back at their place for a few results running (a bystander who stood
   * there all along isn't them), while whoever took it is elsewhere, and doesn't look more like them.
   */
  restore(found: Map<number, Body>, bodies: Body[], now: number) {
    for (const [id, p] of this.players.entries()) {
      const former = p.former;
      if (!former) continue;
      if (now - former.at > RESTORE_MS) { p.former = null; continue; }
      const holder = found.get(id);
      const back = bodies.filter(b => ![...found.values()].includes(b) && b.since > former.at - SEEN_GAP_MS
        && Math.abs(b.x - former.place) / b.scale <= RETURN && Math.abs(Math.log(b.scale / former.scale)) <= GROWTH)
        .sort((a, b) => Math.abs(a.x - former.place) - Math.abs(b.x - former.place))[0];
      // Standing there, not walking past (a result the model misses them in doesn't count either way).
      const still = back && former.back?.chain === back.chain && Math.abs(back.x - former.back.x) <= 0.3 * back.scale;
      if (back) former.back = still ? { ...former.back!, run: former.back!.run + 1, seen: now } : { chain: back.chain, x: back.x, run: 1, seen: now };
      else if (former.back && now - former.back.seen > SEEN_GAP_MS) former.back = undefined;
      if (!back || former.back!.run < RESTORE || (holder && Math.abs(holder.x - former.place) <= APART * holder.scale)) continue;
      if (former.looks && former.samples >= LOOKS_SAMPLES && back.looks && holder?.looks
        && looksDistance(back.looks, former.looks) > looksDistance(holder.looks, former.looks)) continue;
      this.players[id] = { ...p, track: { body: back, vx: 0, vy: 0, seen: now }, place: former.place, looks: former.looks, samples: former.samples,
        doubt: [], claims: new Map(), former: null, anew: -Infinity };
      found.set(id, back);
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
      const clear = this.players.every((q, other) => {
        const there = other === id ? undefined : found.get(other) ?? (q.track && now - q.track.seen <= 2 * FRESH_MS ? q.track.body : undefined);
        return !there || apart(body, there);
      });
      if (!clear || [...this.tangled.keys()].some(key => key.split(',').includes(String(id)))) continue;
      p.place = body.x;
      // Looks are learnt from a person who doesn't look like them (who may be somebody else) only
      // slowly, and not at all while somebody new has their number (the player may be back).
      if (body.looks && !p.doubt.some(d => d > DOUBT / 3) && now - p.anew > RESTORE_MS) {
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
