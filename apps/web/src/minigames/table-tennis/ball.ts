/*
 * Table Tennis's ball, in metres and seconds, in the table's frame: x to the right as the
 * player looks down the table, y up from the floor, z towards the player, the net at z = 0. A
 * 40 mm ball under gravity and air drag bounces off the table, catches in the net, and bounces off
 * the room and the paddle: a real disc with a face and a speed, met along its path through each
 * frame so a fast swing can't pass through. aimServe aims a ball onto the table, as a launcher would.
 * Constants from the Table Tennis minigame; no spin.
 */

export interface V3 { x: number; y: number; z: number; }
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const add = (a: V3, b: V3, k = 1): V3 => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
const scale = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const lerp = (a: V3, b: V3, t: number): V3 => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

export const TABLE = { halfLength: 1.37, halfWidth: 0.7625, top: 0.76 } as const;
export const NET = { height: 0.1525, halfWidth: 0.915 } as const;
const NET_TOP = TABLE.top + NET.height;
/** The room round the table, in the table's frame: deep enough behind the far end for the robot opponent. */
export const ROOM = { halfWidth: 3, height: 3, near: 4.2, far: -5 } as const;
export const BALL_R = 0.02;
const GRAVITY = 9.81;
const DRAG = 0.13;
const TABLE_BOUNCE = 0.88, TABLE_SLIDE = 0.95;
const PADDLE_BOUNCE = 0.75, PADDLE_GRIP = 0.35;
/** The paddle can't hit the ball again this soon (it would catch it on the way out). */
export const PADDLE_COOLDOWN = 0.08;
const STEP = 1 / 480;

/** The paddle's blade at an instant: its centre, its face's normal, its radius and half its thickness (with any forgiveness). */
export interface PaddlePose { center: V3; normal: V3; radius: number; halfThickness: number; }
export interface Ball { pos: V3; vel: V3; /** Seconds until the paddle can hit it again. */ cooldown: number; }
export type BallEvent =
  | { type: 'paddle'; at: V3; speed: number }
  | { type: 'table'; side: 'near' | 'far'; at: V3; speed: number }
  | { type: 'net'; at: V3; speed: number }
  | { type: 'floor'; at: V3; speed: number };

const overTable = (p: V3) => Math.abs(p.x) <= TABLE.halfWidth && Math.abs(p.z) <= TABLE.halfLength;
/** The side of the net a point is on: near is the player's. */
export const sideOf = (z: number): 'near' | 'far' => (z >= 0 ? 'near' : 'far');

/** The paddle a share t (0-1) of the way through the frame. */
function paddleAt(from: PaddlePose, to: PaddlePose, t: number): PaddlePose {
  return { center: lerp(from.center, to.center, t), normal: norm(lerp(from.normal, to.normal, t)), radius: to.radius, halfThickness: to.halfThickness };
}

/** The paddle meeting the ball between two of its poses (moving at vel), if it does. */
function hitPaddle(b: Ball, before: V3, was: PaddlePose, now: PaddlePose, vel: V3, events: BallEvent[], onHit?: (b: Ball) => void) {
  if (b.cooldown > 0) return;
  const dWas = dot(sub(before, was.center), was.normal);
  const dNow = dot(sub(b.pos, now.center), now.normal);
  const reach = BALL_R + now.halfThickness;
  const crossed = Math.sign(dWas) !== Math.sign(dNow);
  if (!crossed && Math.abs(dNow) > reach) return;
  // Within the blade's round (measured in its plane).
  const off = sub(b.pos, now.center);
  const inPlane = sub(off, scale(now.normal, dNow));
  if (len(inPlane) > now.radius + BALL_R * 0.5) return;
  // The side the ball came from, and it must be closing on the face from there.
  const side = Math.sign(dWas) || Math.sign(dNow) || 1;
  const rel = sub(b.vel, vel);
  if (dot(rel, now.normal) * side >= 0) return;
  bounceOff(b, now.normal, vel);
  b.pos = add(add(now.center, inPlane), now.normal, side * reach);
  b.cooldown = PADDLE_COOLDOWN;
  onHit?.(b);
  events.push({ type: 'paddle', at: { ...b.pos }, speed: len(b.vel) });
}

/** The ball off a paddle face (its normal) moving at vel: lively along the normal, gripping across it. */
export function bounceOff(b: Ball, normal: V3, vel: V3) {
  const rel = sub(b.vel, vel);
  const across = scale(normal, dot(rel, normal));
  b.vel = add(add(scale(across, -PADDLE_BOUNCE), sub(rel, across), 1 - PADDLE_GRIP), vel);
}

