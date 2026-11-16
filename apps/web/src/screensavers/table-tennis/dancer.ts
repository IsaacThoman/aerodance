import { TABLE, stepBall } from '../../minigames/table-tennis/ball.ts';
import type { Ball, BallEvent, V3 } from '../../minigames/table-tennis/ball.ts';
import type { CharacterPose, Triple } from '../../../../../packages/pose/performance.ts';
import { add, clamp, hermite, len, lerp, mixN, scale, smooth, springTo, squareTo, sub, unit } from './vec.ts';
import type { Spring } from './vec.ts';

/*
 * A glass dancer playing table tennis, in its own frame (the minigame's rally.ts `mine`: its end
 * of the table at +z, the net at z = 0, facing −z, its right at +x). Two halves:
 *
 *  - The player (DancerPlayer): where its paddle's blade is each frame, which the match hands to
 *    the minigame's Round as a tracked player's paddle (match.ts), so the ball meets the very
 *    paddle that's drawn. It waits in a ready stance; when a ball comes its way it works out where
 *    it will meet it (predictContact: the minigame's own ball physics, played forward), steps
 *    across to line up, draws the blade back, swings it through the ball and follows through,
 *    forehand or backhand; it asks the robot to serve with its free hand raised, or tosses the
 *    ball up and serves it itself.
 *  - Its body (pose): the glass character's parts (packages/character, posed directly), placed
 *    round the blade: feet planted and shuffling across with small steps, the knees bent (the
 *    body low), the torso turning into the stroke and back, the free hand balancing, the head on
 *    the ball. The paddle hand is where the paddle's handle is.
 */

/** Metres to the character's units (it's about 1.6 m tall, its head big, as the menu dancers are). */
export const DANCER_SCALE = 0.5;
/** The paddles are drawn this much larger than life (Gear.tsx's), to read beside the glass mitts. */
export const PADDLE_SCALE = 1.45;
/** From the blade's middle to the middle of the hand holding it, along the handle. */
export const GRIP = 0.26;

/** Where it stands between shots (its own frame, m): a step behind its end, a little to its backhand side. */
export const HOME: { readonly x: number; readonly z: number } = { x: -0.12, z: 1.95 };
/** It never stands nearer the table than this (its body is round). */
const NEAREST_Z = TABLE.halfLength + 0.3;
const SIDE_LIMIT = 1.45;

/** The stroke: its forward swing and follow-through take these long (s); it's back ready this long after. */
const STROKE = { swing: 0.17, backhandSwing: 0.15, follow: 0.24, recover: 0.55, prep: 0.32 } as const;

/** The blade: where it is, its face's normal (towards the ball) and the way along it from the hand (the handle's way, reversed). */
export interface Blade { c: V3; n: V3; d: V3; }

/** A stroke under way: where the blade goes and when, and where the body steps to for it. */
export interface Stroke {
  kind: 'stroke' | 'serve';
  fore: boolean;
  start: number;
  /** When the forward swing starts, and when it meets the ball. */
  swingAt: number;
  contactAt: number;
  from: Blade;
  back: Blade;
  contact: Blade;
  follow: Blade;
  vel: V3;
  followT: number;
  body: { x: number; z: number };
  /** How low the ball is: the knees bend more for it (0-1). */
  low: number;
  /** Where the body was as the follow-through ended (the arm recovers along with it from there). */
  recoverFrom?: { x: number; z: number };
}

/** Where (own frame) and in how long it can meet a ball, after its one bounce on its own half. */
export interface Contact { at: V3; t: number; bounce: V3; }

const STEP = 1 / 240;
const scratch: BallEvent[] = [];

/**
 * Where a player meets a ball coming its way (own frame), and how soon: after its bounce on the
 * player's half (a serve may bounce on the server's first), as it comes back up through the
 * player's hitting place (further back for a ball that bounced deep, or that's high), or before it
 * drops too low. Null if it's not theirs: it goes into the net, off the end or wide, or bounces
 * on their half twice.
 */
