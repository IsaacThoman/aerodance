/*
 * Table Tennis's aim assist, in ball.ts's table frame (each player's own: rally.ts mine).
 *
 * A webcam sees the paddle hand's place across and up the picture well, its depth badly, its
 * face's angle hardly at all, and all of it late. So the assist makes up for what the camera
 * can't see, and for nothing the player didn't do:
 *  - A hit needs a swing: the blade really moved, fast and far enough, and not backwards. A paddle
 *    held still, or hanging by the player's side, is helped to nothing (it can still block a ball
 *    that flies straight into it).
 *  - The swing has to pass the ball within the level's zone, which is tight across and up (where
 *    the camera sees well) and deep along the table (where it doesn't): swingHit. The blade is
 *    drawn sliding to the ball it's about to meet (interceptNudge), so the hit looks like one.
 *  - The ball leaves off a face square to the swing, tipped down the table (the tracked face's
 *    angle isn't to be trusted), so where the swing goes the ball goes, and a return heading off
 *    the table is bent, by the level's share, towards one that lands (assistReturn).
 * The ball waiting to be served (rally.ts) is hit the same way: serveHit.
 *
 * Two people playing each other need time to get to each other's shots (PACE): a real arm swings
 * the blade at 3 to 11 m/s, and the ball off that crosses the table in a third of a second, which
 * nobody returns through a webcam. So with two the hardest shot still takes about a second.
 */

import { BALL_R, PADDLE_COOLDOWN, TABLE, aimShot, bounceOff, firstBounce, stepBall, v3 } from './ball.ts';
import type { Ball, V3 } from './ball.ts';

export type AssistLevel = 'off' | 'low' | 'normal' | 'high';
export const ASSIST_LEVELS: readonly AssistLevel[] = ['off', 'low', 'normal', 'high'];
/**
 * Each level's help: how far from the blade's middle a swing may pass the ball and still hit it,
 * across and up (`across`, metres) and along the table (`depth`); the share of the way a swing's
 * stray return is bent towards one that lands (`landing`), and a block's (`block`: a ball that
 * met a paddle not swinging). Off, only the blade itself meeting the ball counts.
 */
export interface Assist { across: number; depth: number; landing: number; block: number; }
export const ASSIST: Record<AssistLevel, Assist> = {
  off: { across: 0, depth: 0, landing: 0, block: 0 },
  low: { across: 0.14, depth: 0.25, landing: 0.6, block: 0.3 },
  normal: { across: 0.22, depth: 0.45, landing: 1, block: 0.5 },
  high: { across: 0.32, depth: 0.6, landing: 1, block: 0.7 },
};
/** The level a round starts at. */
export const DEFAULT_ASSIST: AssistLevel = 'normal';
/**
 * A swing: the blade moving at least `minSpeed` (m/s, the player's own) within the last `recent`
 * seconds, as part of a move of at least `travel` metres one way (a twitch of the tracking isn't
 * one), and not pulling back; nor is it one if the tracker's next pose has the hand sprung back
 * `sprung` metres against it (rig.ts borneOut). `touch`: the share of the zone inside which the
 * ball is hit at once, without waiting for its nearest.
 */
export const SWING = { minSpeed: 1, recent: 0.3, travel: 0.12, touch: 0.25, sprung: 0.06 } as const;
/**
 * A serve's swing is a firmer and longer one (m/s, and metres of travel), and has to carry the
 * blade `past` the ball (metres, along the swing): the ball waits for it, so there's time for a
 * real stroke, and neither a hand settling by the ball, a paddle raised to get ready, nor the
 * tracker's jitter (worst in depth, with the arm hanging down) serves it.
 */
export const SERVE_SWING = { minSpeed: 1.3, travel: 0.25, past: 0.02 } as const;

/**
 * With two players, how soon a shot may get to the other end of the table (seconds from the hit):
 * no sooner than `least`, however hard it was hit, and a gentle one in `gentle` (between them by
 * the ball's speed off the paddle, `speeds`, m/s). The first people recorded playing swung at the
 * ball about 0.7 s after a serve they weren't ready for and 1.1 s after one they saw coming, and
 * returned none that reached them in under 0.8 s. A serve gets a little longer: the other player
 * is standing waiting, and has no swing of the server's to read. Paced shots land between `near`
 * and `far` of the net (metres) and no nearer the table's sides than `side`: short enough that
 * the slower ball needn't be lobbed high (its top is about 0.7 m over the table, as the robot's
 * easy shots are), and it comes up to the other player's hand rather than at their end's edge.
 */
export interface Pace { least: number; gentle: number; }
export const PACE = {
  rally: { least: 1, gentle: 1.15 },
  serve: { least: 1.15, gentle: 1.2 },
  speeds: [2.5, 8],
  near: 0.45,
  far: 0.65,
  side: 0.3,
} as const;

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
const norm = (a: V3) => scale(a, 1 / (len(a) || 1));
/** Where the ball will be in t of the player's seconds, falling as they see it. */
const ballIn = (ball: Ball, t: number, timeScale: number) =>
  add(add(ball.pos, ball.vel, timeScale * t), v3(0, -0.5 * GRAVITY * timeScale * timeScale * t * t, 0));
