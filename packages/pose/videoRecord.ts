import { assertPoses, isObject, oneOf } from './choreography.ts';
import type { CaptureInput, Pose } from './choreography.ts';
import { poseModel } from './browser/models.ts';
import type { PoseModelId } from './browser/models.ts';

export type VideoTimingMethod = 'decoded-frame' | 'seek-time';
/** One video-import tracking result, timed by the video's own media clock. */
export interface VideoRecord {
  schema: 'aerodance.video-record'; schemaVersion: 1; type: 'pose';
  sessionId: string; seq: number; playerCount: 2;
  /** Always unmirrored. */
  input: CaptureInput;
  modelId: PoseModelId;
  mediaTimeMs: number; timingMethod: VideoTimingMethod;
  poses: Pose[];
}
const TIMING_METHODS: readonly VideoTimingMethod[] = ['decoded-frame', 'seek-time'];
const atLeast = (n: unknown, min: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
// File timestamps are independent of browser receipt time and the audio clock.
export function assertVideoRecord(record: unknown): asserts record is VideoRecord {
  if (!isObject(record) || record.schema !== 'aerodance.video-record' || record.schemaVersion !== 1 || record.type !== 'pose' ||
      typeof record.sessionId !== 'string' || !record.sessionId.trim() ||
      !atLeast(record.seq, 1) || record.playerCount !== 2 ||
      !isObject(record.input) || !atLeast(record.input.width, 1) ||
      !atLeast(record.input.height, 1) || record.input.mirrored !== false ||
      typeof record.mediaTimeMs !== 'number' || !Number.isFinite(record.mediaTimeMs) || record.mediaTimeMs < 0 || record.mediaTimeMs > 3600000 ||
      !oneOf(TIMING_METHODS, record.timingMethod)) throw Error('Invalid video capture record');
  poseModel(record.modelId);
  assertPoses(record.poses);
}
export function validateVideoRecord(record: unknown): VideoRecord {
  assertVideoRecord(record);
  return record;
}
