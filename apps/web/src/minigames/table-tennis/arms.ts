
/*
 * A tracked player's hands as first-person hands, through the camera's perspective.
 *
 * Depth is the hard part: the pose model's own depth guesses are its weakest output, and with the
 * arms crossed or the body turned it can't tell which hand is nearer the camera (and a hand's
 * size in the picture, at the 50-odd pixels a webcam gives it, is too noisy to say either). What
 * holds up is the arm's bones: an upper arm or forearm always has its length, so one that looks
 * short in the picture is pointing towards or away from the camera.
 *
 * So the torso's size in the picture (its real size from the model's world landmarks, turned as
 * it's turned) puts the shoulders in the room: depth = focal length × metres ÷ pixels. Down the
 * arm, each bone's far end is as much nearer the camera (forward, for the player facing it) or
 * further than its near end as its length allows after what the picture shows of it; it sits on
 * its own ray through the picture at that depth. Which way is the model's call: the forearm is
 * taken as forward unless the model is sure it points back; the upper arm (its elbow behind the
 * shoulder in a backswing or a serve, where the model says so only faintly) as far forward or
 * back as the model leans, and flat when it can't say. The Hand Landmarker gives the wrist's
 * place in the picture more exactly than the pose, and the hand's angles.
 *
 * Camera space: x towards the picture's right, y down, z away from the camera, in metres. The
 * player faces the camera, so their own frame is that turned half round: x right, y up, z back
 * (forward is −z).
 */

export interface Vec3 { x: number; y: number; z: number; }
export interface HandPose {
  /** The wrist from its shoulder, in metres in the player's frame. */
  wrist: Vec3;
  /** Unit: from the wrist towards the middle knuckle. */
  dir: Vec3;
  /** Unit, square to dir: across the knuckles, pinky towards index. */
  across: Vec3;
  /** Where the hand came from: the Hand Landmarker, or only the pose. */
  from: 'hand' | 'pose';
}
export type Side = 'left' | 'right';
/** A landmark in the picture (0-1, unmirrored) and how sure the model is it can see it. */
export interface PicturePoint { x: number; y: number; z?: number; visibility?: number; }
/** A landmark in metres: the pose model's world landmarks (from the hips' centre, y down), or a hand's (round its centre). */
export interface WorldPoint { x: number; y: number; z: number; }
/** A hand the Hand Landmarker found: its 21 points in the picture and in metres. */
export interface HandInput { landmarks: readonly PicturePoint[]; world: readonly WorldPoint[]; }
export interface FrameSize { width: number; height: number; }

// MediaPipe pose-33 and hand-21 indices.
const POSE = { left: { shoulder: 11, wrist: 15, index: 19, pinky: 17 }, right: { shoulder: 12, wrist: 16, index: 20, pinky: 18 } } as const;
const HAND = { wrist: 0, index: 5, middle: 9, pinky: 17 } as const;
/** The torso's sides, measured for its depth: shoulders, flanks and hips. */
const TORSO: readonly (readonly [number, number])[] = [[11, 12], [11, 23], [12, 24], [23, 24]];
const SEEN = 0.4;
/** How far a wrist can be from its shoulder (an arm, with a little to spare). */
export const ARM = 0.68;
/**
 * The arm's bones as shares of the torso (shoulders' middle to hips' middle). The pose model's
 * own bone lengths can't be used: its world landmarks are little more than the picture with
 * flattened depths, so a forearm pointing at the camera measures short there too.
 */
const UPPER_ARM = 0.62, FOREARM = 0.5;
/** The torso's length (metres, as the model's world landmarks measure it) when its hips aren't seen, and the range it's believed in. */
const TORSO_LENGTH = { usual: 0.5, min: 0.4, max: 0.6 };
/** The pose model has to think a forearm points back by this much (metres) to be believed. */
export const SURELY_BACK = 0.12;
/**
 * How far forward (1) or back (−1) an upper arm is taken to point, from the depth the pose model
 * gives it (its elbow's from its shoulder, metres; + is away from the camera): −tanh((dz − at) ÷
 * width). The model's depths are squashed (an elbow 15 cm behind the shoulder reads a few cm),
 * but their sign is right nineteen times in twenty on the ping-pong scenes; where it's unsure the
 * bone is taken as lying flat, between its two readings, rather than flipping from one to the other.
 */
export const UPPER_ARM_LEAN = { at: 0, width: 0.16 };
export const upperArmForward = (dz: number) => -Math.tanh((dz - UPPER_ARM_LEAN.at) / UPPER_ARM_LEAN.width);
/** The webcam's horizontal field of view when nothing says otherwise (laptop cameras are about 60-75°). */
export const DEFAULT_FOV = 65;

