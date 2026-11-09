/*
 * A stand-in player, for development (the O and P keys, or window.tableTennis.rigs[i].autoplay;
 * and the rally tests): where its paddle's blade goes, in its own frame (rally.ts mine: it stands
 * at +z), to meet each ball that comes at it, and to serve the one waiting for it. It waits at home, lines up behind where the ball will cross
 * its hitting plane, and swings forward through it as it arrives. The game sets its hands where
 * a tracked player's would be, so it plays through the real paddle, aim assist and all.
 */

import { TABLE, stepBall, v3 } from './ball.ts';
import type { Ball, V3 } from './ball.ts';

export const AUTOPLAY = {
  /** Where it meets the ball: this far down the table (its own frame, the near end at TABLE.halfLength). */
  hitZ: 1.3,
  /** How far behind that it lines up, and how long its forward swing takes (in its own seconds). */
  backswing: 0.24,
  swingS: 0.17,
  /** Its blade between balls: up in front of it, where its player can see it. */
  home: v3(0.24, TABLE.top + 0.44, 1.42),
  /** How far across, and how low and high, its blade goes. */
  reach: { x: 0.75, low: TABLE.top + 0.08, high: 1.7 },
  /** Alone, it raises its free hand for the robot's serve after this long with the ball held, for this long (seconds). */
  serveAfter: 1.2,
  raiseFor: 0.4,
  /**
   * With two, serving: it waits `serveWait` seconds by the waiting ball, draws back `serveBack`
   * metres over `serveWind`, swings through the ball over swingS and `serveThrough` past it, and
   * tries again if the ball's still there.
   */
  serveWait: 0.7,
  serveBack: 0.3,
  serveWind: 0.3,
  serveThrough: 0.25,
} as const;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const STEP = 1 / 240;

/**
 * Where a ball (as the stand-in sees it, in its own frame) will cross the hitting plane, and how
 * soon in its own seconds (the ball's world runs at timeScale); null while it isn't coming.
 */
export function arrival(seen: Ball, timeScale = 1): { at: V3; t: number } | null {
  if (seen.vel.z <= 0 || seen.cooldown > 0) return null;
  // Already through it: meet it where it is, for a moment.
  if (seen.pos.z >= AUTOPLAY.hitZ) return seen.pos.z < AUTOPLAY.hitZ + 0.3 ? { at: { ...seen.pos }, t: 0 } : null;
  const b: Ball = { pos: { ...seen.pos }, vel: { ...seen.vel }, cooldown: 0 };
  for (let t = STEP; t < 2; t += STEP) {
    stepBall(b, STEP, null, null);
    if (b.pos.z >= AUTOPLAY.hitZ) return { at: b.pos, t: t / timeScale };
    if (b.pos.y < 0.1 || b.vel.z <= 0) return null;
  }
  return null;
}

/**
 * The blade's place (own frame) for a ball arriving so, or none: at home (on the side of the
 * paddle's hand), lined up behind it, then swung forward through it.
 */
export function autoplayBlade(arriving: { at: V3; t: number } | null, hand: 'left' | 'right' = 'right'): V3 {
  if (!arriving) return v3(AUTOPLAY.home.x * (hand === 'left' ? -1 : 1), AUTOPLAY.home.y, AUTOPLAY.home.z);
  const { reach } = AUTOPLAY;
  const u = clamp(1 - arriving.t / AUTOPLAY.swingS, 0, 1);
  return v3(clamp(arriving.at.x, -reach.x, reach.x), clamp(arriving.at.y, reach.low, reach.high), AUTOPLAY.hitZ + AUTOPLAY.backswing * (1 - u));
}

/**
 * The blade's place (own frame) serving the ball that's waited at `ball` for `holding` seconds:
 * beside it, drawn back behind it, then swung forward through it and on.
 */
export function autoplayServe(holding: number, ball: V3): V3 {
  const { serveWait, serveBack, serveWind, serveThrough, swingS } = AUTOPLAY;
  const t = holding % (serveWait + serveWind + swingS + 0.4);
  const back = v3(ball.x, ball.y - 0.03, ball.z + serveBack);
  if (t < serveWait) return back;
  const u = clamp((t - serveWait - serveWind) / swingS, 0, 1);
  return v3(ball.x, ball.y - 0.03 * (1 - u), ball.z + serveBack - (serveBack + serveThrough) * u);
}

/** Whether it has its free hand up, having held the ball to serve for `holding` seconds (null: it isn't serving). */
export function autoplayRaised(holding: number | null): boolean {
  if (holding === null) return false;
  const t = (holding - AUTOPLAY.serveAfter) % (AUTOPLAY.serveAfter + AUTOPLAY.raiseFor);
  return holding >= AUTOPLAY.serveAfter && t >= 0 && t < AUTOPLAY.raiseFor;
}
