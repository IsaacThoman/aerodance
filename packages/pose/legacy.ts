// Dance capture JSON from earlier versions, read only to convert it (tools/pose/migrate-legacy.ts).
import { assertPoses, finite, isArray, isObject, qualityFor } from './choreography.ts';
import type { PoseQuality } from './choreography.ts';
import type { MotionTake, TakeSample } from './motion.ts';

/** A legacy joint: x, y, z and the combined confidence. */
export type LegacyJoint = [x: number, y: number, z: number, confidence: number];
/** The pre-take dance capture format (version 1), accepted by explicit migration only. */
export interface LegacyMotion {
  version: 1; duration: number; times: number[];
  /** [sample][player][joint]: two players of 33 joints per sample. */
  poses: LegacyJoint[][][];
  source: { width: number; height: number; [key: string]: unknown };
  model?: unknown; settings?: unknown; report?: unknown;
}
export interface LegacyTakeSample extends TakeSample { quality: PoseQuality[]; }
export interface LegacyMigratedTake extends MotionTake {
  takeId: 'legacy-demo'; name: string; source: 'legacy-demo';
  offsetMs: 0; timeScale: 1; samples: LegacyTakeSample[];
  provenance: { source: LegacyMotion['source']; model: unknown; settings: unknown; report: unknown; legacySmoothed: true; limitations: string };
}

const dimension = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const unit = (v: unknown) => finite(v) && v >= 0 && v <= 1;
export function assertLegacyMotion(data: unknown): asserts data is LegacyMotion {
  if (!isObject(data) || data.version !== 1 || !finite(data.duration) || data.duration <= 0 ||
      !isArray(data.times) || data.times.length < 2 ||
      !isArray(data.poses) || data.times.length !== data.poses.length ||
      !isObject(data.source) || !dimension(data.source.width) || !dimension(data.source.height)) {
    throw Error('Invalid legacy dance capture');
  }
  const { duration, poses } = data;
  let previous = -Infinity;
  data.times.forEach((time, i) => {
    const sample = poses[i];
    if (!finite(time) || time < 0 || time >= duration ||
        time <= previous || !isArray(sample) || sample.length !== 2) throw Error('Invalid legacy samples');
    previous = time;
    for (const points of sample) {
      if (!isArray(points) || points.length !== 33) throw Error('Invalid legacy landmarks');
      for (const j of points) if (!isArray(j) || j.length !== 4 || !j.every(finite) || !unit(j[3])) throw Error('Invalid legacy landmark');
    }
  });
}
// Explicit import only. The tuple's combined confidence was smoothed with the positions, so
// it isn't kept: every joint's confidence is unknown.
export function migrateLegacyMotion(input: unknown): LegacyMigratedTake {
  assertLegacyMotion(input);
  const data = input;
  const samples = data.times.map((time, i): LegacyTakeSample => {
    const poses = data.poses[i].map((points, playerId) => ({ playerId, landmarks: points.map(([x,y,z]) => ({ x,y,z,confidence:null })) }));
    assertPoses(poses);
    return { takeTimeMs: time * 1000, poses, quality: qualityFor(poses) };
  });
  return {
    schema: 'aerodance.take', schemaVersion: 1, takeId: 'legacy-demo', name: 'Captured dance preview',
    source: 'legacy-demo', input: { width:data.source.width, height:data.source.height, mirrored:false },
    durationMs: data.duration * 1000, offsetMs:0, timeScale:1, samples,
    provenance: { source:data.source, model:data.model ?? null, settings:data.settings ?? null,
      report:data.report ?? null, legacySmoothed:true,
      limitations:'Legacy confidence is not kept; smoothed capture cannot recover original gaps or repairs.' },
  };
}

export function assertMotionTake(data: unknown): asserts data is MotionTake {
  if (!isObject(data) || data.schema !== 'aerodance.take' || data.schemaVersion !== 1 ||
      !finite(data.durationMs) || data.durationMs <= 0 ||
      !isObject(data.input) || !dimension(data.input.width) || !dimension(data.input.height) ||
      data.input.mirrored !== false || !isArray(data.samples) || data.samples.length < 2) throw Error('Invalid dance capture');
  const durationMs = data.durationMs;
  let last = -Infinity;
  for (const sample of data.samples) {
    if (!isObject(sample) || !finite(sample.takeTimeMs) || sample.takeTimeMs < 0 || sample.takeTimeMs >= durationMs || sample.takeTimeMs <= last) throw Error('Invalid dance times');
    last = sample.takeTimeMs;
    assertPoses(sample.poses);
  }
}
export function validateMotionTake(data: unknown): MotionTake {
  assertMotionTake(data);
  return data;
}
