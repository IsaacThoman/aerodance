/*
 * Table Tennis's Easy controls, as Wii Sports Resort plays: where the player's hand is doesn't
 * matter, only when and how they swing. Each player's dancer steps across to where the ball will
 * come (Round moves it: rig.step), and a swing whose fastest moment comes as the ball reaches them
 * hits it. All in ball.ts's table frame as the player has it (rally.ts mine: they're at +z).
 *
 * - The ball is met where it crosses the player's hitting line (EASY.hitZ), after its bounce on
 *   their half (contactOf). A ball that won't bounce there (going long or wide) is let go: the
 *   point's theirs.
 * - A swing (easySwing): the hand moving fast and far enough towards the table (a forehand or a
 *   backhand going across too, a brush upwards, a smash downwards): bringing the paddle back to
 *   get ready, or across to where the ball's coming, isn't one. It's judged as it happened: the
 *   camera and the drawing show it a lag late.
 * - Its timing, against the moment the ball reaches the line: within EASY.early before to
 *   EASY.late after, it's hit; a hard swing earlier or later is a whiff ("too early", "too late").
 *   Each ball gets one go, and after a swing the arm needs EASY.recover before another counts, so
 *   swinging all the time doesn't play the game.
 * - Where it goes (easyShot): early pulls it across the table, late pushes it down the line (as
 *   Wii Sports' does), and the swing's own way across adds to that; the harder the swing the faster
 *   and deeper the shot. A high ball met with a hard downward swing is a smash. The further off
 *   the swing's timing and the harder it is, the more the shot can stray: long, wide, or (flat and
 *   low) into the net.
 */

import { BALL_R, TABLE, aimShot, stepBall, v3 } from './ball.ts';
import type { Ball, BallEvent, V3 } from './ball.ts';
import type { Side } from './arms.ts';

export const EASY = {
  /** Where the ball is met: its crossing of this line (own frame, z; the near end is at TABLE.halfLength). */
  hitZ: 1.3,
  /**
   * A swing: at least this fast (m/s) at its fastest, part of a move this long (m) one way, at
   * least `forward` of it towards the table. Out of time, one at least `whiff` fast is the ball's go
   * (a gentler one, the hand getting ready, isn't).
   */
  minSpeed: 1.8,
  travel: 0.14,
  forward: 0.25,
  whiff: 3.5,
  /**
   * How much later than the camera's delay a swing's fastest moment shows in the drawn hand (s):
   * less than a paddle's place lags (round.ts DRAW_LAG), as the eased hand's speed peaks before
   * its place has caught up. (Measured in the play simulation: with it, swings timed dead on at
   * a webcam's rate and delay are judged within a few hundredths either way.)
   */
  drawLag: 0.015,
  /** The timing that hits (s): this much before the ball reaches the line, to this much after. */
  early: 0.2,
  late: 0.13,
  /** Swings this much earlier than that aren't at this ball yet (getting ready); this much later, it's gone. */
  ahead: 0.6,
  behind: 0.35,
  /** After a swing, the arm needs this long (s) before another counts. */
  recover: 0.35,
  /** A shot's flight to its bounce (s) for the gentlest swing and the hardest; a smash's. */
  flight: { soft: 0.85, hard: 0.48, smash: 0.38 },
  /** Swing speeds (m/s) from gentle to hard. */
  speeds: [1.8, 6],
  /** Where shots are aimed: how far across early and late timing sends them (m), and the swing's own way across. */
  angle: 0.48,
  across: 0.22,
  /** How deep (from the net, m) the gentlest and the hardest go. */
  depth: [0.55, 1.1],
  /** A smash: the ball at least this far above the table, a downward swing at least this fast. */
  smash: { height: 0.35, speed: 3 },
  /** How far a shot strays (m, standard deviation): at best, more with the timing off-centre, more with the swing's power. */
  stray: { base: 0.05, timing: 0.22, power: 0.12 },
} as const;

const GRAVITY = 9.81;
const STEP = 1 / 240;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);

/**
 * The strongest recent swing (from the blade's speeds, newest last, each with its time in the
 * player's seconds) since `after`, and when it was at its fastest: towards the table (EASY.forward),
 * at least minSpeed, part of a move of `travel` the same way. Null if none.
 */
export function easySwing(speeds: readonly { t: number; vel: V3 }[], now: number, after = -Infinity): { vel: V3; t: number } | null {
  let best = -1, bestSpeed = 0;
  speeds.forEach((s, i) => {
    if (s.t <= after || now - s.t > 0.3) return;
    const v = len(s.vel);
    // (Back towards the player is winding up, and across alone is getting there, not swinging.)
    if (s.vel.z > -EASY.forward * v) return;
    if (v > bestSpeed) { bestSpeed = v; best = i; }
  });
  if (best < 0 || bestSpeed < EASY.minSpeed) return null;
  const way = speeds[best].vel, l = len(way);
  let went = 0;
  for (const step of [-1, 1]) {
    for (let i = best + (step > 0 ? 1 : 0); i > 0 && i < speeds.length; i += step) {
      const along = (speeds[i].vel.x * way.x + speeds[i].vel.y * way.y + speeds[i].vel.z * way.z) / l;
      if (along < 0.3 * EASY.minSpeed) break;
      went += along * (speeds[i].t - speeds[i - 1].t);
    }
  }
  // Still going (its fastest is this frame's): wait to see how far.
  if (best === speeds.length - 1 && went < EASY.travel) return null;
  return went >= EASY.travel ? { vel: way, t: speeds[best].t } : null;
}