export function predictContact(ball: Ball, serve = false): Contact | null {
  if (ball.vel.z <= 0) return null;
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: 0 };
  let bounce: V3 | null = null, theirs = 0, zc = 0;
  for (let t = STEP; t < 2.4; t += STEP) {
    scratch.length = 0;
    stepBall(b, STEP, null, null, scratch);
    for (const e of scratch) {
      if (e.type !== 'table') return null;
      if (e.at.z >= 0) {
        if (bounce) return null;
        bounce = { ...e.at };
        zc = clamp(bounce.z + 0.42, 1.28, 1.62);
      } else if (!serve || bounce || theirs++ > 0) return null;
    }
    if (!bounce) { if (b.pos.z > TABLE.halfLength + 0.3) return null; continue; }
    const high = b.pos.y > TABLE.top + 0.62;
    if ((b.pos.z >= zc && !high) || b.pos.z >= 2.05 || (b.vel.y < 0 && b.pos.y < TABLE.top + 0.15 && b.pos.z > 0.9)) {
      return { at: { ...b.pos }, t, bounce };
    }
  }
  return null;
}

const blade = (c: V3, n: V3, d: V3): Blade => { const nn = unit(n); return { c, n: nn, d: squareTo(d, nn) }; };
const turnBlade = (a: Blade, b: Blade, u: number): Blade => {
  const n = unit(lerp(a.n, b.n, u));
  return { c: a.c, n, d: squareTo(lerp(a.d, b.d, u), n) };
};

/** The character's parts this frame (character units, about its feet), before they're mirrored into its own frame. */
interface Foot { at: V3; from: V3; to: V3; u: number; stepping: boolean; }

export class DancerPlayer {
  /** Which hand holds the paddle: the forehand side is +x for the right. */
  readonly hand: 'right' | 'left';
  readonly rand: () => number;
  stroke: Stroke | null = null;
  /** The body's place on the floor (own frame, m), each a spring. */
  bx: Spring = { x: HOME.x, v: 0 };
  bz: Spring = { x: HOME.z, v: 0 };
  goal: { x: number; z: number } = { x: HOME.x, z: HOME.z };
  feet: Foot[];
  /** The blade drawn last frame. */
  blade: Blade;
  /** When it raised its free hand to ask the robot to serve. */
  askedAt = -Infinity;
  /**
   * Its own serve: where the ball waits to be served (own frame; set by the match while it's this
   * player's serve, null otherwise: it holds the ball meanwhile), when the toss starts, and where
   * the ball's let go.
   */
  waiting: V3 | null = null;
  serveBall: V3 | null = null;
  tossAt = Infinity;
  releaseAt = Infinity;
  released: V3 | null = null;
  /** Its free hand (own frame), as update() has put it. */
  free: V3 = { x: 0, y: 0.86, z: 0 };
  /** What it's looking at (own frame), eased. */
  look: V3 = { x: 0, y: 1.0, z: -1 };
  // Eased: the knees' bend, the torso's turn, and how ready it is (0 standing easy between points, 1 ready).
  private crouch: Spring = { x: 0.1, v: 0 };
  private yaw: Spring = { x: 0, v: 0 };
  private alert: Spring = { x: 0, v: 0 };
  private holding: Spring = { x: 0, v: 0 };
  private time = 0;
  /** When it last let a ball go (it watched it go out), and last saw the other end hit (a little hop, the split step). */
  watchedAt = -Infinity;
  hopAt = -Infinity;

  constructor(hand: 'right' | 'left' = 'right', rand: () => number = Math.random) {
    this.hand = hand;
    this.rand = rand;
    const s = this.side;
    this.feet = [-1, 1].map((k) => {
      const at = { x: HOME.x + k * 0.2, y: 0, z: HOME.z + (k === s ? 0.07 : -0.03) };
      return { at, from: at, to: at, u: 1, stepping: false };
    });
    this.blade = this.ready();
  }

  /** +1 when its forehand is to +x (right-handed). */
  get side() { return this.hand === 'right' ? 1 : -1; }

