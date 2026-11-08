/*
 * The /?hands demo's aim assist, in ball.ts's table frame. It helps in two places, each keeping the
 * shape of the player's own swing:
 *  - Contact: as the ball nears the blade, the blade slides across its own face (never along its
 *    normal, so the swing's timing and path stay the player's) to where the ball will meet it.
 *  - Landing: a return the paddle sends somewhere off the far half is bent, by a share, towards
 *    a shot that lands there: aimed at the nearest point on the far half to where it was going,
 *    at about the speed it left at.
 * At max, a swing is judged rather than the blade's contact: a forward swing that passes near the
 * ball hits it (swingHit), off a face square to the swing whatever the tracked blade's angle, and
 * the blade reaches for the ball in 3D (interceptNudge), meeting it a little early or late too.
 */

import { BALL_R, PADDLE_COOLDOWN, TABLE, aimShot, bounceOff, firstBounce, v3 } from './ball.ts';
import type { Ball, PaddlePose, V3 } from './ball.ts';

export type AssistLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
export const ASSIST_LEVELS: readonly AssistLevel[] = ['off', 'low', 'medium', 'high', 'max'];
/**
 * Each level's help: the furthest miss (in metres, past the blade's edge) the blade slides all the
 * way to cover (fading out over the next 40%): across its face, or at max in any direction; the
 * share of the way a stray return is bent towards one that lands; and whether a swing near the
 * ball hits it.
 */
export const ASSIST: Record<AssistLevel, { reach: number; landing: number; swing: boolean }> = {
  off: { reach: 0, landing: 0, swing: false },
  low: { reach: 0.06, landing: 0.35, swing: false },
  medium: { reach: 0.13, landing: 0.7, swing: false },
  high: { reach: 0.24, landing: 1, swing: false },
  max: { reach: 0.4, landing: 1, swing: true },
};
/**
 * A swing, at max: at least this fast (m/s, the player's), within the last `recent` seconds, and
 * passing within `zone` metres of the ball (`touch`: close enough to hit before its nearest).
 */
export const SWING = { minSpeed: 0.8, recent: 0.3, zone: 0.4, touch: 0.1 } as const;

const GRAVITY = 9.81;
/** The contact assist starts this long (in the player's seconds) before the ball reaches the blade, in full by the nearer. */
const CONTACT_WINDOW = { start: 0.22, full: 0.12 };
/** Where on the far half returns are aimed, kept this far in from its edges and the net. */
const MARGIN = { side: 0.12, end: 0.15, net: 0.45 };

const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const add = (a: V3, b: V3, k = 1): V3 => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** a with its part along the unit n taken out: what's left lies in the plane n faces out of. */
const flat = (a: V3, n: V3) => sub(a, scale(n, dot(a, n)));
const norm = (a: V3) => scale(a, 1 / (len(a) || 1));
/** Where the ball will be in t of the player's seconds, falling as they see it. */
const ballIn = (ball: Ball, t: number, timeScale: number) =>
  add(add(ball.pos, ball.vel, timeScale * t), v3(0, -0.5 * GRAVITY * timeScale * timeScale * t * t, 0));
/** How long a swing carries on (the arm soon stops), to guess where the blade is going. */
const SWING_CARRIES = 0.08;

/**
 * How far to slide the blade across its face so the ball meets its middle, or null while the ball
 * isn't closing on it. paddleVel is the blade's own (real-time) speed; the ball's world runs at
 * timeScale, so its speed and gravity are as the player sees them. Misses up to `reach` are
 * covered, those well beyond it left alone (a swing nowhere near the ball stays a miss).
 */
export function contactNudge(ball: Ball, paddle: PaddlePose, paddleVel: V3, timeScale: number, reach: number): V3 | null {
  if (reach <= 0 || ball.cooldown > 0) return null;
  const n = paddle.normal;
  const rel = sub(ball.pos, paddle.center);
  const d = dot(rel, n);
  // Closing on the face, from whichever side it's on.
  const vRel = sub(scale(ball.vel, timeScale), paddleVel);
  const closing = -dot(vRel, n) * Math.sign(d || 1);
  if (closing < 0.3) return null;
  const t = Math.max(0, Math.abs(d) - BALL_R) / closing;
  if (t > CONTACT_WINDOW.start) return null;
  // Where across the face it will meet (the ball falling as the player sees it), and so how far off the middle.
  const fall = v3(0, -0.5 * GRAVITY * timeScale * timeScale * t * t, 0);
  const miss = add(add(flat(rel, n), flat(vRel, n), t), flat(fall, n));
  const off = len(miss);
  const weight = (1 - smoothstep(reach, reach * 1.4, off)) * (1 - smoothstep(CONTACT_WINDOW.full, CONTACT_WINDOW.start, t));
  return weight > 0 ? scale(miss, weight) : null;
}