const view = (p: Vec3): Vec3 => ({ x: -p.x, y: -p.y, z: p.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const unit = (a: Vec3): Vec3 | null => { const l = Math.hypot(a.x, a.y, a.z); return l > 1e-6 ? scale(a, 1 / l) : null; };
const mid = (a: Vec3, b: Vec3): Vec3 => scale({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }, 0.5);

/** The camera's focal length in pixels, for a picture this wide and a horizontal field of view in degrees. */
export const focalLength = (width: number, fov = DEFAULT_FOV) => width / (2 * Math.tan((fov * Math.PI) / 360));

/** The ray through a picture point, as the camera-space point on it at depth 1. */
const ray = (p: PicturePoint, size: FrameSize, f: number): Vec3 => ({ x: ((p.x - 0.5) * size.width) / f, y: ((p.y - 0.5) * size.height) / f, z: 1 });

/**
 * How far from the camera a set of rigid sides is: their real length across the picture (the
 * world landmarks' x and y, turned as the part is turned) over their length in pixels, times the
 * focal length. Null when too little of it is seen.
 */
export function depthOf(world: readonly WorldPoint[], image: readonly PicturePoint[], sides: readonly (readonly [number, number])[], size: FrameSize, f: number, seen: (i: number) => boolean = () => true): number | null {
  let metres = 0, pixels = 0;
  for (const [a, b] of sides) {
    if (!seen(a) || !seen(b)) continue;
    metres += Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y);
    pixels += Math.hypot((image[a].x - image[b].x) * size.width, (image[a].y - image[b].y) * size.height);
  }
  return pixels > 12 && metres > 0.02 ? (f * metres) / pixels : null;
}

/**
 * The depth of a bone's far end, from its near end's (`from`, camera space) and where the far end
 * is in the picture (`rayAt1`, its ray's point at depth 1): what's left of the bone's length after
 * the length the picture shows (measured at the near end's depth) points towards the camera
 * (forward), or away if `back`; or, given a number from 1 (forward) to −1 (back), that share of
 * it. (Measured that way, not where the ray meets a sphere of the bone's length: in perspective,
 * a bone lying flat across the picture meets it twice, once nearer.)
 */
export function boneEnd(rayAt1: Vec3, from: Vec3, length: number, back: boolean | number = false): number {
  const flat = Math.hypot(rayAt1.x * from.z - from.x, rayAt1.y * from.z - from.y);
  const along = Math.sqrt(Math.max(0, length * length - flat * flat));
  const forward = typeof back === 'number' ? back : back ? -1 : 1;
  return from.z - forward * along;
}

/**
 * The depth along a wrist's ray nearest `measured` that keeps it within an arm's reach of the
 * shoulder (a safety net for a misread elbow).
 */
export function reachable(rayAt1: Vec3, measured: number, shoulder: Vec3, arm = ARM): number {
  const a = dot(rayAt1, rayAt1), b = dot(rayAt1, shoulder), c = dot(shoulder, shoulder) - arm * arm;
  const disc = b * b - a * c;
  if (disc < 0) return b / a;
  const near = (b - Math.sqrt(disc)) / a, far = (b + Math.sqrt(disc)) / a;
  return Math.min(far, Math.max(near, measured));
}

/** The torso's length, from shoulders' middle to hips' middle, in the model's metres. */
function torsoLength(world: readonly WorldPoint[], seen: (i: number) => boolean) {
  if (![11, 12, 23, 24].every(seen)) return TORSO_LENGTH.usual;
  const sx = (world[11].x + world[12].x) / 2, sy = (world[11].y + world[12].y) / 2, sz = (world[11].z + world[12].z) / 2;
  const hx = (world[23].x + world[24].x) / 2, hy = (world[23].y + world[24].y) / 2, hz = (world[23].z + world[24].z) / 2;
  return Math.min(TORSO_LENGTH.max, Math.max(TORSO_LENGTH.min, Math.hypot(sx - hx, sy - hy, sz - hz)));
}

/**
 * Stand-in world landmarks for a camera that sends none (an older phone page): the picture
 * itself, scaled so the torso is the usual length, centred on the hips, flat. Every bone then
 * reads as lying across the picture, so depth comes only from its foreshortening, taken as
 * towards the camera (a player reaching for a ball has their arms out in front).
 */
export function flatWorld(image: readonly PicturePoint[], size: FrameSize): WorldPoint[] {
  const px = (i: number) => ({ x: image[i].x * size.width, y: image[i].y * size.height });
  const [ls, rs, lh, rh] = [11, 12, 23, 24].map(px);
  const hip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const torso = Math.hypot((ls.x + rs.x) / 2 - hip.x, (ls.y + rs.y) / 2 - hip.y) || 1;
  const k = TORSO_LENGTH.usual / torso;
  return image.map((_, i) => { const p = px(i); return { x: (p.x - hip.x) * k, y: (p.y - hip.y) * k, z: 0 }; });
}

/** dir, and across made square to it, from a wrist, knuckle line and fingers' end. */
function axes(wrist: Vec3, index: Vec3, pinky: Vec3, middle: Vec3) {
  const dir = unit(view(sub(middle, wrist)));
  const line = view(sub(index, pinky));
  if (!dir) return null;
  const across = unit(sub(line, scale(dir, dot(line, dir))));
  return across ? { dir, across } : null;
}

/** One side's hand, or null when the camera doesn't see its arm. */
export function handPose(pose: { landmarks: PicturePoint[]; world: WorldPoint[] }, hand: HandInput | undefined, side: Side, size: FrameSize, fov = DEFAULT_FOV): HandPose | null {
  const j = POSE[side];
  const elbowAt = side === 'left' ? 13 : 14;
  const { landmarks: image, world } = pose;
  const seen = (i: number) => (image[i]?.visibility ?? 1) >= SEEN;
  if (!seen(j.shoulder) || (!hand && !seen(j.wrist))) return null;
  const f = focalLength(size.width, fov);
  const torso = depthOf(world, image, TORSO, size, f, seen);
  if (!torso) return null;
  // The shoulder, at the torso's depth (and its own a little in front of or behind it).
  const shoulders = (world[11].z + world[12].z) / 2;
  const shoulder = scale(ray(image[j.shoulder], size, f), torso + world[j.shoulder].z - shoulders);
  // The elbow on its ray, an upper arm from the shoulder; the wrist on its ray, a forearm from the elbow.
  const body = torsoLength(world, seen);
  const upper = body * UPPER_ARM, fore = body * FOREARM;
  const wristRay = hand ? ray(hand.landmarks[HAND.wrist], size, f) : ray(image[j.wrist], size, f);
  let wristDepth: number;
  if (seen(elbowAt)) {
    const elbowRay = ray(image[elbowAt], size, f);
    // (Stand-ins with no depths at all, flatWorld's, can't lean: the arm is taken as out in front.)
    const lean = world[elbowAt].z === 0 && world[j.shoulder].z === 0 ? 1 : upperArmForward(world[elbowAt].z - world[j.shoulder].z);
    const elbow = scale(elbowRay, boneEnd(elbowRay, shoulder, upper, lean));
    wristDepth = boneEnd(wristRay, elbow, fore, world[j.wrist].z - world[elbowAt].z > SURELY_BACK);
  } else {
    // No elbow: the wrist a bent arm's reach from the shoulder.
    wristDepth = boneEnd(wristRay, shoulder, (upper + fore) * 0.85, world[j.wrist].z - world[j.shoulder].z > SURELY_BACK);
  }
  const wrist = scale(wristRay, reachable(wristRay, wristDepth, shoulder));
  const fromShoulder = view(sub(wrist, shoulder));
  const fromHand = hand && axes(hand.world[HAND.wrist], hand.world[HAND.index], hand.world[HAND.pinky], hand.world[HAND.middle]);
  if (fromHand) return { wrist: fromShoulder, ...fromHand, from: 'hand' };
  const fromPose = axes(world[j.wrist], world[j.index], world[j.pinky], mid(world[j.index], world[j.pinky]));
  return fromPose ? { wrist: fromShoulder, ...fromPose, from: 'pose' } : null;
}

/** How a player's torso and head are turned, in radians in their own frame (x right, y up, z back), to draw their body with. */
export interface BodyTurn {
  /** About the vertical (y): positive brings the right shoulder forward, turning them to their left. */
  yaw: number;
  /** About z, sideways: positive lifts the right shoulder. */
  roll: number;
  /** About x: positive leans back (the shoulders behind the hips). */
  pitch: number;
  /** The head's own turn (from the camera, not the body) and tilt, the same ways round. */
  headYaw: number;
  headRoll: number;
}
export const STRAIGHT: Readonly<BodyTurn> = { yaw: 0, roll: 0, pitch: 0, headYaw: 0, headRoll: 0 };
const clampTo = (x: number, limit: number) => Math.min(limit, Math.max(-limit, x));

/**
 * The torso's and head's turns from the world landmarks: the shoulders' line (and the hips', for
 * leaning) and the nose from the ears. The model's depths are its weakest output, so the turns are
 * kept modest; null when the shoulders aren't seen.
 */
export function bodyTurn(world: readonly WorldPoint[], image: readonly PicturePoint[]): BodyTurn | null {
  const seen = (i: number) => !!world[i] && (image[i]?.visibility ?? 1) >= SEEN;
  if (!seen(11) || !seen(12)) return null;
  // Left shoulder to right: the player's right (+x) when they're square to the camera.
  const across = view(sub(world[12], world[11]));
  const turn: BodyTurn = {
    yaw: clampTo(Math.atan2(-across.z, across.x), 0.9),
    roll: clampTo(Math.atan2(across.y, Math.hypot(across.x, across.z)), 0.6),
    pitch: 0, headYaw: 0, headRoll: 0,
  };
  if ([23, 24].every(seen)) {
    const up = view(sub(mid(world[11], world[12]), mid(world[23], world[24])));
    turn.pitch = clampTo(Math.atan2(up.z, up.y), 0.45);
  }
  // The head's turn needs the face's depth: without it (flatWorld's stand-ins are flat) it
  // follows the body's.
  turn.headYaw = turn.yaw;
  if ([0, 7, 8].every(seen)) {
    const face = view(sub(world[0], mid(world[7], world[8])));
    const ears = view(sub(world[8], world[7]));
    if (-face.z > 0.02) turn.headYaw = clampTo(Math.atan2(-face.x, -face.z), 1.1);
    turn.headRoll = clampTo(Math.atan2(ears.y, Math.hypot(ears.x, ears.z)), 0.6);
  }
  return turn;
}