  /**
   * The blade between shots: ready, up in front on the forehand side, its face to the net; or
   * between points, the paddle held easy at its side.
   */
  ready(bx = this.bx.x, bz = this.bz.x): Blade {
    const s = this.side;
    const up = blade({ x: bx + 0.2 * s, y: TABLE.top + 0.24, z: bz - 0.5 }, { x: 0.05 * s, y: 0.18, z: -1 }, { x: -0.3 * s, y: 0.9, z: -0.25 });
    const k = clamp(this.alert.x, 0, 1);
    if (k > 0.999) return up;
    const easy = blade({ x: bx + 0.3 * s, y: 0.5, z: bz - 0.32 }, { x: s, y: 0, z: -0.15 }, { x: 0.05 * s, y: -0.55, z: -0.8 });
    return { ...turnBlade(easy, up, k), c: lerp(easy.c, up.c, k) };
  }

  /**
   * Plans the stroke for a ball it will meet at `c` (own frame) at `contactAt`, sending it on
   * towards `aim` (across, on the other half: only the swing's look). Forehand or backhand by
   * which side of it the ball is.
   */
  planStroke(now: number, c: Contact, aimX = 0) {
    const s = this.side;
    const at = c.at;
    const fore = (at.x - this.bx.x) * s > -0.12;
    const contactAt = now + c.t;
    const swingT = fore ? STROKE.swing : STROKE.backhandSwing;
    const low = clamp((TABLE.top + 0.3 - at.y) / 0.35, 0, 1);
    // Its body: the forehand's ball off to its side and in front, the backhand's in front of it.
    const body = {
      x: clamp(at.x - (fore ? 0.5 : -0.04) * s, -SIDE_LIMIT, SIDE_LIMIT),
      z: clamp(at.z + (fore ? 0.5 : 0.44), NEAREST_Z, 2.45),
    };
    // Where the swing goes: on towards where it's aimed (a little across the body), and up.
    const across = clamp((aimX * -1 - at.x) * 0.25, -0.25, 0.25);
    const ballFace = at.y > TABLE.top + 0.5 ? 0.05 : 0.22;
    // (No two strokes quite alike: a bigger or smaller backswing.)
    const big = 0.85 + this.rand() * 0.3;
    const back = fore
      ? blade(add(at, { x: 0.3 * s * big, y: -0.13 + 0.05 * low, z: 0.4 * big }), { x: 0.35 * s, y: 0.05, z: -1 }, { x: 0.55 * s, y: 0.35, z: 0.1 })
      : blade(add(at, { x: -0.3 * s * big, y: -0.05, z: 0.24 * big }), { x: -0.2 * s, y: 0.15, z: -1 }, { x: -0.5 * s, y: 0.6, z: -0.2 });
    const contact = fore
      ? blade(sub(at, { x: 0, y: 0, z: -0.026 }), { x: -0.08 * s + across * 0.4, y: ballFace, z: -1 }, { x: 0.6 * s, y: 0.4, z: -0.35 })
      : blade(sub(at, { x: 0, y: 0, z: -0.026 }), { x: 0.12 * s + across * 0.4, y: ballFace, z: -1 }, { x: -0.6 * s, y: 0.5, z: -0.3 });
    // (Met far out in front, the follow-through comes up and back in rather than on out.)
    const out = Math.max(0, body.z - at.z - 0.5);
    const follow = fore
      ? blade(add(at, { x: -0.38 * s + across, y: 0.42, z: -0.14 + out }), { x: -0.6 * s, y: 0.35, z: -0.7 }, { x: -0.15 * s, y: 0.95, z: 0.2 })
      : blade(add(at, { x: 0.36 * s + across, y: 0.3, z: -0.24 + out }), { x: 0.55 * s, y: 0.3, z: -0.75 }, { x: 0.25 * s, y: 0.9, z: -0.1 });
    // The blade's speed through the ball: half again the swing's mean, along it.
    const way = unit(add(unit(sub(contact.c, back.c)), unit(sub(follow.c, back.c))));
    const vel = scale(way, (1.45 * len(sub(contact.c, back.c))) / swingT);
    // A ball that comes quickly gets a quicker backswing (never under a tenth of a second).
    const swingAt = Math.max(now + 0.1, contactAt - swingT);
    this.stroke = { kind: 'stroke', fore, start: now, swingAt, contactAt, from: this.blade, back, contact, follow, vel, followT: STROKE.follow, body, low };
    this.goal = body;
  }

