import { MAX_PLAYERS } from '../../../../../packages/pose/choreography.ts';
import type { FrameSize } from '../../../../../packages/pose/choreography.ts';
import { JOINT_INDEX } from '../joints.ts';
import { bodyPoints, landmarksOf, STAND, toImage } from './rig.ts';
import type { DetectedPoint, PuppetPose, Vec3 } from './rig.ts';
import { ease, gestureSteps, namedPose } from './poses.ts';
import type { EaseName, PosePatch, PuppetStep } from './poses.ts';

/*
 * Pretend people for the camera: up to four puppets standing in front of it, posed by name,
 * tweened, put through gestures and timed sequences, moved about the picture, stepping in and
 * out, and reported the way MediaPipe Pose reports people (landmarks with visibility and
 * presence, in no particular order, with tracking jitter, the odd missed frame and joint).
 *
 * Every change is put on a timeline from the moment it's asked for, so the camera can ask where
 * everyone was at any recent moment: puppetCamera.ts reports the picture a camera delay late, as a
 * real camera does. detect(t) is what the model would find in a frame captured at t.
 *
 * const puppet = new Puppet();
 * puppet.lineUp(2);                                   // two people side by side, P1 on the left
 * puppet.pose(0, 'tpose', { ms: 300 });               // tween to a named pose
 * puppet.gesture('all', 'jump');                      // everyone jumps
 * puppet.play(1, [{ patch: { lean: 20 }, ms: 300, hold: 500 }, { patch: { lean: 0 }, ms: 300 }], { loop: true });
 * puppet.detect(performance.now());                   // { landmarks: DetectedPoint[][], looks }
 */

/** How real the camera is: tracking jitter, missed people and joints, and its delays. */
export interface PuppetRealism {
  /** Landmark jitter, as a fraction of the picture (standard deviation; hands and feet twice it). */
  jitter: number;
  /** Chance a person is missed in a frame. */
  dropout: number;
  /** Chance each landmark of the face and hands is unsure in a frame. */
  jointDropout: number;
  /** How old the picture is by the time the browser sees the frame (the camera's own delay). */
  captureMs: number;
  /** How long tracking takes a frame: also sets the tracking rate (one frame at a time). */
  inferenceMs: number;
}
export const REALISM: Record<'clean' | 'real' | 'rough', PuppetRealism> = {
  clean: { jitter: 0, dropout: 0, jointDropout: 0, captureMs: 0, inferenceMs: 33 },
  // About MediaPipe Lite on a laptop webcam: 25 poses a second, a tenth of a second behind.
  real: { jitter: 0.0025, dropout: 0, jointDropout: 0.004, captureMs: 50, inferenceMs: 38 },
  // A slow machine in a dim room.
  rough: { jitter: 0.006, dropout: 0.04, jointDropout: 0.03, captureMs: 90, inferenceMs: 55 },
};

/** Who: a puppet's id (0-3, the player it lines up as), or everyone in view. */
export type PuppetTarget = number | 'all';
export interface TweenOptions { ms?: number; ease?: EaseName; }

interface Segment { t0: number; t1: number; from: PuppetPose; to: PuppetPose; ease: EaseName; cutAt: number; }
interface Person {
  id: number;
  /** In view from these times (true) or out of it (false), oldest first. */
  presence: { at: number; inView: boolean }[];
  /** The pose before the first segment, then contiguous segments. */
  base: PuppetPose;
  segments: Segment[];
  /** A looping sequence: its steps and when its next lap starts. */
  loop: { steps: PuppetStep[]; next: number } | null;
  /** The clothes' colours (chest and waist, legs), for the tracker's looks. */
  shirt: readonly [number, number, number];
  trousers: readonly [number, number, number];
}

// Shirts per puppet, distinct enough that the tracker tells them apart by looks; denim trousers.
const SHIRTS = [[40, 110, 220], [215, 60, 70], [40, 170, 90], [235, 190, 40]] as const;
const TROUSERS = [[45, 60, 95], [70, 60, 50], [35, 40, 45], [90, 80, 110]] as const;
// Further back with more people, so they fit side by side.
const LINE_DEPTH = [1, 1, 1.05, 1.2, 1.3];
// A timeline keeps this much of its past (the camera asks a fraction of a second back).
const KEEP_MS = 5000;

const copyPose = (p: PuppetPose): PuppetPose => ({ ...p, leftHand: { ...p.leftHand }, rightHand: { ...p.rightHand }, leftFoot: { ...p.leftFoot }, rightFoot: { ...p.rightFoot }, joints: { ...p.joints } });
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerp3 = (a: Vec3, b: Vec3, k: number): Vec3 => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k) });
const NUMBERS = ['x', 'depth', 'lean', 'bow', 'turn', 'crouch', 'lift', 'headTilt', 'headTurn'] as const;
const LIMBS = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const;

