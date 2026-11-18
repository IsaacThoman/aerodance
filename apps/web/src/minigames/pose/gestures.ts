import { JOINT } from './body.ts';
import type { BodyPoint, JointName, PlayerPose, ScreenPoint, Side } from './body.ts';

/*
 * What minigames ask of a pose (body.ts): measures that read one frame, and detectors that
 * watch a player's poses arrive and say when something happened (a jump, a clap, a swipe).
 * Everything is in body space (torso lengths, x to the player's right, y up, z towards the
 * camera), so the same thresholds suit a child near the camera and an adult at the back.
 *
 * The host (MinigameSession) runs one of each detector per player with the defaults below and
 * hands their events to the game each frame (useMinigameFrame's events); a game that wants other
 * thresholds makes its own and feeds them from useMinigameFrame's `players` (only when a new pose
 * arrived: pose.samples changes).
 *
 * Tracking runs at 20-30 poses a second with a tenth of a second or two of delay, so a gesture is
 * seen after it has happened: detectors fire as soon as the movement is clear (a swipe once the
 * hand has travelled far enough, not when it stops), and games should accept a little slack.
 */

/** How far the arm reaches from the shoulder (upper arm and forearm), in torso lengths. */
export const ARM_LENGTH = 0.97;
const SURE = 0.5;

const wrist = (side: Side) => (side === 'left' ? JOINT.leftWrist : JOINT.rightWrist);
const shoulder = (side: Side) => (side === 'left' ? JOINT.leftShoulder : JOINT.rightShoulder);
const elbow = (side: Side) => (side === 'left' ? JOINT.leftElbow : JOINT.rightElbow);
const sub = (a: BodyPoint, b: BodyPoint): BodyPoint => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: BodyPoint) => Math.hypot(a.x, a.y, a.z);
const deg = (rad: number) => (rad * 180) / Math.PI;

/** A joint in body space. */
export const bodyAt = (p: PlayerPose, joint: JointName) => p.body[JOINT[joint]];
/** A joint on the mirrored camera picture (0-1). */
export const screenAt = (p: PlayerPose, joint: JointName): ScreenPoint => p.screen[JOINT[joint]];
/** A joint's velocity in body space per second. */
export const velocityAt = (p: PlayerPose, joint: JointName) => p.velocity[JOINT[joint]];
/** The model is sure of a joint, and it's inside the picture. */
export function sureOf(p: PlayerPose, joint: JointName) {
  const i = JOINT[joint], s = p.screen[i];
  return p.present && p.jointConfidence[i] >= SURE && s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1;
}

/** A hand (its wrist) in body space. */
export const handAt = (p: PlayerPose, side: Side) => p.body[wrist(side)];
/** A hand's velocity, body space per second. */
export const handVelocity = (p: PlayerPose, side: Side) => p.velocity[wrist(side)];
/** How fast a hand moves, torso lengths per second (across the picture, as z is the model's least sure). */
export const handSpeed = (p: PlayerPose, side: Side) => Math.hypot(handVelocity(p, side).x, handVelocity(p, side).y);

/**
 * An arm's angle seen from the front, in degrees: 0 hanging down, 90 straight out to its side,
 * 180 straight up; negative across the body.
 */
export function armAngle(p: PlayerPose, side: Side) {
  const d = sub(p.body[wrist(side)], p.body[shoulder(side)]);
  return deg(Math.atan2(side === 'right' ? d.x : -d.x, -d.y));
}
/** How bent an elbow is, in degrees: 0 straight, towards 180 folded. */
export function elbowBend(p: PlayerPose, side: Side) {
  const upper = sub(p.body[elbow(side)], p.body[shoulder(side)]), fore = sub(p.body[wrist(side)], p.body[elbow(side)]);
  const cos = (upper.x * fore.x + upper.y * fore.y + upper.z * fore.z) / Math.max(1e-6, len(upper) * len(fore));
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}
/** How far a hand is from its shoulder, as a share of the arm's length (about 1 stretched out). */
export const armReach = (p: PlayerPose, side: Side) => len(sub(p.body[wrist(side)], p.body[shoulder(side)])) / ARM_LENGTH;

/** How far the torso tilts sideways, in degrees: towards the player's right is positive. */
export function lean(p: PlayerPose) {
  const s = p.body[JOINT.leftShoulder], r = p.body[JOINT.rightShoulder];
  return deg(Math.atan2((s.x + r.x) / 2, (s.y + r.y) / 2));
}
/** How deep a crouch is: 0 standing (or higher) to 1 with the hips dropped 0.6 torso lengths. */
export const crouchDepth = (p: PlayerPose) => Math.max(0, Math.min(1, -p.offset.y / 0.6));
/** How high the hips are above where the player stood, in torso lengths (0 on the ground). */
export const jumpHeight = (p: PlayerPose) => Math.max(0, p.offset.y);
/** A hand is above the head (its wrist over the nose). */
export const handRaised = (p: PlayerPose, side: Side) => p.present && p.jointConfidence[wrist(side)] >= SURE && p.body[wrist(side)].y > p.body[JOINT.nose].y;
/** Both hands are above the head. */
export const handsRaised = (p: PlayerPose) => handRaised(p, 'left') && handRaised(p, 'right');
/** How far apart the hands are across the picture, in torso lengths. */
export function handsApart(p: PlayerPose) {
  const l = p.body[JOINT.leftWrist], r = p.body[JOINT.rightWrist];
  return Math.hypot(l.x - r.x, l.y - r.y);
}