  /**
   * Serves the ball waiting at `ball` (own frame): holds it in its free hand, tosses it up so it
   * falls back to `ball` at `strikeAt`, and swings the blade through it then.
   */
  planServe(now: number, ball: V3, strikeAt: number) {
    const s = this.side;
    this.serveBall = { ...ball };
    this.tossAt = strikeAt - 0.82;
    this.releaseAt = this.tossAt + 0.12;
    this.released = null;
    const body = this.serveStance(ball);
    const back = blade(add(ball, { x: 0.24 * s, y: -0.12, z: 0.34 }), { x: 0.3 * s, y: 0.2, z: -1 }, { x: 0.5 * s, y: 0.5, z: 0.15 });
    const contact = blade(add(ball, { x: 0, y: -0.005, z: 0.026 }), { x: -0.05 * s, y: 0.3, z: -1 }, { x: 0.55 * s, y: 0.45, z: -0.3 });
    const follow = blade(add(ball, { x: -0.28 * s, y: 0.24, z: -0.12 }), { x: -0.55 * s, y: 0.4, z: -0.7 }, { x: -0.1 * s, y: 0.95, z: 0.2 });
    const way = unit(add(unit(sub(contact.c, back.c)), unit(sub(follow.c, back.c))));
    const swingT = 0.2;
    const vel = scale(way, (1.5 * len(sub(contact.c, back.c))) / swingT);
    this.stroke = { kind: 'serve', fore: true, start: now, swingAt: strikeAt - swingT, contactAt: strikeAt, from: this.blade, back, contact, follow, vel, followT: 0.26, body, low: 0 };
    this.goal = body;
  }

  /**
   * The other end has hit the ball (`ball`, own frame; `serve`: it may bounce on their half
   * first): it plans its stroke for it, or, if it's going out or into the net, lets it go and
   * watches it.
   */
  incoming(now: number, ball: Ball, serve: boolean, aimX = 0) {
    this.hopAt = now;
    const contact = predictContact(ball, serve);
    if (contact) this.planStroke(now, contact, aimX);
    else this.watchedAt = now;
  }

  /** Where it stands to serve a ball waiting at `ball`: behind it, the ball a little to its forehand side. */
  private serveStance(ball: V3) {
    return { x: clamp(ball.x - 0.16 * this.side, -SIDE_LIMIT, SIDE_LIMIT), z: Math.max(NEAREST_Z, ball.z + 0.56) };
  }

  /**
   * The ball to serve (own frame) while it's in its free hand or tossed up, or null once it's
   * served (or it isn't serving).
   */
  tossBall(now: number): V3 | null {
    const ball = this.serveBall, stroke = this.stroke;
    const inHand = { x: this.free.x, y: this.free.y + 0.06, z: this.free.z - 0.02 };
    if (!ball || !stroke || stroke.kind !== 'serve') return this.waiting ? inHand : null;
    if (now > stroke.contactAt + 0.05) return null;
    if (now < this.releaseAt) return inHand;
    const from = this.released ??= inHand;
    // Up and back down onto the waiting ball's place at the strike.
    const T = stroke.contactAt - this.releaseAt, t = Math.min(now - this.releaseAt, T);
    const vy = (ball.y - from.y + 0.5 * 9.81 * T * T) / T;
    const u = t / T;
    return { x: mixN(from.x, ball.x, u), y: from.y + vy * t - 0.5 * 9.81 * t * t, z: mixN(from.z, ball.z, u) };
  }

