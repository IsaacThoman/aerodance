import * as THREE from 'three';
import { makeRandom } from '../../stages/shared/random.ts';
import type { Random } from '../../stages/shared/random.ts';
import { BALL_RADIUS, HIT_ZONE, PADDLE, READY, TABLE } from '../layout.ts';
import type { End, TableSpec } from '../layout.ts';

// An endless, deterministic rally between a table's two arms. Plain maths, no rendering: the
// ball flies on true parabolas (no drag), bounces once on the far half, and is struck on the
// other side of the net in the receiver's HIT_ZONE. Every shot is drawn at random (seeded) and
// kept only if it clears the net, lands in, and arrives somewhere the receiver can reach.
//
// The table frame: the origin on the floor under the table's centre, +X along the table from
// end A to end B, +Y up, +Z = X × Y. A station's frame (layout.ts) is the table frame seen from
// its end: A's is shifted back half a table, B's turned round as well.

const G = 9.81;
const HALF = TABLE.length / 2;
/** The ball's centre as it touches the table. */
const TOP = TABLE.height + BALL_RADIUS;
/** What the ball keeps of its vertical speed in a bounce. */
const BOUNCE = 0.88;
/** The paddle's rubber, for how fast it has to be moving to send the ball back. */
const RUBBER = 0.8;
/** From the ball's centre at contact back to the paddle's centre. */
const PADDLE_OFFSET = BALL_RADIUS + PADDLE.thickness / 2;

const UP = new THREE.Vector3(0, 1, 0);

/** One ball flight: struck at one end, bounced on the far half, struck again at the other. */
export interface Shot {
  /** Who struck it. */
  by: End;
  /** Contact, in seconds on the robots' clock. */
  t0: number;
  /** The ball's centre at contact (table frame). */
  p0: THREE.Vector3;
  /** Its velocity arriving, and leaving. */
  vIn: THREE.Vector3;
  v0: THREE.Vector3;
  /** The bounce on the far half. */
  tb: number;
  pb: THREE.Vector3;
  v1: THREE.Vector3;
  /** The other end's contact. */
  t1: number;
  p1: THREE.Vector3;
  vIn1: THREE.Vector3;
  /** The paddle face's normal at contact (towards where the ball goes). */
  normal: THREE.Vector3;
  /** The paddle centre's velocity at contact. */
  swing: THREE.Vector3;
  /** Spin, radians a second about this axis (table frame), for the ball's turning. */
  spin: THREE.Vector3;
}

/** Where a paddle should be, in its station's frame. */
export interface PaddleTarget {
  /** The blade's centre (PADDLE's origin). */
  position: THREE.Vector3;
  /** The face's unit normal, towards where the ball goes. Either face may meet it. */
  normal: THREE.Vector3;
  /**
   * A whole orientation for the paddle frame: +Z along `normal`, the blade's tip (+Y) as near
   * straight up as it goes. An arm may roll the paddle about `normal` however suits it.
   */
  quaternion: THREE.Quaternion;
  /** The centre's velocity, metres a second. */
  velocity: THREE.Vector3;
}

export const makeTarget = (): PaddleTarget => ({
  position: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(),
});

/** A strike, as the striking end sees it (station frame). */
export interface Contact {
  time: number;
  /** The ball's centre. */
  ball: THREE.Vector3;
  /** The paddle's centre and face normal. */
  position: THREE.Vector3;
  normal: THREE.Vector3;
  velocity: THREE.Vector3;
}

const sign = (end: End) => (end === 'A' ? 1 : -1);
const other = (end: End): End => (end === 'A' ? 'B' : 'A');

/** Table frame → `end`'s station frame (a point or, with `direction`, a vector). */
export function toStation(end: End, v: THREE.Vector3, out: THREE.Vector3, direction = false): THREE.Vector3 {
  const shift = direction ? 0 : HALF;
  return end === 'A' ? out.set(v.x + shift, v.y, v.z) : out.set(shift - v.x, v.y, -v.z);
}

