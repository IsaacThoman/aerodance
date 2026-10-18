import { createPoseApplier, calibratePoses } from './retarget.ts';
import type { MotionTake } from '../pose/motion.ts';
import { decodeMotion } from '../pose/motion.ts';
import { sampleSnapshot } from '../pose/choreography.ts';
import type { Pose } from '../pose/choreography.ts';
import type { Object3D } from 'three';

/** Loads a dance capture take file (assets/dance.adpose). */
export const loadMotion = (bytes: ArrayBuffer | Uint8Array): MotionTake => decodeMotion(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

// Looping and seam blending belong only to the silent menu/demo preview.
// Runtime songs use the finite shared sampler directly.
export function samplePose(data: MotionTake, person: number, seconds: number): Pose | null {
  const time = ((seconds * 1000 % data.durationMs) + data.durationMs) % data.durationMs;
  const last = data.samples[data.samples.length - 1].takeTimeMs;
  const snapshot = sampleSnapshot(data.samples, Math.min(time, last), 'takeTimeMs', 200);
  const pose = snapshot.poses.find(p => p.playerId === person);
  if (!pose) return null;
  const seam = Math.min(350, data.durationMs / 4);
  const blend = Math.max(0, Math.min(1, (time - (data.durationMs - seam)) / seam));
  const smooth = blend * blend * (3 - 2 * blend);
  const first = data.samples[0].poses.find(p => p.playerId === person);
  if (first) pose.landmarks.forEach((joint, i) => {
    for (const axis of ['x','y','z'] as const) joint[axis] += (first.landmarks[i][axis] - joint[axis]) * smooth;
  });
  return pose;
}

/** Plays one dancer of a take on a rig: call with the playback time in seconds (it loops). */
export function createRetargeter(model: Object3D, data: MotionTake, person: number) {
  const apply = createPoseApplier(model, calibratePoses(
    data.samples.flatMap(s => s.poses.filter(p => p.playerId === person)), data.input,
  ));
  return (seconds: number) => apply(samplePose(data, person, seconds));
}