  /**
   * Its free hand (own frame): balancing, out in front ready, reaching on into a forehand and
   * pulled in after it, out behind a backhand; raised to ask the robot to serve; or holding the
   * ball to serve, low in front, and lifting it to toss it up.
   */
  private freeHand(now: number, turn: number, dt: number): V3 {
    const s = this.side, fs = -s, bx = this.bx.x, bz = this.bz.x;
    const fore = this.stroke?.fore ?? true;
    const readyAt = { x: bx + fs * 0.36, y: 0.86, z: bz - 0.3 };
    const reach = fore ? { x: bx + fs * 0.3, y: 1.0, z: bz - 0.48 } : { x: bx + fs * 0.2, y: 0.82, z: bz - 0.32 };
    const after = fore ? { x: bx + fs * 0.16, y: 0.9, z: bz - 0.12 } : { x: bx + fs * 0.5, y: 0.82, z: bz + 0.06 };
    let free = turn < 0 ? lerp(readyAt, reach, -turn) : lerp(readyAt, after, turn);
    // Raised to ask the robot to serve, with a little wave.
    const raise = smooth((now - this.askedAt) / 0.3) * (1 - smooth((now - this.askedAt - 0.9) / 0.35));
    if (raise > 0) free = lerp(free, { x: bx + fs * (0.46 + Math.sin((now - this.askedAt) * 13) * 0.06), y: 1.98, z: bz - 0.12 }, raise);
    // Holding the ball to serve: low in front of it, by the ball's waiting place once it's there; lifted to toss it.
    const serving = this.stroke?.kind === 'serve' && this.serveBall;
    springTo(this.holding, this.waiting || serving ? 1 : 0, 10, dt);
    const hold = clamp(this.holding.x, 0, 1);
    if (hold > 0.001) {
      const at = this.serveBall ?? this.waiting ?? { x: bx, y: 0, z: bz - 0.6 };
      const near = { x: at.x - 0.02 * s, y: TABLE.top + 0.18, z: at.z + 0.12 };
      const by = { x: bx + fs * 0.12, y: TABLE.top + 0.14 + Math.sin(now * 3.1) * 0.01, z: bz - 0.34 };
      // (Towards the toss's place as it gets there.)
      const there = smooth(1 - (Math.hypot(this.bx.x - this.goal.x, this.bz.x - this.goal.z) - 0.05) / 0.3);
      const held = serving ? near : lerp(by, near, there * 0.6);
      if (serving) {
        held.y += smooth((now - this.tossAt) / 0.12) * 0.16 - smooth((now - this.releaseAt - 0.1) / 0.3) * 0.12;
      }
      free = lerp(free, held, hold);
    }
    return free;
  }

  /** The blade at `now` (own frame), along its stroke, or ready. */
  bladeAt(now: number): Blade {
    const ready = this.ready();
    const st = this.stroke;
    if (!st) return ready;
    const { swingAt, contactAt, followT } = st;
    const done = contactAt + followT;
    if (now >= done + STROKE.recover) { this.stroke = null; this.serveBall = null; return ready; }
    if (now < swingAt) {
      const u = smooth((now - st.start) / Math.max(0.05, swingAt - st.start));
      const c = hermite(st.from.c, ZERO, st.back.c, ZERO, 1, u);
      return { ...turnBlade(st.from, st.back, u), c };
    }
    if (now < contactAt) {
      const span = contactAt - swingAt, u = (now - swingAt) / span;
      return { ...turnBlade(st.back, st.contact, u), c: hermite(st.back.c, ZERO, st.contact.c, st.vel, span, u) };
    }
    if (now < done) {
      const u = (now - contactAt) / followT;
      return { ...turnBlade(st.contact, st.follow, u), c: hermite(st.contact.c, st.vel, st.follow.c, ZERO, followT, u) };
    }
    // Back to ready, the arm going along with the body as it steps back.
    const u = smooth((now - done) / STROKE.recover);
    st.recoverFrom ??= { x: this.bx.x, z: this.bz.x };
    const from = { x: st.follow.c.x + this.bx.x - st.recoverFrom.x, y: st.follow.c.y, z: st.follow.c.z + this.bz.x - st.recoverFrom.z };
    return { ...turnBlade(st.follow, ready, u), c: hermite(from, ZERO, ready.c, ZERO, 1, u) };
  }

  /**
   * The stroke's swing at `now`: −1 drawn back, 0 meeting the ball, +1 followed through (eased
   * back to 0 as it recovers), and how much of a stroke it's in (0 ready, 1 playing).
   */
  swingPhase(now: number): { turn: number; active: number } {
    const st = this.stroke;
    if (!st) return { turn: 0, active: 0 };
    const done = st.contactAt + st.followT;
    if (now < st.swingAt) { const u = smooth((now - st.start) / Math.max(0.05, st.swingAt - st.start)); return { turn: -u, active: u }; }
    if (now < st.contactAt) return { turn: -1 + (now - st.swingAt) / (st.contactAt - st.swingAt), active: 1 };
    if (now < done) return { turn: Math.sin(((now - st.contactAt) / st.followT) * Math.PI / 2), active: 1 };
    const u = smooth((now - done) / STROKE.recover);
    return { turn: 1 - u, active: 1 - u };
  }