/** How long a swing carries on (the arm soon stops), to guess where the blade is going. */
const SWING_CARRIES = 0.08;

/** Whether a ball leaving `from` at `vel` first bounces on the far half (and so is a fair return). */
export function landsFar(from: V3, vel: V3): boolean {
  const landed = firstBounce({ pos: { ...from }, vel: { ...vel }, cooldown: 0 });
  return !!landed && landed.at.z < 0;
}

/** How long a ball leaving `from` at `vel` takes to get to the far end of the table (Infinity: it doesn't, within 3 s). */
export function reachesFarEnd(from: V3, vel: V3): number {
  const b: Ball = { pos: { ...from }, vel: { ...vel }, cooldown: 0 };
  for (let t = STEP; t < 3; t += STEP) {
    stepBall(b, STEP, null, null);
    if (b.pos.z <= -TABLE.halfLength) return t;
  }
  return Infinity;
}
const STEP = 1 / 120;

/**
 * The ball's velocity off the paddle, bent `share` (0-1) of the way towards a return that lands on
 * the far half: aimed at the far half's nearest point to where it was headed, flying there at the
 * speed it left at (more slowly if that can't clear the net). A shot that already lands, or one
 * not going down the table at all, is left alone.
 *
 * With a `pace` (two players: PACE) the shot is also slowed to it: one that lands but gets to the
 * other end sooner than the pace allows is aimed again, to land where it was going, later; and
 * the share of it that isn't bent is no faster than the one that is, and smaller if it has to be
 * for the shot to keep to the pace (so at any level, a shot that lands gives the other the time).
 */
export function assistReturn(from: V3, vel: V3, share: number, pace?: Pace): V3 {
  if (vel.z > -0.5) return vel;
  const speed = Math.max(2.5, Math.hypot(vel.x, vel.z));
  const [slow, fast] = PACE.speeds;
  const wanted = pace ? pace.gentle + (pace.least - pace.gentle) * clamp((speed - slow) / (fast - slow), 0, 1) : 0;
  // (Its time to the other end only matters for a shot that lands: one that doesn't is aimed again anyway.)
  if (landsFar(from, vel) && (!pace || reachesFarEnd(from, vel) >= wanted)) return vel;
  if (share <= 0 && !pace) return vel;
  // Where it was headed: where it comes down to the table's height, without the table, net or air.
  const drop = from.y - (TABLE.top + BALL_R);
  const t = drop > 0 ? (vel.y + Math.sqrt(vel.y * vel.y + 2 * GRAVITY * drop)) / GRAVITY : Math.max(0.2, (2 * vel.y) / GRAVITY);
  const headed = add(from, vel, t);
  const side = TABLE.halfWidth - (pace ? PACE.side : MARGIN.side);
  const target = v3(
    clamp(headed.x, -side, side),
    0,
    pace ? clamp(headed.z, -PACE.far, -PACE.near) : clamp(headed.z, -TABLE.halfLength + MARGIN.end, -MARGIN.net),
  );
  // (No paced shot's flight to its bounce is under 0.4 s: it would be at the other end in 0.7.)
  let flight = clamp(Math.hypot(target.x - from.x, target.z - from.z) / speed, pace ? 0.4 : 0.25, 1.4);
  let aimed: V3 | null = null;
  for (let i = 0; pace ? flight < 1.8 : i < 8; i++, flight *= pace ? 1.06 : 1.2) {
    const shot = aimShot(from, target, flight);
    if (!shot) continue;
    aimed = shot;
    if (!pace || reachesFarEnd(from, shot) >= wanted) break;
  }
  if (!aimed) return vel;
  if (!pace) return add(scale(vel, 1 - share), aimed, share);
  // The part left as it was hit: no faster than the paced shot. And if the two together still land
  // too soon (the part left is flatter, so quicker down the table), more of it is bent, until they don't.
  const kept = scale(vel, Math.min(1, len(aimed) / (len(vel) || 1)));
  const blend = (s: number) => add(scale(kept, 1 - s), aimed, s);
  if (!landsFar(from, blend(share))) return blend(share);
  for (let s = share; s < 1; s += 0.1) {
    const shot = blend(s);
    if (landsFar(from, shot) && reachesFarEnd(from, shot) >= wanted) return shot;
  }
  return aimed;
}

/** How far the ball is from the blade's middle as a share of the zone: 1 at its edge. */
const zoneShare = (off: V3, zone: Assist) => Math.hypot(off.x / zone.across, off.y / zone.across, off.z / zone.depth);
/** A vector measured in the zone's shares (across and up by its width, along the table by its depth). */
const inZone = (a: V3, zone: Assist): V3 => v3(a.x / zone.across, a.y / zone.across, a.z / zone.depth);

/**
 * How far to move the swinging blade (in any direction) to meet the ball, or null while it isn't
 * coming, there's no swing, or it will pass outside the zone. The blade is followed along its
 * swing for a moment, the ball along its flight, and the blade sent to where they pass nearest,
 * as the ball nears.
 */
