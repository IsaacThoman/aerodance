// Takes: captured motion a dancer's clips play (format.ts TakeSource, TakeClip).
//
// A take file is the capture as it came from the tracker and is never rewritten. What the dance
// plays is the cleaned view decoded here: isolated joint spikes rejected, short gaps bridged and
// jitter smoothed (packages/pose/cleanup.ts), with each joint's fitness for scoring kept beside
// it. The cleanup is deterministic, so a dance compiles the same every time.
import { decodePoseFile, framesFromSamples, framesToPoses, framesToSamples, sampleFrames } from '../pose/binary.ts';
import type { PoseFrames } from '../pose/binary.ts';
import type { Landmark, PlayerCount, PoseSnapshot } from '../pose/choreography.ts';
import { cleanupPoses } from '../pose/cleanup.ts';
import type { CleanupCounts } from '../pose/cleanup.ts';
import type { Body, PointControl, TakeClip } from './format.ts';
import { POINTS } from './format.ts';
import { landmarksToRig, mirrorControl } from './rig.ts';
import type { RigPose, Vec3 } from './rig.ts';
import { encodeTracking } from './tracking.ts';
import type { TrackedFrame, TrackingData } from './tracking.ts';

/** Frames further apart than this are a gap: nothing is interpolated across it. */
export const TAKE_GAP_MS = 250;
/** A clip eases to and from what's beneath it over this long either side of a gap in its take. */
export const GAP_FADE_MS = 160;

export interface TakeData extends TrackingData {
  readonly width: number; readonly height: number;
  /** What the cleanup changed, or null for a take decoded as captured. */
  readonly cleanup: CleanupCounts | null;
  /** Which of a slot's 33 joints may be scored at a take time, or null where it has no pose. */
  eligibleAt(slot: number, takeMs: number): boolean[] | null;
  /** The stretches of take time over which a slot has poses, in order. */
  runs(slot: number): readonly (readonly [number, number])[];
}

export const encodeTake = encodeTracking;
export type { TrackedFrame };

/** Decodes a take file; with cleanup (the default), as the dance plays it. */
export function decodeTake(bytes: Uint8Array, { cleanup = true }: { cleanup?: boolean } = {}): TakeData {
  const raw = decodePoseFile(bytes);
  if (raw.kind !== 'take') throw Error('A take must be a take pose file');
  let frames: PoseFrames = raw, counts: CleanupCounts | null = null;
  if (cleanup && raw.times.length) {
    const cleaned = cleanupPoses(framesToSamples(raw, 'takeTimeMs'), raw.input);
    counts = cleaned.counts;
    frames = framesFromSamples({ kind: 'take', playerSlots: raw.playerSlots, input: raw.input, modelId: raw.modelId, positionStep: raw.positionStep }, cleaned.samples, 'takeTimeMs');
  }
  return takeData(frames, counts);
}
/** Take data straight from tracked frames (no file), for tests and freshly recorded takes. */
export function takeFromFrames(tracked: readonly TrackedFrame[], size: { width: number; height: number; slots: number }, options: { cleanup?: boolean } = {}): TakeData {
  return decodeTake(encodeTracking(tracked, size), options);
}

function takeData(frames: PoseFrames, cleanup: CleanupCounts | null): TakeData {
  const pick = (snapshot: PoseSnapshot, slot: number) => snapshot.poses.findIndex(p => p.playerId === slot);
  const runCache = new Map<number, [number, number][]>();
  return {
    frames, slots: frames.playerSlots, times: frames.times, width: frames.input.width, height: frames.input.height, cleanup,
    poseAt(slot, ms, maxGapMs = TAKE_GAP_MS) {
      const s = sampleFrames(frames, ms, maxGapMs), i = pick(s, slot);
      return i < 0 ? null : s.poses[i].landmarks;
    },
    poseAtFrame(slot, frame) {
      const s = framesToPoses(frames, frame), i = pick(s, slot);
      return i < 0 ? null : s.poses[i].landmarks;
    },
    eligibleAt(slot, ms) {
      const s = sampleFrames(frames, ms, TAKE_GAP_MS), i = pick(s, slot);
      return i < 0 ? null : s.quality[i].scoreEligible;
    },
    runs(slot) {
      let runs = runCache.get(slot);
      if (runs) return runs;
      runs = [];
      const bit = 1 << slot, { times, present } = frames;
      // A run ends at a frame without the slot (absence is never interpolated across) or a long pause.
      let start = -1, last = -1;
      for (let i = 0; i < times.length; i++) {
        if (!(present[i] & bit)) { if (start >= 0) { runs.push([times[start], times[last]]); start = -1; } continue; }
        if (start >= 0 && times[i] - times[last] > TAKE_GAP_MS) { runs.push([times[start], times[last]]); start = -1; }
        if (start < 0) start = i;
        last = i;
      }
      if (start >= 0) runs.push([times[start], times[last]]);
      runCache.set(slot, runs);
      return runs;
    },
  };
}