  /**
   * A frame: the body steps towards where the stroke needs it (or home), the feet follow it, and
   * the blade goes where the stroke has it. `ball` is the ball as drawn (own frame), to look at.
   */
  update(now: number, dt: number, ball: V3 | null, _own: Ball, inPlay: boolean) {
    this.time = now;
    const st = this.stroke;
    springTo(this.alert, inPlay || st ? 1 : 0, inPlay || st ? 9 : 3, dt);
    // Back home after a stroke (towards the middle, a little to the backhand side), or to where it
    // serves from, with the ball.
    if (!st || now > st.contactAt + st.followT) this.goal = this.waiting ? this.serveStance(this.waiting) : { x: HOME.x * this.side, z: HOME.z };
    springTo(this.bx, this.goal.x, 9, dt, 3.2);
    springTo(this.bz, this.goal.z, 7, dt, 2.4);
    this.stepFeet(dt);
    this.blade = this.bladeAt(now);
    const { active, turn } = this.swingPhase(now);
    // The knees bend ready, more for a stroke and more again for a low ball; it stands up a little
    // watching a ball go out, and stands easy between points.
    const watching = smooth(1 - (now - this.watchedAt) / 1.4);
    const crouch = 0.03 + 0.09 * this.alert.x + 0.1 * active + 0.14 * active * (st?.low ?? 0) - 0.05 * watching;
    springTo(this.crouch, crouch, 10, dt);
    // The torso: turned away into the backswing and round through the ball (its chest to its
    // forehand side to draw back).
    const fore = st?.fore ?? true;
    const twist = turn < 0 ? turn * (fore ? 34 : -26) : turn * (fore ? -26 : 18);
    springTo(this.yaw, twist * this.side, 22, dt);
    this.free = this.freeHand(now, turn, dt);
    // (The knees' bend brings it down a little.)
    this.free.y -= this.crouch.x * DANCER_SCALE * 0.6;
    if (ball) {
      const k = 1 - Math.exp(-14 * dt);
      this.look = lerp(this.look, ball, k);
    }
  }

  // The feet: each planted until the body has moved off from over it, then a quick step (lifted
  // and set down again), one foot at a time, leading with the one on the way it's going.
  private stepFeet(dt: number) {
    const s = this.side, vx = this.bx.v, vz = this.bz.v;
    const want = this.feet.map((_, i) => {
      const k = i === 0 ? -1 : 1;
      // Wider apart while it's playing; the forehand foot a little back.
      return { x: this.bx.x + k * 0.21 + vx * 0.1, y: 0, z: this.bz.x + (k === s ? 0.07 : -0.03) + vz * 0.08 };
    });
    const busy = this.feet.some((f) => f.stepping && f.u < 0.55);
    let pick = -1, worst = 0.075;
    this.feet.forEach((f, i) => {
      const off = Math.hypot(want[i].x - f.at.x, want[i].z - f.at.z);
      // The leading foot first.
      const lead = (i === 0 ? -1 : 1) * Math.sign(vx) > 0 ? 0.02 : 0;
      if (!f.stepping && off + lead > worst) { worst = off + lead; pick = i; }
    });
    if (pick >= 0 && !busy) {
      const f = this.feet[pick];
      Object.assign(f, { from: { ...f.at }, to: want[pick], u: 0, stepping: true });
    }
    for (const f of this.feet) {
      if (!f.stepping) continue;
      f.u = Math.min(1, f.u + dt / 0.15);
      const e = smooth(f.u);
      f.at = { x: mixN(f.from.x, f.to.x, e), y: Math.sin(Math.PI * f.u) * 0.055, z: mixN(f.from.z, f.to.z, e) };
      if (f.u >= 1) { f.stepping = false; f.at.y = 0; }
    }
  }