export function interceptNudge(ball: Ball, center: V3, paddleVel: V3, swing: V3, timeScale: number, zone: Assist): V3 | null {
  if (zone.across <= 0 || ball.cooldown > 0 || ball.vel.z <= 0 || len(swing) < SWING.minSpeed) return null;
  let best = { t: 0, miss: v3(), off: Infinity };
  for (let t = 0; t <= CONTACT_WINDOW.start + 1e-9; t += 0.01) {
    const miss = sub(ballIn(ball, t, timeScale), add(center, paddleVel, Math.min(t, SWING_CARRIES)));
    const off = zoneShare(miss, zone);
    if (off < best.off) best = { t, miss, off };
  }
  const weight = (1 - smoothstep(1, 1.3, best.off)) * (1 - smoothstep(CONTACT_WINDOW.full, CONTACT_WINDOW.start, best.t));
  return weight > 0 && best.t < CONTACT_WINDOW.start ? scale(best.miss, weight) : null;
}

/**
 * The strongest recent swing (from the blade's speeds, newest last, each with its time in the
 * player's seconds) and when it was at its fastest, or null: the fastest speed of the last
 * `recent` seconds, if `minSpeed` or more, that's part of a move of `travel` metres or more (SWING's, unless given) the
 * same way round it (speeds either side of it that go its way, without a break), and isn't a pull
 * back to wind up.
 */
export function swingOf(speeds: readonly { t: number; vel: V3 }[], now: number, travel: number = SWING.travel, minSpeed: number = SWING.minSpeed): { vel: V3; t: number } | null {
  let best = v3(), bestAt = -1;
  speeds.forEach((s, i) => {
    if (now - s.t > SWING.recent || s.vel.z > 0.2 * len(s.vel)) return;
    if (len(s.vel) > len(best)) { best = s.vel; bestAt = i; }
  });
  if (bestAt < 0 || len(best) < minSpeed) return null;
  // How far the blade went that way, either side of its fastest.
  const way = norm(best);
  let went = 0;
  for (const step of [-1, 1]) {
    for (let i = bestAt + (step > 0 ? 1 : 0); i > 0 && i < speeds.length; i += step) {
      const along = dot(speeds[i].vel, way);
      if (along < 0.3 * minSpeed) break;
      went += along * (speeds[i].t - speeds[i - 1].t);
    }
  }
  return went >= travel ? { vel: best, t: speeds[bestAt].t } : null;
}
/** swingOf's swing (its velocity at its fastest), or none. */
export const strongestSwing = (speeds: readonly { t: number; vel: V3 }[], now: number, travel: number = SWING.travel): V3 => swingOf(speeds, now, travel)?.vel ?? v3();

/** The ball's velocity off a swing: a face square to the swing and tipped down the table, moving as the swing does. */
function offSwing(ball: Ball, swing: V3): V3 {
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: PADDLE_COOLDOWN };
  bounceOff(b, norm(add(norm(swing), v3(0, 0.2, -1))), swing);
  return b.vel;
}

/**
 * The ball's velocity off a swing (`swing`, the player's recent strongest: strongestSwing) that
 * has passed it within the zone, or null if none has. It hits as the ball comes nearest the blade
 * (or is well inside the zone), so where the swing goes the ball goes; the landing assist then
 * brings it down on the far half.
 */
export function swingHit(ball: Ball, center: V3, paddleVel: V3, swing: V3, timeScale: number, zone: Assist): V3 | null {
  if (zone.across <= 0 || ball.cooldown > 0 || ball.vel.z <= 0 || len(swing) < SWING.minSpeed) return null;
  const off = sub(ball.pos, center);
  const share = zoneShare(off, zone);
  if (share > 1) return null;
  // Still closing on the blade, and not yet well inside: wait for its nearest.
  const vRel = sub(scale(ball.vel, timeScale), paddleVel);
  if (dot(inZone(off, zone), inZone(vRel, zone)) < 0 && share > SWING.touch) return null;
  return offSwing(ball, swing);
}

/**
 * The waiting ball's velocity off a serve, or null while there's none: a firm swing (`swing`:
 * strongestSwing with SERVE_SWING's travel) that has gone past the ball within the zone (the
 * level's, or Low's with the assist off: a serve has to start somehow), or is right on it. A
 * paddle brought up to the ball and stopped short of it, as a player getting ready does, hasn't
 * passed it and serves nothing.
 */
export function serveHit(ball: V3, center: V3, swing: V3, zone: Assist): V3 | null {
  const reach = zone.across > 0 ? zone : ASSIST.low;
  if (len(swing) < SERVE_SWING.minSpeed) return null;
  const off = sub(ball, center);
  const share = zoneShare(off, reach);
  if (share > 1) return null;
  // How far ahead of the blade the ball still is, along the swing.
  if (dot(off, norm(swing)) > -SERVE_SWING.past && share > SWING.touch) return null;
  const vel = offSwing({ pos: ball, vel: v3(), cooldown: 0 }, swing);
  // Down the table, whatever the swing: at least a gentle serve's pace.
  return v3(vel.x, vel.y, Math.min(vel.z, -2.5));
}