export function lerpPose(a: PuppetPose, b: PuppetPose, k: number): PuppetPose {
  const out = copyPose(b);
  for (const key of NUMBERS) out[key] = lerp(a[key], b[key], k);
  for (const key of LIMBS) out[key] = lerp3(a[key], b[key], k);
  out.joints = {};
  for (const i of new Set([...Object.keys(a.joints), ...Object.keys(b.joints)].map(Number))) {
    const from = a.joints[i], to = b.joints[i];
    if (from && to) out.joints[i] = lerp3(from, to, k);
    else if (to) out.joints[i] = to;
  }
  return out;
}

/** A pose with a patch applied (null joints are let go). */
export function applyPatch(pose: PuppetPose, patch: PosePatch): PuppetPose {
  const out = copyPose(pose);
  for (const key of NUMBERS) if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) out[key] = patch[key];
  for (const key of LIMBS) if (patch[key]) out[key] = { ...out[key], ...patch[key] };
  for (const [i, at] of Object.entries(patch.joints ?? {})) {
    if (at) out.joints[Number(i)] = at;
    else delete out.joints[Number(i)];
  }
  return out;
}

// Seeded randomness, so a run with the same commands jitters the same way.
function random(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const gaussian = (rnd: () => number) => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

export interface PuppetOptions { seed?: number; now?: () => number; frame?: FrameSize; realism?: PuppetRealism; }

export class Puppet {
  now: () => number;
  frame: FrameSize;
  realism: PuppetRealism;
  /** The line-up follows the game's player count (follow), until people are placed by hand. */
  auto = true;
  /** The game's player count, as the camera last asked for it. */
  requested = 1;
  people: Person[];
  rnd: () => number;
  constructor({ seed = 11, now = () => performance.now(), frame = { width: 640, height: 480 }, realism = REALISM.real }: PuppetOptions = {}) {
    this.now = now; this.frame = frame; this.realism = { ...realism };
    this.rnd = random(seed);
    const t = now();
    this.people = Array.from({ length: MAX_PLAYERS }, (_, id) => ({
      id, presence: [{ at: -Infinity, inView: false }], base: copyPose(STAND), segments: [], loop: null,
      shirt: SHIRTS[id], trousers: TROUSERS[id],
    }));
    this.people.forEach((p) => { p.base.x = 0.5; p.presence[0].at = t - KEEP_MS; });
  }

  /** The ids a target names (everyone in view, for 'all'). */
  ids(who: PuppetTarget): number[] {
    if (who === 'all') return this.people.filter((p) => this.inView(p.id)).map((p) => p.id);
    if (!Number.isInteger(who) || who < 0 || who >= MAX_PLAYERS) throw Error(`No puppet ${who}: use 0-${MAX_PLAYERS - 1} or all`);
    return [who];
  }

  /** Whether a puppet is in view at t (now by default). */
  inView(id: number, t = this.now()) {
    const events = this.people[id].presence;
    for (let i = events.length - 1; i >= 0; i--) if (events[i].at <= t) return events[i].inView;
    return false;
  }

  /** Puppets 0..count-1 step into view side by side (P1 on the left of the mirror), the rest step out. */
  lineUp(count: number) {
    const n = Math.max(0, Math.min(MAX_PLAYERS, Math.round(count)));
    const t = this.now();
    this.people.forEach((p) => {
      const inView = p.id < n;
      this.cut(p, t);
      if (inView) {
        const pose = applyPatch(this.poseAt(p, t), { x: (p.id + 0.5) / n, depth: LINE_DEPTH[n] });
        this.push(p, { t0: t, t1: t, from: pose, to: pose, ease: 'linear', cutAt: Infinity });
      }
      this.setInView(p, inView, t);
    });
  }
  /** The camera asks for this many players: with auto on, that many line up. */
  follow(count: number) {
    this.requested = count;
    if (this.auto) this.lineUp(count);
  }
  /** Steps a puppet into view where it last stood, or out of it. */
  enter(who: PuppetTarget) { for (const id of this.ids(who)) this.setInView(this.people[id], true, this.now()); }
  leave(who: PuppetTarget) { for (const id of this.ids(who)) this.setInView(this.people[id], false, this.now()); }
  setInView(p: Person, inView: boolean, t: number) {
    if (this.inView(p.id, t) === inView) return;
    p.presence = [...p.presence.filter((e) => e.at >= t - KEEP_MS || e === p.presence.at(-1)), { at: t, inView }];
  }

  /** Changes a pose straight away (patch over the current pose). */
  set(who: PuppetTarget, patch: PosePatch) { this.to(who, patch, { ms: 0 }); }
  /** Tweens to a patch over the current pose. */
  to(who: PuppetTarget, patch: PosePatch, { ms = 300, ease: e = 'inOut' }: TweenOptions = {}) {
    this.play(who, [{ patch, ms, ease: e }]);
  }
  /** Tweens to a named pose (poses.ts POSES), standing where it stands. */
  pose(who: PuppetTarget, name: string, { ms = 300, ease: e = 'inOut' }: TweenOptions = {}) {
    this.play(who, [{ patch: namedPose(name), ms, ease: e }]);
  }
  /** Moves across the picture (x on the mirrored picture, 0-1; outside it steps out of view). */
  move(who: PuppetTarget, x: number, options: TweenOptions = {}) { this.to(who, { x }, { ms: 600, ...options }); }
  /** Puts one landmark (or a hand or foot) at a body-space point; null lets it go. */
  joint(who: PuppetTarget, name: string, at: Vec3 | null, options: TweenOptions = {}) {
    const index = JOINT_INDEX[name];
    if (index === undefined) throw Error(`Unknown joint "${name}"; e.g. leftWrist, rightAnkle, nose`);
    // Wrists and ankles move the hand or foot target, so the arm or leg follows.
    const limb = { 15: 'leftHand', 16: 'rightHand', 27: 'leftFoot', 28: 'rightFoot' }[index] as typeof LIMBS[number] | undefined;
    for (const id of this.ids(who)) {
      const p = this.people[id];
      if (limb && at) {
        const patch: PosePatch = {};
        patch[limb] = at;
        this.to(id, patch, options);
        continue;
      }
      // Another landmark starts from where the body has it.
      const from = this.poseAt(p, this.now());
      if (at && !from.joints[index]) this.set(id, { joints: { [index]: bodyPoints(from)[index] } });
      this.to(id, { joints: { [index]: at } }, at ? options : { ms: 0 });
    }
  }
  /** Runs a gesture (poses.ts GESTURES) from wherever each puppet is. */
  gesture(who: PuppetTarget, name: string, { side = 'right', speed = 1 }: { side?: 'left' | 'right'; speed?: number } = {}) {
    for (const id of this.ids(who)) this.play(id, gestureSteps(name, { side, speed, pose: this.poseAt(this.people[id], this.now()) }));
  }
  /** Plays steps from now, each a patch over the last; loop repeats them until the next change. */
  play(who: PuppetTarget, steps: readonly PuppetStep[], { loop = false }: { loop?: boolean } = {}) {
    const t = this.now();
    for (const id of this.ids(who)) {
      const p = this.people[id];
      this.cut(p, t);
      const end = this.queue(p, steps, t);
      p.loop = loop && steps.length ? { steps: [...steps], next: end } : null;
      this.prune(p, t);
    }
  }
  /** Stands everyone in view back up, still and in place, with the realism back to normal. */
  reset() {
    const t = this.now();
    for (const p of this.people) {
      this.cut(p, t);
      const pose = { ...copyPose(STAND), x: this.poseAt(p, t).x, depth: this.poseAt(p, t).depth };
      this.push(p, { t0: t, t1: t, from: pose, to: pose, ease: 'linear', cutAt: Infinity });
    }
    this.realism = { ...REALISM.real };
  }

  /** A puppet's pose at time t. */
  poseAt(p: Person, t: number): PuppetPose {
    // A loop lays its next lap down as time reaches it.
    while (p.loop && p.loop.next <= t + 1000) p.loop.next = this.queue(p, p.loop.steps, p.loop.next);
    return this.evaluate(p, t);
  }
  /** The pose at t on the timeline as it is (without laying down more of a loop). */
  evaluate(p: Person, t: number): PuppetPose {
    let seg: Segment | undefined;
    for (let i = p.segments.length - 1; i >= 0; i--) if (p.segments[i].t0 <= t) { seg = p.segments[i]; break; }
    if (!seg) return p.base;
    const at = Math.min(t, seg.cutAt);
    const k = seg.t1 > seg.t0 ? (at - seg.t0) / (seg.t1 - seg.t0) : 1;
    return k >= 1 ? seg.to : lerpPose(seg.from, seg.to, ease(seg.ease, k));
  }
  /** Lays steps down from t; returns when they end. */
  queue(p: Person, steps: readonly PuppetStep[], t: number) {
    let at = t, pose = this.evaluate(p, t);
    for (const step of steps) {
      const to = applyPatch(pose, step.patch);
      const ms = Math.max(0, step.ms);
      this.push(p, { t0: at, t1: at + ms, from: pose, to, ease: step.ease ?? 'inOut', cutAt: Infinity });
      at += ms;
      if (step.hold) { this.push(p, { t0: at, t1: at, from: to, to, ease: 'linear', cutAt: Infinity }); at += step.hold; }
      pose = to;
    }
    return at;
  }
  push(p: Person, seg: Segment) { p.segments.push(seg); }
  /** Stops whatever is moving a puppet at t: it holds the pose it has then. */
  cut(p: Person, t: number) {
    const pose = this.poseAt(p, t);
    p.loop = null;
    p.segments = p.segments.filter((s) => s.t0 <= t);
    const last = p.segments.at(-1);
    if (last && last.t1 > t) last.cutAt = t;
    if (!last) p.base = pose;
  }
  /** Folds segments long past into the base pose. */
  prune(p: Person, t: number) {
    while (p.segments.length > 1 && p.segments[1].t0 < t - KEEP_MS) {
      p.base = p.segments[1].from;
      p.segments.shift();
    }
  }

  /** A puppet's clean landmarks at t (image space), or null while it's out of view. */
  landmarksAt(id: number, t = this.now()): DetectedPoint[] | null {
    const p = this.people[id];
    if (!this.inView(id, t)) return null;
    const pose = this.poseAt(p, t);
    // Walked out of the picture: gone, as the model loses somebody whose torso has left it.
    if (pose.x < -0.12 || pose.x > 1.12) return null;
    return landmarksOf(pose, this.frame);
  }

  /** A puppet's pose and body-space points at t, for drawing it in the camera's picture. */
  bodyAt(id: number, t = this.now()) {
    const pose = this.poseAt(this.people[id], t);
    return { pose, image: toImage(bodyPoints(pose), pose, this.frame) };
  }

  /** What MediaPipe would report for a frame captured at t: the people it finds, in no order, and their looks. */
  detect(t: number): { landmarks: DetectedPoint[][]; looks: (number[] | null)[] } {
    const { jitter, dropout, jointDropout } = this.realism;
    const found: { landmarks: DetectedPoint[]; looks: number[] }[] = [];
    for (const p of this.people) {
      const clean = this.landmarksAt(p.id, t);
      if (!clean || this.rnd() < dropout) continue;
      const landmarks = clean.map((j, i) => {
        const extremity = (i >= 15 && i <= 22) || i >= 27;
        const n = jitter * (extremity ? 2 : 1);
        // (The face and hands flicker; MediaPipe is steady on the torso and legs of somebody in view.)
        const unsure = (i <= 10 || (i >= 15 && i <= 22)) && this.rnd() < jointDropout;
        const sure = (v: number) => Math.max(0, Math.min(1, unsure ? 0.2 : v + (jitter ? gaussian(this.rnd) * 0.01 : 0)));
        return {
          x: j.x + (n ? gaussian(this.rnd) * n : 0), y: j.y + (n ? gaussian(this.rnd) * n : 0), z: j.z + (n ? gaussian(this.rnd) * n * 3 : 0),
          visibility: sure(j.visibility), presence: sure(j.presence),
        };
      });
      found.push({ landmarks, looks: looksOf(p) });
    }
    // MediaPipe lists people in no stable order.
    for (let i = found.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [found[i], found[j]] = [found[j], found[i]];
    }
    return { landmarks: found.map((f) => f.landmarks), looks: found.map((f) => f.looks) };
  }

  /** Where everyone is now, for the window API and play.ts. */
  state() {
    const t = this.now();
    return {
      auto: this.auto,
      realism: this.realism,
      people: this.people.filter((p) => this.inView(p.id, t)).map((p) => {
        const pose = this.poseAt(p, t);
        const r = (v: number) => Math.round(v * 100) / 100;
        const v = (a: Vec3) => [r(a.x), r(a.y), r(a.z)];
        return {
          id: p.id, x: r(pose.x), depth: r(pose.depth), lean: r(pose.lean), crouch: r(pose.crouch), lift: r(pose.lift),
          leftHand: v(pose.leftHand), rightHand: v(pose.rightHand), moving: !!p.loop || p.segments.some((s) => s.t1 > t && s.cutAt > t),
        };
      }),
    };
  }
}

/** A puppet's looks as appearance.ts samples them: chest, waist and thighs (chromaticity and quartered brightness). */
export function looksOf(p: Pick<Person, 'shirt' | 'trousers'>): number[] {
  const part = ([r, g, b]: readonly [number, number, number]) => { const sum = r + g + b || 1; return [r / sum, g / sum, (r + g + b) / 765 / 4]; };
  return [...part(p.shirt), ...part(p.shirt), ...part(p.trousers)];
}