/** One small step of flight and what the ball hit in it. */
function tick(b: Ball, dt: number, was: PaddlePose | null, now: PaddlePose | null, paddleVel: V3, events: BallEvent[], onHit?: (b: Ball) => void) {
  b.cooldown = Math.max(0, b.cooldown - dt);
  const speed = len(b.vel);
  b.vel.x -= DRAG * speed * b.vel.x * dt;
  b.vel.y -= (GRAVITY + DRAG * speed * b.vel.y) * dt;
  b.vel.z -= DRAG * speed * b.vel.z * dt;
  const before = { ...b.pos };
  b.pos = add(b.pos, b.vel, dt);
  if (was && now) hitPaddle(b, before, was, now, paddleVel, events, onHit);
  // The net: a thin wall across the middle, up to its top. The ball loses most of its speed in it.
  if (Math.sign(before.z) !== Math.sign(b.pos.z) && Math.abs(b.pos.x) <= NET.halfWidth && b.pos.y - BALL_R * 0.5 < NET_TOP && b.pos.y > TABLE.top) {
    const hit = len(b.vel);
    b.pos.z = Math.sign(before.z || 1) * BALL_R;
    b.vel = v3(b.vel.x * 0.4, b.vel.y * 0.4, -b.vel.z * 0.12);
    events.push({ type: 'net', at: { ...b.pos }, speed: hit });
  }
  // The table's top, coming down onto it.
  if (b.vel.y < 0 && b.pos.y - BALL_R <= TABLE.top && before.y - BALL_R >= TABLE.top - 0.02 && overTable(b.pos)) {
    const hit = -b.vel.y;
    b.pos.y = TABLE.top + BALL_R;
    b.vel = v3(b.vel.x * TABLE_SLIDE, hit * TABLE_BOUNCE, b.vel.z * TABLE_SLIDE);
    events.push({ type: 'table', side: sideOf(b.pos.z), at: { ...b.pos }, speed: hit });
  }
  // The floor: a dead ball, bouncing lower and lower until it rolls.
  if (b.vel.y < 0 && b.pos.y - BALL_R <= 0) {
    const hit = -b.vel.y;
    b.pos.y = BALL_R;
    const rolling = hit < 0.4;
    b.vel = v3(b.vel.x * (rolling ? 0.98 : 0.7), rolling ? 0 : hit * 0.55, b.vel.z * (rolling ? 0.98 : 0.7));
    if (!rolling) events.push({ type: 'floor', at: { ...b.pos }, speed: hit });
  }
  // The room's walls and ceiling keep it in.
  if (Math.abs(b.pos.x) > ROOM.halfWidth - BALL_R) { b.pos.x = Math.sign(b.pos.x) * (ROOM.halfWidth - BALL_R); b.vel.x *= -0.6; }
  if (b.pos.z > ROOM.near - BALL_R) { b.pos.z = ROOM.near - BALL_R; b.vel.z *= -0.6; }
  if (b.pos.z < ROOM.far + BALL_R) { b.pos.z = ROOM.far + BALL_R; b.vel.z *= -0.6; }
  if (b.pos.y > ROOM.height - BALL_R) { b.pos.y = ROOM.height - BALL_R; b.vel.y *= -0.6; }
}

export interface StepOptions {
  /** The paddle hits as if moving at this (by default, its move over dt): in slow motion the player's swing is still at their own speed. */
  paddleVel?: V3;
  /** Called the moment the paddle hits the ball, to change its velocity off it (aim assist). */
  onHit?: (b: Ball) => void;
}

/**
 * Moves the ball on by dt seconds (in small steps), with the paddle moving from `from` to `to`
 * over them (null: no paddle), and says what it hit.
 */
export function stepBall(b: Ball, dt: number, from: PaddlePose | null, to: PaddlePose | null, events: BallEvent[] = [], { paddleVel, onHit }: StepOptions = {}): BallEvent[] {
  const n = Math.max(1, Math.ceil(dt / STEP));
  paddleVel ??= from && to && dt > 0 ? scale(sub(to.center, from.center), 1 / dt) : v3();
  let was = from && to ? paddleAt(from, to, 0) : null;
  for (let i = 1; i <= n; i++) {
    const now = from && to ? paddleAt(from, to, i / n) : null;
    tick(b, dt / n, was, now, paddleVel, events, onHit);
    was = now;
  }
  return events;
}

/** Where a ball flying from `ball` first comes down on the table (null: it doesn't, within 3 s). */
export function firstBounce(ball: Ball): { at: V3; t: number } | null {
  const b: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, cooldown: 0 };
  const events: BallEvent[] = [];
  for (let t = 0; t < 3; t += STEP) {
    tick(b, STEP, null, null, v3(), events);
    if (events.length) return events[0].type === 'table' ? { at: events[0].at, t } : null;
  }
  return null;
}

/** The velocity that, without air, comes down at `aim` on the table after `flight` seconds. */
const ballistic = (from: V3, aim: V3, flight: number): V3 =>
  v3((aim.x - from.x) / flight, (TABLE.top + BALL_R - from.y + 0.5 * GRAVITY * flight * flight) / flight, (aim.z - from.z) / flight);

/**
 * A launcher's serve from `from` that first bounces at `target` on the table, after about
 * `flight` seconds: aimed as if without air, then corrected against the real flight (with drag)
 * a few times.
 */
export function aimServe(from: V3, target: V3, flight: number): V3 {
  let aim = { ...target };
  let vel = v3();
  for (let i = 0; i < 6; i++) {
    vel = ballistic(from, aim, flight);
    const landed = firstBounce({ pos: { ...from }, vel, cooldown: 0 });
    if (!landed) { aim = add(aim, v3(0, 0, 0.1)); continue; }
    // Short by this much: aim that much further.
    aim = add(aim, v3(target.x - landed.at.x, 0, target.z - landed.at.z));
    if (Math.hypot(target.x - landed.at.x, target.z - landed.at.z) < 0.01) break;
  }
  return vel;
}

/**
 * A shot from `from` that first bounces at `target` after about `flight` seconds, as aimServe
 * aims, or null if no such shot does (it would catch in the net, or come down somewhere else).
 */
export function aimShot(from: V3, target: V3, flight: number): V3 | null {
  let aim = { ...target };
  for (let i = 0; i < 8; i++) {
    const vel = ballistic(from, aim, flight);
    const landed = firstBounce({ pos: { ...from }, vel, cooldown: 0 });
    if (!landed) return null;
    const miss = v3(target.x - landed.at.x, 0, target.z - landed.at.z);
    if (Math.hypot(miss.x, miss.z) < 0.02) return vel;
    aim = add(aim, miss);
  }
  return null;
}