const smoothstep = (u: number) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
/** How present a slot is at a take time: 1 inside a run, easing to 0 at its ends, 0 in a gap. */
export function presenceAt(take: TakeData, slot: number, takeMs: number, fadeMs = GAP_FADE_MS): number {
  const runs = take.runs(slot);
  let lo = 0, hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = runs[mid];
    if (takeMs < a) hi = mid - 1;
    else if (takeMs > b) lo = mid + 1;
    else {
      // The take's very first and last frames aren't gaps (the clip's own fades handle its ends);
      // a performer who walks into view after the take starts, or out before it ends, is.
      const { times } = take;
      const head = a <= times[0] + 1e-5 ? 1 : smoothstep((takeMs - a) / fadeMs), tail = b >= times[times.length - 1] - 1e-5 ? 1 : smoothstep((b - takeMs) / fadeMs);
      return Math.min(head, tail);
    }
  }
  return 0;
}

// ---- Rig poses from takes ----

type RigTrack = (RigPose | null | undefined)[];
const rigCaches = new WeakMap<TakeData, Map<string, RigTrack>>();
/** A slot's rig pose at each of the take's frames (in the take's own frame), solved once per body. */
function rigTrack(take: TakeData, slot: number, head: number, shoulderWidth: number): RigTrack {
  let cache = rigCaches.get(take);
  if (!cache) rigCaches.set(take, cache = new Map());
  const key = `${slot}|${head.toFixed(5)}|${shoulderWidth.toFixed(5)}`;
  let track = cache.get(key);
  if (!track) cache.set(key, track = Array<RigPose | null | undefined>(take.times.length).fill(undefined));
  return track;
}
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
function lerpRig(a: RigPose, b: RigPose, u: number): RigPose {
  const points = {} as Record<PointControl, Vec3>;
  for (const c of POINTS) { const p = a.points[c], q = b.points[c]; points[c] = [lerp(p[0], q[0], u), lerp(p[1], q[1], u), lerp(p[2], q[2], u)]; }
  return { points, turn: lerp(a.turn, b.turn, u), headYaw: lerp(a.headYaw, b.headYaw, u), headPitch: lerp(a.headPitch, b.headPitch, u), headRoll: lerp(a.headRoll, b.headRoll, u) };
}
/**
 * A take clip's rig pose at a take time, placed in the dance's frame: the take's `anchor` stands
 * at `home` (plus the clip's shift), scaled, and mirrored if the clip is. Null in a gap.
 */