/** Whether a ball leaving `from` at `vel` first bounces on the far half (and so is a fair return). */
export function landsFar(from: V3, vel: V3): boolean {
  const landed = firstBounce({ pos: { ...from }, vel: { ...vel }, cooldown: 0 });
  return !!landed && landed.at.z < 0;
}

/**
 * The ball's velocity off the paddle, bent `share` (0-1) of the way towards a return that lands on
 * the far half: aimed at the far half's nearest point to where it was headed, flying there at the
 * speed it left at (more slowly if that can't clear the net). A shot that already lands, or one
 * not going down the table at all, is left alone.
 */
export function assistReturn(from: V3, vel: V3, share: number): V3 {
  if (share <= 0 || vel.z > -0.5 || landsFar(from, vel)) return vel;
  // Where it was headed: where it comes down to the table's height, without the table, net or air.
  const drop = from.y - (TABLE.top + BALL_R);
  const t = drop > 0 ? (vel.y + Math.sqrt(vel.y * vel.y + 2 * GRAVITY * drop)) / GRAVITY : Math.max(0.2, (2 * vel.y) / GRAVITY);
  const headed = add(from, vel, t);
  const target = v3(
    clamp(headed.x, -TABLE.halfWidth + MARGIN.side, TABLE.halfWidth - MARGIN.side),
    0,
    clamp(headed.z, -TABLE.halfLength + MARGIN.end, -MARGIN.net),
  );
  const speed = Math.max(2.5, Math.hypot(vel.x, vel.z));
  let flight = clamp(Math.hypot(target.x - from.x, target.z - from.z) / speed, 0.25, 1.4);
  for (let i = 0; i < 8; i++, flight *= 1.2) {
    const aimed = aimShot(from, target, flight);
    if (!aimed) continue;
    return add(scale(vel, 1 - share), aimed, share);
  }
  return vel;
}

/**
 * At max: how far to move the blade (in any direction) to meet the ball, or null while it isn't
 * coming. The blade is followed along its swing for a moment, the ball along its flight, and the
 * blade sent to where they pass nearest, as the ball nears.
 */
export function interceptNudge(ball: Ball, center: V3, paddleVel: V3, timeScale: number, reach: number): V3 | null {
  if (reach <= 0 || ball.cooldown > 0 || ball.vel.z <= 0) return null;
  let best = { t: 0, miss: v3(), off: Infinity };
  for (let t = 0; t <= CONTACT_WINDOW.start + 1e-9; t += 0.01) {
    const miss = sub(ballIn(ball, t, timeScale), add(center, paddleVel, Math.min(t, SWING_CARRIES)));
    const off = len(miss);
    if (off < best.off) best = { t, miss, off };
  }
  const weight = (1 - smoothstep(reach, reach * 1.4, best.off)) * (1 - smoothstep(CONTACT_WINDOW.full, CONTACT_WINDOW.start, best.t));
  return weight > 0 && best.t < CONTACT_WINDOW.start ? scale(best.miss, weight) : null;
}

/**
 * The strongest recent swing (from the blade's speeds, newest last, each with its time in the
 * player's seconds): only those going forward-ish count, not a pull back to wind up.
 */
export function strongestSwing(speeds: readonly { t: number; vel: V3 }[], now: number): V3 {
  let best = v3();
  for (const s of speeds) {
    if (now - s.t > SWING.recent || s.vel.z > 0.2 * len(s.vel)) continue;
    if (len(s.vel) > len(best)) best = s.vel;
  }
  return best;
}

/**
 * At max: the ball's velocity off a swing (`swing`, the player's recent strongest) that has
 * passed near it, or null if none has. It hits as the ball comes nearest the blade (or touches
 * it), off a face square to the swing and tipped down the table, so where the swing goes the
 * ball goes; the landing assist then brings it down on the far half.
 */
export function swingHit(ball: Ball, center: V3, paddleVel: V3, swing: V3, timeScale: number): V3 | null {
  if (ball.cooldown > 0 || ball.vel.z <= 0 || len(swing) < SWING.minSpeed) return null;
  const off = sub(ball.pos, center);
  const d = len(off);
  if (d > SWING.zone) return null;
  // Still closing on the blade, and not yet touching: wait for its nearest.
  const vRel = sub(scale(ball.vel, timeScale), paddleVel);
  if (dot(off, vRel) < 0 && d > SWING.touch) return null;
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: PADDLE_COOLDOWN };
  bounceOff(b, norm(add(norm(swing), v3(0, 0.2, -1))), swing);
  return b.vel;
}
