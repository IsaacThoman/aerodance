// Poses tracked from the source video: the reference an animator matches, drafts keys from
// and scores against. Stored as a `take` .adpose on the video's own clock (media ms), one slot
// per tracked person, slot n following sources.tracking[].dancers[n].
import { decodePoseFile, encodePoseFile, framesFromSamples, framesToPoses, sampleFrames } from '../../packages/pose/binary.ts';
import type { PoseFrames } from '../../packages/pose/binary.ts';
import type { Landmark, PlayerCount, Pose } from '../../packages/pose/choreography.ts';

/** One analysed video frame: each slot's landmarks, or null where that person wasn't found. */
export interface TrackedFrame { videoMs: number; poses: (Landmark[] | null)[]; }
export interface TrackingData {
  readonly frames: PoseFrames;
  readonly slots: number;
  readonly times: Float64Array;
  /** A slot's landmarks at a video time, interpolated between frames at most maxGapMs apart. */
  poseAt(slot: number, videoMs: number, maxGapMs?: number): Landmark[] | null;
  /** A slot's landmarks at frame i, or null. */
  poseAtFrame(slot: number, frame: number): Landmark[] | null;
}

export function encodeTracking(frames: readonly TrackedFrame[], { width, height, slots, provenance }:
  { width: number; height: number; slots: number; provenance?: Record<string, unknown> }): Uint8Array<ArrayBuffer> {
  if (slots < 1 || slots > 4) throw Error('Tracking holds one to four people');
  const samples = frames.map(f => ({
    takeTimeMs: f.videoMs,
    poses: f.poses.flatMap((landmarks, slot): Pose[] => landmarks ? [{ playerId: slot, landmarks }] : []),
  }));
  return encodePoseFile(framesFromSamples({
    kind: 'take', playerSlots: slots as PlayerCount, input: { width, height }, modelId: 'lite',
    ...(provenance ? { provenance } : {}),
  }, samples, 'takeTimeMs'));
}
export function decodeTracking(bytes: Uint8Array): TrackingData {
  const frames = decodePoseFile(bytes);
  if (frames.kind !== 'take') throw Error('Tracking must be a take pose file');
  const pick = (snapshot: { poses: Pose[] }, slot: number) => snapshot.poses.find(p => p.playerId === slot)?.landmarks ?? null;
  return {
    frames, slots: frames.playerSlots, times: frames.times,
    poseAt: (slot, videoMs, maxGapMs = 250) => pick(sampleFrames(frames, videoMs, maxGapMs), slot),
    poseAtFrame: (slot, frame) => pick(framesToPoses(frames, frame), slot),
  };
}

const hipCenter = (l: readonly Landmark[], aspect: number) => [((l[23].x + l[24].x) / 2) * aspect, (l[23].y + l[24].y) / 2];
const torsoCenter = (l: readonly Landmark[], aspect: number) => {
  const h = hipCenter(l, aspect);
  return [(h[0] + (l[11].x + l[12].x) / 2 * aspect) / 2, (h[1] + (l[11].y + l[12].y) / 2) / 2];
};
function permutations(n: number, k: number): number[][] {
  // Every way to pick k of n items in order.
  if (k === 0) return [[]];
  const out: number[][] = [];
  for (let i = 0; i < n; i++) for (const rest of permutations(n, k - 1)) if (!rest.includes(i)) out.push([i, ...rest]);
  return out;
}
/**
 * Follows `slots` people through per-frame detections: each detection goes to the slot whose
 * last position (torso centre, frame heights) is closest, so people keep their slot as they
 * move. A slot can go unmatched for a frame (null) when its person isn't detected or is too far
 * from where it was. `starts` are the slots' starting positions [x, y] in the frame (e.g. the
 * dancers' homes); without them the first detections are taken left to right.
 */
export function assignSlots(detections: readonly { videoMs: number; poses: Landmark[][] }[], slots: number, aspect: number,
  { starts, maxJump = 0.35 }: { starts?: readonly (readonly [number, number])[]; maxJump?: number } = {}): TrackedFrame[] {
  const last: (number[] | null)[] = starts ? starts.map(s => [s[0] * aspect, s[1]]) : Array(slots).fill(null);
  const lastMs: (number | null)[] = Array(slots).fill(null);
  return detections.map(({ videoMs, poses }) => {
    const centres = poses.map(p => torsoCenter(p, aspect));
    const out: (Landmark[] | null)[] = Array(slots).fill(null);
    if (last.every(p => p === null)) {
      // Left to right.
      const order = centres.map((c, i) => [c[0], i]).sort((a, b) => a[0] - b[0]).slice(0, slots);
      order.forEach(([, i], slot) => { out[slot] = poses[i]; });
    } else {
      let best: { cost: number; pairs: [number, number][] } = { cost: Infinity, pairs: [] };
      const k = Math.min(slots, poses.length);
      // Try every assignment of detections to slots (at most 4 x 4); an unmatched slot costs as
      // much as the longest allowed jump, so a plausible match always wins.
      for (let used = 0; used <= k; used++) {
        for (const slotPick of permutations(slots, used)) for (const detPick of permutations(poses.length, used)) {
          let cost = (slots - used) * maxJump;
          const pairs: [number, number][] = [];
          let ok = true;
          slotPick.forEach((slot, j) => {
            const det = detPick[j], prev = last[slot];
            const elapsed = lastMs[slot] === null ? 0 : (videoMs - lastMs[slot]!) / 1000;
            const allowed = prev ? maxJump * Math.max(1, elapsed * 4) : Infinity;
            const d = prev ? Math.hypot(centres[det][0] - prev[0], centres[det][1] - prev[1]) : maxJump * 0.5;
            if (d > allowed) ok = false;
            cost += d;
            pairs.push([slot, det]);
          });
          if (ok && cost < best.cost) best = { cost, pairs };
        }
      }
      for (const [slot, det] of best.pairs) out[slot] = poses[det];
    }
    out.forEach((p, slot) => { if (p) { last[slot] = torsoCenter(p, aspect); lastMs[slot] = videoMs; } });
    return { videoMs, poses: out };
  });
}