// ---------- Detectors ----------

export type GestureType = 'jump' | 'land' | 'crouch' | 'rise' | 'clap' | 'swipe' | 'punch' | 'raise';
export type Direction = 'left' | 'right' | 'up' | 'down';
/** Something a player did, when (the camera frame's capture time, performance.now()) and how hard. */
export interface GestureEvent {
  type: GestureType;
  player: number;
  at: number;
  /** Swipes, punches and raises: which hand. */
  hand?: Side;
  /** Swipes: which way on the screen; punches: 'forward' at the camera, else the way it went. */
  direction?: Direction | 'forward';
  /** How hard: a jump's or move's speed (torso lengths per second), a landing's height. */
  strength: number;
}
export interface GestureDetector {
  /** Feeds the player's pose (call when a new one has arrived); returns what happened. */
  update(pose: PlayerPose): GestureEvent[];
  reset(): void;
}
const event = (type: GestureType, p: PlayerPose, strength: number, extra: Partial<GestureEvent> = {}): GestureEvent => ({ type, player: p.id, at: p.capturedAt, strength, ...extra });

/** Jump (the hips rising fast above where the player stands) and land (back down), with hysteresis. */
export function createJumpDetector({ height = 0.18, speed = 1.0 } = {}): GestureDetector {
  let airborne = false, peak = 0;
  return {
    update(p) {
      if (!p.present) { airborne = false; return []; }
      if (!airborne && p.offset.y > height && p.offsetVelocity.y > speed) { airborne = true; peak = p.offset.y; return [event('jump', p, p.offsetVelocity.y)]; }
      if (airborne) {
        peak = Math.max(peak, p.offset.y);
        if (p.offset.y < height * 0.5) { airborne = false; return [event('land', p, peak)]; }
      }
      return [];
    },
    reset() { airborne = false; },
  };
}

/** Crouch (the hips dropping `depth` torso lengths) and rise (back up past half that). */
export function createCrouchDetector({ depth = 0.3 } = {}): GestureDetector {
  let down = false;
  return {
    update(p) {
      if (!p.present) { down = false; return []; }
      if (!down && p.offset.y < -depth) { down = true; return [event('crouch', p, -p.offset.y)]; }
      if (down && p.offset.y > -depth * 0.5) { down = false; return [event('rise', p, -p.offset.y)]; }
      return [];
    },
    reset() { down = false; },
  };
}

/** Clap: the hands meeting after coming together fast; it waits for them to part again. */
export function createClapDetector({ distance = 0.3, speed = 1.2 } = {}): GestureDetector {
  let ready = false, last: { apart: number; at: number } | null = null, closing = 0;
  return {
    update(p) {
      if (!p.present) { last = null; return []; }
      if (p.jointConfidence[JOINT.leftWrist] < SURE || p.jointConfidence[JOINT.rightWrist] < SURE) return [];
      const apart = handsApart(p);
      if (last && p.capturedAt > last.at) {
        const rate = (last.apart - apart) / ((p.capturedAt - last.at) / 1000);
        closing = Math.max(rate, closing * 0.6);
      }
      last = { apart, at: p.capturedAt };
      if (apart > distance * 2) ready = true;
      if (ready && apart < distance && closing > speed) { ready = false; return [event('clap', p, closing)]; }
      return [];
    },
    reset() { ready = false; last = null; closing = 0; },
  };
}

/**
 * Swipe: a hand moving fast mostly one way across the picture, fired once it has gone `distance`
 * (torso lengths) in this stroke. Each hand swipes on its own, then waits `cooldownMs`.
 */
export function createSwipeDetector({ speed = 3.6, distance = 0.8, cooldownMs = 300 } = {}): GestureDetector {
  type Hand = { start: (BodyPoint & { at: number }) | null; until: number };
  const hands: Record<Side, Hand> = { left: { start: null, until: -Infinity }, right: { start: null, until: -Infinity } };
  return {
    update(p) {
      if (!p.present) { hands.left.start = hands.right.start = null; return []; }
      const out: GestureEvent[] = [];
      for (const side of ['left', 'right'] as const) {
        const h = hands[side], at = handAt(p, side), v = handVelocity(p, side), fast = Math.hypot(v.x, v.y);
        if (p.jointConfidence[wrist(side)] < SURE) continue;
        if (p.capturedAt < h.until || fast < speed * 0.5) { h.start = null; continue; }
        if (!h.start) { if (fast >= speed) h.start = { ...at, at: p.capturedAt }; continue; }
        const dx = at.x - h.start.x, dy = at.y - h.start.y, gone = Math.hypot(dx, dy);
        if (gone < distance) continue;
        // Quick all the way (a hand drifting back down isn't a swipe), and mostly one way (or it's a wave about).
        const quick = gone / Math.max(0.001, (p.capturedAt - h.start.at) / 1000) >= speed * 0.75;
        const straight = Math.max(Math.abs(dx), Math.abs(dy)) >= 1.4 * Math.min(Math.abs(dx), Math.abs(dy));
        if (!quick || !straight) { h.start = null; continue; }
        const direction: Direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'up' : 'down';
        out.push(event('swipe', p, fast, { hand: side, direction }));
        h.start = null;
        h.until = p.capturedAt + cooldownMs;
      }
      return out;
    },
    reset() { hands.left.start = hands.right.start = null; hands.left.until = hands.right.until = -Infinity; },
  };
}