/**
 * Where and when (seconds from now, the ball's time) a ball coming at the player crosses their
 * hitting line, having bounced on their half (`bounced`: it already has), or null if it won't:
 * it's going the other way, or it'll be out (no bounce on their half first), or it'll be down by
 * the floor first.
 */
export function contactOf(ball: Ball, bounced: boolean): { t: number; at: V3; ball: Ball } | null {
  if (ball.vel.z <= 0) return null;
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: 0 };
  const events: BallEvent[] = [];
  for (let t = 0; t < 2.5; t += STEP) {
    if (b.pos.z >= EASY.hitZ) return bounced ? { t, at: { ...b.pos }, ball: b } : null;
    events.length = 0;
    for (const e of stepBall(b, STEP, null, null, events)) {
      // (A bounce on the far half first is a real serve's: it comes on.)
      if (e.type === 'table' && e.at.z <= 0) continue;
      if (e.type === 'table' && !bounced) bounced = true;
      else if (e.type !== 'paddle') return null;
    }
    if (b.vel.z <= 0) return null;
  }
  return null;
}

/** A shot's power, 0-1, from the swing's speed. */
export const powerOf = (swing: V3) => clamp((len(swing) - EASY.speeds[0]) / (EASY.speeds[1] - EASY.speeds[0]), 0, 1);

/** A seeded-or-not standard normal from a uniform source. */
const normal = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/**
 * A ball's velocity off an Easy swing, from where it's met (`from`, own frame), with the swing's
 * timing (`u`: -1 as early as hits, 0 dead on, 1 as late as hits), for a player holding the paddle
 * in `hand`. With `least` (two players) its flight to the bounce is no shorter than that. Says too
 * whether it was a smash.
 */
export function easyShot(from: V3, swing: V3, u: number, hand: Side, rand: () => number = Math.random, least = 0): { vel: V3; smash: boolean } {
  const power = powerOf(swing), l = len(swing) || 1;
  const smash = from.y >= TABLE.top + EASY.smash.height && swing.y < -0.45 * l && l >= EASY.smash.speed;
  // Early pulls it to the side across the body from the paddle hand (a right-hander's forehand
  // early goes to their left), late pushes it the other way; the swing's own way across adds to it.
  const out = hand === 'left' ? -1 : 1;
  const aimX = clamp(u * out * EASY.angle + (swing.x / l) * EASY.across, -0.55, 0.55);
  const depth = smash ? 1.0 : EASY.depth[0] + (EASY.depth[1] - EASY.depth[0]) * power;
  // Off-centre timing and power make it stray.
  const stray = EASY.stray.base + EASY.stray.timing * u * u + EASY.stray.power * power * power;
  const target = v3(aimX + normal(rand) * stray, 0, -depth + normal(rand) * stray * 0.8);
  let flight = Math.max(least, smash ? EASY.flight.smash : EASY.flight.soft + (EASY.flight.hard - EASY.flight.soft) * power);
  const onTable = Math.abs(target.x) <= TABLE.halfWidth - BALL_R && target.z >= -TABLE.halfLength + BALL_R && target.z <= -0.05;
  if (onTable) {
    for (let i = 0; i < 10; i++, flight *= 1.12) {
      const vel = aimShot(from, target, flight);
      if (vel) return { vel, smash };
    }
  }
  // Strayed off the table (or nothing lands there from here): it goes where it was aimed, out.
  const t = Math.max(0.35, flight);
  return { vel: v3((target.x - from.x) / t, (TABLE.top + BALL_R - from.y + 0.5 * GRAVITY * t * t) / t, (target.z - from.z) / t), smash };
}

/**
 * A serve off an Easy swing at the tossed ball (`from`, own frame): over onto the other half,
 * across as the swing goes, deeper the harder it is; with `least` (two players) no quicker to
 * its bounce than that.
 */
export function easyServe(from: V3, swing: V3, rand: () => number = Math.random, least = 0): V3 {
  const power = powerOf(swing), l = len(swing) || 1;
  const target = v3(clamp((swing.x / l) * 0.35 + normal(rand) * 0.06, -0.5, 0.5), 0, -(0.7 + 0.4 * power));
  let flight = Math.max(least, 0.75 - 0.15 * power);
  for (let i = 0; i < 10; i++, flight *= 1.12) {
    const vel = aimShot(from, target, flight);
    if (vel) return vel;
  }
  return v3(0, 1.4, -4.4);
}
