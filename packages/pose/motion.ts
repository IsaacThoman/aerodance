// The menu and celebration dancers' looping capture, stored as a take .adpose file.
import { decodePoseFile, encodePoseFile, framesFromSamples, framesToSamples } from './binary.ts';
import { isObject } from './choreography.ts';
import type { CaptureInput, Pose, PoseQuality } from './choreography.ts';

/** A take sample on the take's own clock (ms from the start of the capture). */
export interface TakeSample { takeTimeMs: number; poses: Pose[]; quality?: PoseQuality[]; }
/** A looping dance capture: what menu and celebration playback relies on. */
export interface MotionTake {
  schema: 'aerodance.take'; schemaVersion: 1;
  durationMs: number;
  /** Always unmirrored. */
  input: CaptureInput;
  samples: TakeSample[];
  /** Free-form capture details. */
  provenance?: unknown;
}

/**
 * A motion take as a file. A take file has no duration, so the loop length goes in its
 * provenance as `durationMs`, as video takes record the video's.
 */
export function encodeMotion(take: MotionTake): Uint8Array<ArrayBuffer> {
  return encodePoseFile(framesFromSamples({
    kind: 'take', playerSlots: 2, input: { width: take.input.width, height: take.input.height }, modelId: null,
    provenance: { ...(isObject(take.provenance) ? take.provenance : {}), durationMs: take.durationMs },
  }, take.samples, 'takeTimeMs'));
}
/** A take file as a looping motion take; without a recorded duration the loop ends one frame after the last. */
export function decodeMotion(bytes: Uint8Array): MotionTake {
  const f = decodePoseFile(bytes), n = f.times.length;
  if (f.kind !== 'take' || n < 2) throw Error('Invalid dance capture');
  const last = f.times[n - 1], recorded = isObject(f.provenance) ? f.provenance.durationMs : undefined;
  const durationMs = typeof recorded === 'number' && recorded > last ? recorded : last + (last - f.times[0]) / (n - 1);
  return {
    schema: 'aerodance.take', schemaVersion: 1, durationMs,
    input: { width: f.input.width, height: f.input.height, mirrored: false },
    samples: framesToSamples(f, 'takeTimeMs'),
    ...(f.provenance === undefined ? {} : { provenance: f.provenance }),
  };
}
