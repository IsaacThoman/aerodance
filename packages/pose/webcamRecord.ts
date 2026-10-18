// Server-safe webcam capture validation. These records are not protocol-v2 wire records.
import { assertPoses, finite, isObject, oneOf } from './choreography.ts';
import type { CaptureInput, PlayerCount, Pose } from './choreography.ts';
import { poseModel } from './browser/models.ts';
import type { PoseModelId } from './browser/models.ts';

/**
 * How a record's browser times were measured: the frame observed in this browser, or in a
 * paired phone's browser and moved onto this one's clock (packages/pairing/clock.ts).
 */
export type WebcamTimingMethod = 'browser-frame-observation' | 'remote-clock-sync';
export const WEBCAM_TIMING_METHODS: readonly WebcamTimingMethod[] = ['browser-frame-observation', 'remote-clock-sync'];

/** One webcam tracking result, timed by the browser frame it was measured from. */
export interface WebcamRecord {
  schema: 'aerodance.webcam-record'; schemaVersion: 1; type: 'pose';
  sessionId: string; seq: number; playerCount: PlayerCount;
  /** Always unmirrored. */
  input: CaptureInput;
  modelId: PoseModelId;
  mediaTimeMs: number; frameBrowserTimeMs: number; resultBrowserTimeMs: number;
  timingMethod: WebcamTimingMethod;
  poses: Pose[];
}
const atLeast = (n: unknown, min: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const time = (n: unknown): n is number => finite(n) && n >= 0;
export function assertWebcamRecord(record: unknown): asserts record is WebcamRecord {
  const invalid = () => Error('Invalid webcam capture record');
  if (!isObject(record)) throw invalid();
  const { frameBrowserTimeMs, resultBrowserTimeMs, mediaTimeMs, input } = record;
  if (record.schema !== 'aerodance.webcam-record' || record.schemaVersion !== 1 || record.type !== 'pose' ||
      typeof record.sessionId !== 'string' || !record.sessionId.trim() ||
      !atLeast(record.seq, 1) || (record.playerCount !== 1 && record.playerCount !== 2) ||
      !isObject(input) || !atLeast(input.width, 1) || !atLeast(input.height, 1) || input.mirrored !== false ||
      !time(frameBrowserTimeMs) || !time(resultBrowserTimeMs) || !time(mediaTimeMs) ||
      resultBrowserTimeMs < frameBrowserTimeMs || !oneOf(WEBCAM_TIMING_METHODS, record.timingMethod)) {
    throw invalid();
  }
  poseModel(record.modelId);
  const { poses, playerCount } = record;
  assertPoses(poses);
  if (poses.some(pose => pose.playerId >= playerCount)) throw Error('Invalid webcam player ID');
}
export function validateWebcamRecord(record: unknown): WebcamRecord {
  assertWebcamRecord(record);
  return record;
}