/** `end`'s station frame → the table frame. */
export function fromStation(end: End, v: THREE.Vector3, out: THREE.Vector3, direction = false): THREE.Vector3 {
  const shift = direction ? 0 : HALF;
  return end === 'A' ? out.set(v.x - shift, v.y, v.z) : out.set(shift - v.x, v.y, -v.z);
}

/** The paddle orientation with `normal` as +Z and the blade's tip as near up as it goes. */
export function paddleQuaternion(normal: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const y = _y.copy(UP).addScaledVector(normal, -normal.y);
  if (y.lengthSq() < 1e-6) y.set(1, 0, 0);
  y.normalize();
  const x = _x.crossVectors(y, normal).normalize();
  return out.setFromRotationMatrix(_m.makeBasis(x, y, normal));
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** How the shot leaving `p0` (struck by `by`) is chosen. */
function drawShot(random: Random, by: End, t0: number, p0: THREE.Vector3, vIn: THREE.Vector3, pace: number): Shot {
  const s = sign(by);
  const v0 = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let T1 = 0;
  let T2 = 0;
  for (let attempt = 0; attempt < 600; attempt++) {
    const last = attempt === 599;
    // The last try is a safe, plain shot down the middle.
    const across = last ? 0.25 : random.range(0.3, 1.12);
    const wide = last ? 0 : random.range(-0.56, 0.56);
    T1 = last ? 0.56 : random.range(0.44, 0.72) / pace;
    const behind = last ? 0.24 : random.range(-HIT_ZONE.x[1], -HIT_ZONE.x[0]);
    const keep = last ? 0.9 : random.range(0.8, 0.98);

    pb.set(s * across, TOP, wide);
    v0.set((pb.x - p0.x) / T1, (TOP - p0.y + 0.5 * G * T1 * T1) / T1, (pb.z - p0.z) / T1);
    // Over the net with room to spare, and not lobbed to the rafters.
    const tNet = -p0.x / v0.x;
    const yNet = p0.y + v0.y * tNet - 0.5 * G * tNet * tNet;
    const apex = v0.y > 0 ? p0.y + (v0.y * v0.y) / (2 * G) : p0.y;
    if (!last && (yNet < TABLE.height + TABLE.netHeight + BALL_RADIUS + 0.035 || apex > 1.42)) continue;
    // A face the arm can turn to: mostly towards the far end, tilted no more than it should be.
    normal.subVectors(v0, vIn).normalize();
    if (!last && (s * normal.x < 0.6 || normal.y < -0.22 || normal.y > 0.62)) continue;
    // The bounce: the vertical speed reversed and mostly kept, a little of the rest lost.
    v1.set(v0.x * keep, -(v0.y - G * T1) * BOUNCE, v0.z * keep);
    const x1 = s * (HALF + behind);
    T2 = (x1 - pb.x) / v1.x;
    p1.set(x1, TOP + v1.y * T2 - 0.5 * G * T2 * T2, pb.z + v1.z * T2);
    if (!last && (T2 < 0.2 / pace || T2 > 0.8 || p1.y < HIT_ZONE.y[0] || p1.y > HIT_ZONE.y[1] || Math.abs(p1.z) > HIT_ZONE.z[1])) continue;
    break;
  }
  const vIn1 = new THREE.Vector3(v1.x, v1.y - G * T2, v1.z);
  // The paddle meets it moving along a slightly rising line, about as fast as the rubber needs.
  const along = (RUBBER * vIn.dot(normal) + v0.dot(normal)) / (1 + RUBBER);
  const swing = normal.clone().addScaledVector(UP, 0.3).normalize().multiplyScalar(THREE.MathUtils.clamp(along * 1.3, 0.9, 2.2));
  // Topspin: about the axis across the flight, by how far it rose through the stroke.
  const spin = new THREE.Vector3().crossVectors(UP, v0).normalize().multiplyScalar(25 + 40 * random.next());
  return { by, t0, p0: p0.clone(), vIn: vIn.clone(), v0, tb: t0 + T1, pb, v1, t1: t0 + T1 + T2, p1, vIn1, normal, swing, spin };
}

interface Key {
  t: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  n: THREE.Vector3;
}

const key = (t: number, p: THREE.Vector3, n: THREE.Vector3, v = new THREE.Vector3()): Key => ({ t, p, v, n });

// The stroke's timing, in seconds: the backswing is reached this long before contact, the
// follow-through ends this long after, the paddle is back at READY by `RECOVER`, and it reacts
// to the opponent's strike this long after it.
const BACKSWING_S = 0.3;
const FOLLOW_S = 0.2;
const RECOVER_S = 0.62;
const REACT_S = 0.08;
// How far back the backswing goes, and how far through the follow-through carries.
const BACKSWING_M = 0.26;
const FOLLOW_M = 0.17;

const READY_V = new THREE.Vector3(...READY);
const FORWARD = new THREE.Vector3(1, 0, 0);

/**
 * One table's rally. advance(t) keeps shots drawn ahead of the clock; ball(t) is where the ball
 * is; paddle(end, t) is where that end's paddle should be (its station frame), swinging back
 * before each of its strikes, meeting the ball, following through and returning to READY.
 *
 * const rally = new Rally(TABLES[0]);
 * rally.advance(time);
 * rally.ball(time, ball.position);            // the table frame
 * rally.paddle('A', time, target);            // A's station frame
 */
export class Rally {
  readonly shots: Shot[] = [];
  private random: Random;
  private readonly spec: Pick<TableSpec, 'seed' | 'pace'>;

  constructor(spec: Pick<TableSpec, 'seed' | 'pace'>) {
    this.spec = spec;
    this.random = this.restart();
  }

  // From the top: the first strike, at time 0, is A's, from the middle of its zone, as if
  // returning a shot. The same seed draws the same rally every time.
  private restart(): Random {
    this.random = makeRandom(this.spec.seed);
    const p0 = fromStation('A', new THREE.Vector3(-0.25, 1.06, 0), new THREE.Vector3());
    this.shots.length = 0;
    this.shots.push(drawShot(this.random, 'A', 0, p0, new THREE.Vector3(-3, -1.2, 0), this.spec.pace));
    return this.random;
  }

  /** Draws shots until they reach `ahead` seconds past `t`, and forgets those long gone. */
  advance(t: number, ahead = 6): void {
    // Wound back past what's kept (a dev time jump): draw it all again.
    if (t < this.shots[0].t0) this.restart();
    let last = this.shots[this.shots.length - 1];
    while (last.t1 < t + ahead) {
      last = drawShot(this.random, other(last.by), last.t1, last.p1, last.vIn1, this.spec.pace);
      this.shots.push(last);
    }
    // Keep a few seconds back, for anything that looks behind.
    while (this.shots.length > 2 && this.shots[1].t1 < t - 4) this.shots.shift();
  }

  /** The shot in the air at `t` (or the first, before it starts). */
  shotAt(t: number): Shot {
    for (const shot of this.shots) if (t < shot.t1) return shot;
    return this.shots[this.shots.length - 1];
  }

  /** The ball's centre at `t`, in the table frame. */
  ball(t: number, out: THREE.Vector3): THREE.Vector3 {
    const shot = this.shotAt(t);
    if (t < shot.t0) return out.copy(shot.p0);
    if (t < shot.tb) {
      const s = t - shot.t0;
      return out.copy(shot.p0).addScaledVector(shot.v0, s).setY(shot.p0.y + shot.v0.y * s - 0.5 * G * s * s);
    }
    const s = Math.min(t, shot.t1) - shot.tb;
    return out.copy(shot.pb).addScaledVector(shot.v1, s).setY(shot.pb.y + shot.v1.y * s - 0.5 * G * s * s);
  }

  /** `end`'s strikes from about `t` on, in its station frame: the next first. */
  contacts(end: End, t: number, count = 2): Contact[] {
    const out: Contact[] = [];
    for (const shot of this.shots) {
      if (shot.by !== end || shot.t0 < t) continue;
      out.push(this.contact(shot));
      if (out.length >= count) break;
    }
    return out;
  }

  private contact(shot: Shot): Contact {
    const ball = toStation(shot.by, shot.p0, new THREE.Vector3());
    const normal = toStation(shot.by, shot.normal, new THREE.Vector3(), true);
    return {
      time: shot.t0, ball, normal,
      position: ball.clone().addScaledVector(normal, -PADDLE_OFFSET),
      velocity: toStation(shot.by, shot.swing, new THREE.Vector3(), true),
    };
  }

  /** Where `end`'s paddle should be at `t`, in its station frame. */
  paddle(end: End, t: number, out: PaddleTarget): PaddleTarget {
    // Its last strike at or before t, the one after, and the opponent's in between.
    let prev: Shot | null = null;
    let next: Shot | null = null;
    for (const shot of this.shots) {
      if (shot.by !== end) continue;
      if (shot.t0 <= t) prev = shot;
      else { next = shot; break; }
    }
    const keys: Key[] = [];
    if (prev) {
      const hit = this.contact(prev);
      const rise = hit.velocity.clone().normalize();
      keys.push(key(hit.time, hit.position, hit.normal, hit.velocity));
      const follow = hit.position.clone().addScaledVector(rise, FOLLOW_M).addScaledVector(UP, 0.07);
      keys.push(key(hit.time + FOLLOW_S, follow, hit.normal.clone().lerp(UP, 0.25).normalize()));
      keys.push(key(hit.time + RECOVER_S, READY_V, FORWARD));
      if (prev.t1 + REACT_S > hit.time + RECOVER_S + 0.05) keys.push(key(prev.t1 + REACT_S, READY_V, FORWARD));
    } else {
      keys.push(key(-Infinity, READY_V, FORWARD));
    }
    if (next) {
      const hit = this.contact(next);
      const rise = hit.velocity.clone().normalize();
      // Back along the stroke's line, though not so far down: a rising stroke starts low enough.
      const back = hit.position.clone().addScaledVector(rise.setY(rise.y * 0.4), -BACKSWING_M).addScaledVector(UP, -0.02);
      // Drop the waits that the next stroke's backswing has already overtaken.
      const backAt = hit.time - BACKSWING_S;
      while (keys.length > 1 && keys[keys.length - 1].t > backAt - 0.15) keys.pop();
      // Before its first stroke it waits at READY until it's time to move.
      if (!prev) keys.push(key(backAt - 0.45, READY_V, FORWARD));
      keys.push(key(backAt, back, hit.normal));
      keys.push(key(hit.time, hit.position, hit.normal, hit.velocity));
    }
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[Math.min(i + 1, keys.length - 1)];
    if (a === b || !Number.isFinite(a.t) || t >= b.t) {
      const k = t >= b.t ? b : a;
      out.position.copy(k.p);
      out.velocity.set(0, 0, 0);
      out.normal.copy(k.n);
    } else {
      hermite(a, b, t, out.position, out.velocity);
      const s = THREE.MathUtils.smootherstep(t, a.t, b.t);
      slerpUnit(a.n, b.n, s, out.normal);
    }
    paddleQuaternion(out.normal, out.quaternion);
    return out;
  }
}

/** Cubic Hermite between two keys: position and velocity at `t`. */
function hermite(a: Key, b: Key, t: number, p: THREE.Vector3, v: THREE.Vector3) {
  const d = b.t - a.t;
  const s = (t - a.t) / d;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  p.set(0, 0, 0).addScaledVector(a.p, h00).addScaledVector(a.v, h10 * d).addScaledVector(b.p, h01).addScaledVector(b.v, h11 * d);
  // d/dt of the above.
  const g00 = (6 * s2 - 6 * s) / d;
  const g10 = 3 * s2 - 4 * s + 1;
  const g01 = (-6 * s2 + 6 * s) / d;
  const g11 = 3 * s2 - 2 * s;
  v.set(0, 0, 0).addScaledVector(a.p, g00).addScaledVector(a.v, g10).addScaledVector(b.p, g01).addScaledVector(b.v, g11);
}

const _qa = new THREE.Quaternion();

/** Turns unit vector `a` towards `b` by share `s` of the angle between them. */
function slerpUnit(a: THREE.Vector3, b: THREE.Vector3, s: number, out: THREE.Vector3) {
  _qa.setFromUnitVectors(a, b);
  _qa.slerp(_identity, 1 - s);
  return out.copy(a).applyQuaternion(_qa).normalize();
}

const _identity = new THREE.Quaternion();