/**
 * Punch: a bent arm straightening fast, the hand going out along it (not sweeping round), above
 * the waist: its reach grows at least `gain` torso lengths within PUNCH_MS, at `speed` torso
 * lengths a second on average, out to `reach` of the arm's length. Only at the camera ('forward')
 * unless forwardOnly is false, when it says which way across the picture it went: an arm thrown
 * out to the side, or up, straightens fast too (a swipe's or a jump's).
 */
const PUNCH_MS = 350;
export function createPunchDetector({ speed = 1.5, reach = 0.8, gain = 0.3, cooldownMs = 300, forwardOnly = true } = {}): GestureDetector {
  type Sample = BodyPoint & { reach: number; at: number };
  type Hand = { recent: Sample[]; until: number };
  const hands: Record<Side, Hand> = { left: { recent: [], until: -Infinity }, right: { recent: [], until: -Infinity } };
  return {
    update(p) {
      const out: GestureEvent[] = [];
      for (const side of ['left', 'right'] as const) {
        const h = hands[side];
        // (A pose the model was unsure of the hand in is skipped, not a fresh start: it flickers.)
        if (!p.present) { h.recent = []; continue; }
        if (p.jointConfidence[wrist(side)] < SURE) continue;
        const now = armReach(p, side) * ARM_LENGTH, at = handAt(p, side);
        h.recent = h.recent.filter((r) => p.capturedAt - r.at <= PUNCH_MS);
        h.recent.push({ ...at, reach: now, at: p.capturedAt });
        if (p.capturedAt < h.until || now < reach * ARM_LENGTH || at.y < 0.5) continue;
        // Grown by gain since a recent pose, fast enough (poses are smoothed, so over a few of them).
        let from: Sample | null = null, rate = 0;
        for (const r of h.recent) {
          const k = r.at < p.capturedAt && now - r.reach >= gain ? (now - r.reach) / ((p.capturedAt - r.at) / 1000) : 0;
          if (k > rate) { rate = k; from = r; }
        }
        if (!from || rate < speed) continue;
        // Out along the arm (not sweeping round in front of the body, which straightens it too).
        const d = sub(at, from), arm = sub(at, p.body[shoulder(side)]);
        const along = (d.x * arm.x + d.y * arm.y + d.z * arm.z) / Math.max(1e-6, len(d) * len(arm));
        if (along < 0.6) continue;
        const direction = d.z > Math.hypot(d.x, d.y) ? 'forward' : Math.abs(d.x) > Math.abs(d.y) ? (d.x > 0 ? 'right' : 'left') : d.y > 0 ? 'up' : 'down';
        if (forwardOnly && direction !== 'forward') continue;
        out.push(event('punch', p, rate, { hand: side, direction }));
        h.until = p.capturedAt + cooldownMs;
        h.recent = [];
      }
      return out;
    },
    reset() { for (const h of [hands.left, hands.right]) { h.recent = []; h.until = -Infinity; } },
  };
}

/** Raise: a hand held above the head for `holdMs` (once per raise). */
export function createRaiseDetector({ holdMs = 500 } = {}): GestureDetector {
  const since: Record<Side, number | null> = { left: null, right: null }, fired: Record<Side, boolean> = { left: false, right: false };
  return {
    update(p) {
      const out: GestureEvent[] = [];
      for (const side of ['left', 'right'] as const) {
        if (!handRaised(p, side)) { since[side] = null; fired[side] = false; continue; }
        since[side] ??= p.capturedAt;
        if (!fired[side] && p.capturedAt - since[side] >= holdMs) { fired[side] = true; out.push(event('raise', p, 0, { hand: side })); }
      }
      return out;
    },
    reset() { since.left = since.right = null; fired.left = fired.right = false; },
  };
}

/** One of each detector with its defaults, as the host runs them for every player. */
export function createGestureSet(): GestureDetector {
  const all = [createJumpDetector(), createCrouchDetector(), createClapDetector(), createSwipeDetector(), createPunchDetector(), createRaiseDetector()];
  return {
    update: (p) => all.flatMap((d) => d.update(p)),
    reset: () => { for (const d of all) d.reset(); },
  };
}
