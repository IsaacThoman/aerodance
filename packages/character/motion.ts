import { createPoseApplier, calibratePoses } from './retarget.ts';
import type { MotionTake, TakeSample } from '../pose/motion.ts';
import { decodeMotion } from '../pose/motion.ts';
import type { Pose } from '../pose/choreography.ts';
import type { Object3D } from 'three';

/** Loads a dance capture take file (assets/dance.adpose). */
export const loadMotion = (bytes: ArrayBuffer | Uint8Array): MotionTake => decodeMotion(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

// Looping and seam blending belong only to the silent menu/demo preview.
// Runtime songs use the finite shared sampler directly.
export function samplePose(data: MotionTake, person: number, seconds: number): Pose | null {
  return samplePoseInto(data, person, seconds);
}

function personPose(poses: readonly Pose[], person: number): Pose | undefined {
  for (let i = 0; i < poses.length; i++) if (poses[i].playerId === person) return poses[i];
  return undefined;
}

/** The pose-only path of sampleSnapshot, with the same endpoint tolerance and gap policy. */
function samplePoseInto(data: MotionTake, person: number, seconds: number, target?: Pose): Pose | null {
  const time = ((seconds * 1000 % data.durationMs) + data.durationMs) % data.durationMs;
  const samples = data.samples, last = samples[samples.length - 1].takeTimeMs;
  const timeMs = Math.min(time, last);
  if (timeMs < samples[0].takeTimeMs - 1e-5 || timeMs > last + 1e-5) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (samples[mid].takeTimeMs <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  let left = samples[lo], right: TakeSample | undefined = samples[lo + 1], alpha = 0;
  if (Math.abs(left.takeTimeMs - timeMs) < 1e-5) right = undefined;
  else if (right && Math.abs(right.takeTimeMs - timeMs) < 1e-5) {
    left = right;
    right = undefined;
  } else {
    if (!right || right.takeTimeMs - left.takeTimeMs > 200) return null;
    alpha = (timeMs - left.takeTimeMs) / (right.takeTimeMs - left.takeTimeMs);
  }
  const a = personPose(left.poses, person), b = right && personPose(right.poses, person);
  if (!a || right && !b) return null; // Never interpolate across a missing slot.
  // Public samples own their joints; each retargeter supplies its private reusable buffer.
  const pose = target ?? { playerId: person, landmarks: a.landmarks.map(joint => ({ ...joint })) };
  for (let i = 0; i < a.landmarks.length; i++) {
    const joint = pose.landmarks[i], p = a.landmarks[i];
    if (b) {
      const q = b.landmarks[i];
      joint.x = p.x + (q.x - p.x) * alpha;
      joint.y = p.y + (q.y - p.y) * alpha;
      joint.z = p.z + (q.z - p.z) * alpha;
      joint.confidence = p.confidence === null || q.confidence === null ? null : p.confidence + (q.confidence - p.confidence) * alpha;
    } else {
      joint.x = p.x; joint.y = p.y; joint.z = p.z; joint.confidence = p.confidence;
    }
  }
  const seam = Math.min(350, data.durationMs / 4);
  const blend = Math.max(0, Math.min(1, (time - (data.durationMs - seam)) / seam));
  const smooth = blend * blend * (3 - 2 * blend);
  const first = personPose(samples[0].poses, person);
  if (first) for (let i = 0; i < pose.landmarks.length; i++) {
    const joint = pose.landmarks[i], start = first.landmarks[i];
    joint.x += (start.x - joint.x) * smooth;
    joint.y += (start.y - joint.y) * smooth;
    joint.z += (start.z - joint.z) * smooth;
  }
  return pose;
}

/** Plays one dancer of a take on a rig: call with the playback time in seconds (it loops). */
export function createRetargeter(model: Object3D, data: MotionTake, person: number) {
  const apply = createPoseApplier(model, calibratePoses(
    data.samples.flatMap(s => s.poses.filter(p => p.playerId === person)), data.input,
  ));
  const pose: Pose = { playerId: person, landmarks: Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, confidence: null })) };
  return (seconds: number) => apply(samplePoseInto(data, person, seconds, pose));
}
