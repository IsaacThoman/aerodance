/*
 * The /?hands demo's opponent: a floating paddle at the far end, in ball.ts's table frame. It
 * watches the player's return, and if it bounces fairly on the far half it goes to where the ball
 * will reach it (as it crosses the bot's line behind the table, or before it drops too low) and
 * sends it back onto the near half, somewhere a little different each time. Its shots are as hard
 * as its level (BOT_LEVELS: faster, and spread wider); set to return everything, it also plays the
 * player's misses (long, wide, or off their own half), meeting them before they're gone.
 */

import { ROOM, TABLE, aimServe, aimShot, stepBall, v3 } from './ball.ts';
import type { Ball, V3 } from './ball.ts';

export const BOT = {
  /** Where it waits, its paddle's middle. */
  home: v3(-0.45, TABLE.top + 0.3, -TABLE.halfLength - 0.35),
  /** It meets the ball as it crosses this line (z), behind the far end... */
  line: -TABLE.halfLength - 0.15,
  /** ...or earlier, if it would drop this low over the table first. */
  low: TABLE.top + 0.14,
  /** How far it can reach: out to the side, and up. */
  reach: { x: TABLE.halfWidth + 0.5, y: TABLE.top + 1.4 },
  /** Returning everything, how far it reaches (out to the room's walls, and up). */
  always: { x: ROOM.halfWidth - 0.2, y: ROOM.height - 0.2 },
  /** How fast it moves (m/s, the ball's world's); returning everything, as fast as it needs to. */
  speed: 3.5,
} as const;

export type BotLevel = 'easy' | 'medium' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];
/**
 * Each level's shots: their flight to their bounce (s; shorter is faster, and lower; much longer
 * and they're lobs), and where on the near half they're aimed: x within `spread` either side of
 * `x` (easy ones to the player's forehand, where the paddle is), z from the net.
 */
export const BOT_SHOTS: Record<BotLevel, { flight: number; aim: { x: number; spread: number; near: number; far: number } }> = {
  easy: { flight: 0.68, aim: { x: 0.2, spread: 0.12, near: 0.7, far: 0.95 } },
  medium: { flight: 0.6, aim: { x: 0, spread: 0.45, near: 0.45, far: 1.0 } },
  hard: { flight: 0.46, aim: { x: 0, spread: 0.62, near: 0.3, far: 1.18 } },
};

const STEP = 1 / 240;

/** Whether a point is over the table's far half (a ball dropping there will bounce on it). */
const overFar = (p: V3) => Math.abs(p.x) <= TABLE.halfWidth && p.z <= 0 && p.z >= -TABLE.halfLength;

/**
 * Where and when (in seconds from now) the bot meets a ball flying at it, or null if it won't: the
 * ball must be coming its way and bounce once on the far half first (`bounced`: it already has),
 * and be within its reach. Returning everything (`always`), it takes the player's misses too: one
 * going long or wide it meets as it crosses its line or drops low beside the table, and one off the
 * player's own half it lets come on; only one in the net, or gone the player's way, it can't.
 */
export function planReturn(ball: Ball, bounced = false, always = false): { t: number; at: V3 } | null {
  if (ball.vel.z >= 0) return null;
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: 0 };
  const reach = always ? BOT.always : BOT.reach;
  // Where it meets it: past its line, or dropping low (once bounced, or, for a miss, beside the table).
  const meets = () => b.pos.z <= BOT.line || (b.vel.y < 0 && b.pos.y < BOT.low && (bounced || (always && !overFar(b.pos) && b.pos.z < 0)));
  const plan = (t: number) => (Math.abs(b.pos.x) <= reach.x && b.pos.y <= reach.y ? { t, at: { ...b.pos } } : null);
  if ((bounced || always) && meets()) return plan(0);
  for (let t = STEP; t < 2.5; t += STEP) {
    for (const e of stepBall(b, STEP, null, null)) {
      // Its one fair bounce; anything else (the net, the near half, a second bounce, the floor) is the
      // player's miss, which it leaves, unless it returns everything and it can still get there.
      if (e.type === 'table' && e.side === 'far' && !bounced) bounced = true;
      else if (!always || e.type === 'net' || e.type === 'floor' || (e.type === 'table' && e.side === 'far')) return null;
    }
    if (b.vel.z >= 0) return null;
    if ((bounced || always) && meets()) return plan(t);
  }
  return null;
}

/** The bot's shot from where it meets the ball, as hard as its level: onto the near half, at a spot rand picks. */
export function botShot(from: V3, level: BotLevel = 'medium', rand: () => number = Math.random): V3 {
  const { flight, aim } = BOT_SHOTS[level];
  const target = v3(aim.x + (rand() * 2 - 1) * aim.spread, 0, aim.near + rand() * (aim.far - aim.near));
  // Slower if it must be to clear the net; from out wide, across the table if it can't go down the line.
  for (const x of [target.x, -target.x, 0]) {
    for (const f of [flight, flight * 1.2, flight * 1.45, flight * 1.75]) {
      const vel = aimShot(from, v3(x, 0, target.z), f);
      if (vel) return vel;
    }
  }
  return aimServe(from, v3(0, 0, target.z), flight * 1.75);
}