export function takeRigAt(take: TakeData, clip: Pick<TakeClip, 'slot' | 'anchor' | 'scale' | 'mirror' | 'shift'>, takeMs: number,
  body: Body, home: readonly [number, number], aspect: number): RigPose | null {
  const { times } = take, n = times.length;
  if (!n || takeMs < times[0] - 1e-5 || takeMs > times[n - 1] + 1e-5) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= takeMs) lo = mid; else hi = mid - 1; }
  const takeAspect = take.width / take.height;
  // The head and shoulder sizes the solver reads angles against, in the take's own units.
  const head = body.head / clip.scale, shoulderWidth = body.shoulderWidth / clip.scale;
  const track = rigTrack(take, clip.slot, head, shoulderWidth);
  const at = (i: number): RigPose | null => {
    let rig = track[i];
    if (rig === undefined) {
      const landmarks = take.poseAtFrame(clip.slot, i);
      rig = track[i] = landmarks ? landmarksToRig(landmarks, { ...body, head, shoulderWidth }, takeAspect) : null;
    }
    return rig;
  };
  let pose: RigPose | null;
  if (lo + 1 >= n || Math.abs(times[lo] - takeMs) < 1e-5) pose = at(lo);
  else if (times[lo + 1] - times[lo] > TAKE_GAP_MS) pose = null;
  else {
    const a = at(lo), b = at(lo + 1);
    pose = a && b ? lerpRig(a, b, (takeMs - times[lo]) / (times[lo + 1] - times[lo])) : null;
  }
  return pose && placeTakeRig(pose, clip, takeAspect, home, aspect);
}
function placeTakeRig(pose: RigPose, clip: Pick<TakeClip, 'anchor' | 'scale' | 'mirror' | 'shift'>, takeAspect: number, home: readonly [number, number], aspect: number): RigPose {
  const sx = takeAspect * clip.scale / aspect * (clip.mirror ? -1 : 1), sy = clip.scale, sz = takeAspect * clip.scale / aspect;
  const ox = home[0] + clip.shift[0], oy = home[1] + clip.shift[1];
  const points = {} as Record<PointControl, Vec3>;
  for (const c of POINTS) {
    const p = pose.points[clip.mirror ? mirrorControl(c) : c];
    points[c] = [ox + (p[0] - clip.anchor[0]) * sx, oy + (p[1] - clip.anchor[1]) * sy, p[2] * sz];
  }
  const flip = clip.mirror ? -1 : 1;
  return { points, turn: pose.turn * flip, headYaw: pose.headYaw * flip, headPitch: pose.headPitch, headRoll: pose.headRoll * flip };
}
/** A clip-space landmark index for a dance-space one: left and right swap in a mirrored clip. */
const MIRROR_LANDMARK: readonly number[] = (() => {
  const pairs = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
  const out = Array.from({ length: 33 }, (_, i) => i);
  for (const [a, b] of pairs) { out[a] = b; out[b] = a; }
  return out;
})();
export const mirrorLandmarkIndex = (i: number) => MIRROR_LANDMARK[i];
/** Which joints a take clip may have scored at a take time (mirrored with the clip), or null in a gap. */
export function takeEligibleAt(take: TakeData, clip: Pick<TakeClip, 'slot' | 'mirror'>, takeMs: number): boolean[] | null {
  const eligible = take.eligibleAt(clip.slot, takeMs);
  if (!eligible || !clip.mirror) return eligible;
  return eligible.map((_, j) => eligible[MIRROR_LANDMARK[j]]);
}

// ---- Measuring a take, to place it ----

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const sure = (l: Landmark) => l.confidence === null || l.confidence >= 0.5;
/**
 * Where a slot stands and how big it is over a stretch of take time: the median hip midpoint
 * and torso length (hips to shoulders, in take frame heights), from poses whose torso is tracked.
 * Null when it never is.
 */
export function measureTake(take: TakeData, slot: number, range?: readonly [number, number]): { hips: [number, number]; torso: number; poses: Landmark[][] } | null {
  const aspect = take.width / take.height, xs: number[] = [], ys: number[] = [], torsos: number[] = [], poses: Landmark[][] = [];
  for (let i = 0; i < take.times.length; i++) {
    if (range && (take.times[i] < range[0] || take.times[i] > range[1])) continue;
    const l = take.poseAtFrame(slot, i);
    if (!l) continue;
    poses.push(l);
    if (![11, 12, 23, 24].every(j => sure(l[j]))) continue;
    const hx = (l[23].x + l[24].x) / 2, hy = (l[23].y + l[24].y) / 2, sx = (l[11].x + l[12].x) / 2, sy = (l[11].y + l[12].y) / 2;
    xs.push(hx); ys.push(hy); torsos.push(Math.hypot((sx - hx) * aspect, sy - hy));
  }
  if (!xs.length) return null;
  return { hips: [median(xs), median(ys)], torso: median(torsos), poses };
}
/** A take's people count, as the pose format types it. */
export const takeSlots = (n: number) => Math.min(4, Math.max(1, Math.round(n))) as PlayerCount;