  /**
   * The glass character's pose, in its units about its own origin: stand that at (bx, 0, bz) in
   * this player's frame, turned to face −z, scaled by DANCER_SCALE.
   */
  pose(out: CharacterPose): CharacterPose {
    const now = this.time, s = this.side, S = DANCER_SCALE;
    const bx = this.bx.x, bz = this.bz.x;
    // Own frame to the character's (it faces −z: its +x is our −x).
    const loc = (p: V3, o: Triple) => { o[0] = -(p.x - bx) / S; o[1] = p.y / S; o[2] = -(p.z - bz) / S; return o; };
    const { active } = this.swingPhase(now);
    const alert = clamp(this.alert.x, 0, 1);
    const yaw = this.yaw.x;
    const lean = 4 + 8 * alert + 6 * active + 8 * active * (this.stroke?.low ?? 0);
    // Leaning into its run, and out over a ball wide of it.
    const wide = (this.blade.c.x - bx) * s - 0.55;
    const roll = clamp(this.bx.v * 5 + Math.max(0, wide) * 20 * s, -12, 12);
    // On its toes, ready: a little bounce; and a small hop as the other end hits (the split step).
    const hop = Math.sin(Math.PI * clamp((now - this.hopAt) / 0.24, 0, 1)) * 0.07;
    const bob = Math.sin(now * 7.2) * 0.012 * alert * (1 - active) + hop;
    const bodyY = 1.4 - this.crouch.x + bob;
    out.body[0] = 0; out.body[1] = bodyY; out.body[2] = 0.1;
    out.bodyRotation[0] = lean; out.bodyRotation[1] = yaw; out.bodyRotation[2] = roll;
    out.bodyScale[0] = 1; out.bodyScale[1] = 1 - this.crouch.x * 0.25; out.bodyScale[2] = 1;
    // The head over the body (leaning with it), turned to the ball.
    const p = (lean * Math.PI) / 180, r = (roll * Math.PI) / 180;
    const neck = 1.58;
    out.head[0] = -Math.sin(r) * neck; out.head[1] = bodyY + Math.cos(p) * neck; out.head[2] = 0.1 + Math.sin(p) * neck;
    const headAt = { x: bx - out.head[0] * S, y: out.head[1] * S, z: bz - out.head[2] * S };
    const to = sub(this.look, headAt);
    // (In the character's frame: its +z is our −z, its +x our −x.)
    const lookYaw = clamp((Math.atan2(-to.x, -to.z) * 180) / Math.PI, -70, 70);
    const lookPitch = clamp((Math.atan2(-to.y, Math.hypot(to.x, to.z)) * 180) / Math.PI, -30, 40);
    out.headRotation[0] = lookPitch; out.headRotation[1] = lookYaw; out.headRotation[2] = roll * 0.5;
    out.headScale = 1;
    // The paddle hand round the paddle's handle.
    const b = this.blade;
    const grip = sub(b.c, scale(b.d, GRIP));
    const paddleHand = s > 0 ? out.rightHand : out.leftHand;
    loc(grip, paddleHand);
    // The free hand, as update() has it.
    loc(this.free, s > 0 ? out.leftHand : out.rightHand);
    out.handScale = 0.68;
    // The feet, planted.
    loc(this.feet[s > 0 ? 1 : 0].at, out.rightFoot);
    loc(this.feet[s > 0 ? 0 : 1].at, out.leftFoot);
    out.rightFoot[1] += 0.28 + hop * 0.6; out.leftFoot[1] += 0.28 + hop * 0.6;
    out.footScale = 1;
    return out;
  }
}

const ZERO: V3 = { x: 0, y: 0, z: 0 };

/** A fresh pose to fill. */
export const newPose = (): CharacterPose => ({
  body: [0, 1.4, 0], bodyRotation: [0, 0, 0], bodyScale: [1, 1, 1],
  head: [0, 3, 0], headRotation: [0, 0, 0], headScale: 1,
  leftHand: [0.8, 1.6, 0.5], rightHand: [-0.8, 1.6, 0.5], handScale: 0.78,
  leftFoot: [0.4, 0.28, 0], rightFoot: [-0.4, 0.28, 0], footScale: 1,
});

