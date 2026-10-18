// Pose payloads ({ playerId, landmarks }); file clocks are explicitly separate from wire clocks.

/** One MediaPipe pose-33 landmark in image space; confidence is min(visibility, presence), null when unknown. */
export interface Landmark { x: number; y: number; z: number; confidence: number | null; }
/** One dancer: playerId 0 (P1) or 1 (P2) and all 33 landmarks. */
export interface Pose { playerId: number; landmarks: Landmark[]; }
export type PlayerCount = 1 | 2;
export interface Point3 { x: number; y: number; z: number; }
export interface FrameSize { width: number; height: number; }
/** The camera or video frame the landmarks were measured in. */
export interface CaptureInput extends FrameSize { mirrored: boolean; }
export type LandmarkOrigin = 'measured' | 'resampled' | 'edited' | 'gap-repaired' | 'missing-confidence';
export interface PoseQuality { playerId: number; landmarkOrigins: LandmarkOrigin[]; scoreEligible: boolean[]; reviewed: boolean; }
/** The poses at one instant, with a quality mask per pose. */
export interface PoseSnapshot { poses: Pose[]; quality: PoseQuality[]; }
export type TimeKey = 'songTimeMs' | 'takeTimeMs';
/** A pose sample on a song or take clock. */
export type TimedPoses<K extends TimeKey> = Record<K, number> & { poses: Pose[]; quality?: PoseQuality[]; };

/** A dancer's neutral stance and the frame it was measured in; drives the pose applier. */
export interface TrackCalibration {
  inputWidth: number; inputHeight: number; torsoLength: number; baseHip: Point3; floorY: number; profileVersion: number;
  /** Webcam/video calibrations (profile 2): character scale follows the dancer's camera distance. */
  cameraScaleMode?: 'body-relative';
  bodyTorsoLength?: number;
}
export interface ChoreographyTrack { playerId: number; calibration: TrackCalibration; }
export interface ChoreographySample { songTimeMs: number; poses: Pose[]; quality: PoseQuality[]; }
export interface ChoreographyCoordinates { kind: 'mediapipe-image'; mirrored: false; landmarkCount: 33; }
/** aerodance.choreography v1: both tracks on the song clock. */
export interface Choreography {
  schema: 'aerodance.choreography'; schemaVersion: 1;
  durationMs: number; playableStartMs: number; playableEndMs: number;
  coordinates: ChoreographyCoordinates;
  /** Exactly two, for players 0 and 1 in order. */
  tracks: ChoreographyTrack[];
  samples: ChoreographySample[];
}

export const JOINT_NAMES: readonly string[] = ['Nose','Left eye inner','Left eye','Left eye outer','Right eye inner','Right eye','Right eye outer','Left ear','Right ear','Mouth left','Mouth right','Left shoulder','Right shoulder','Left elbow','Right elbow','Left wrist','Right wrist','Left pinky','Right pinky','Left index','Right index','Left thumb','Right thumb','Left hip','Right hip','Left knee','Right knee','Left ankle','Right ankle','Left heel','Right heel','Left foot index','Right foot index'];
export const CONNECTIONS: readonly (readonly [number, number])[] = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[28,30],[30,32],[15,17],[15,19],[16,18],[16,20],[0,7],[0,8]];
export const PAIRS: readonly (readonly [number, number])[] = [[1,4],[2,5],[3,6],[7,8],[9,10],[11,12],[13,14],[15,16],[17,18],[19,20],[21,22],[23,24],[25,26],[27,28],[29,30],[31,32]];
const ORIGINS: readonly LandmarkOrigin[] = ['measured','resampled','edited','gap-repaired','missing-confidence'];
const KEPT_ORIGINS: readonly LandmarkOrigin[] = ['edited','gap-repaired','missing-confidence'];
export const copy = <T>(value: T): T => structuredClone(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
/** Narrowing helpers for validating untrusted JSON. */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
export const oneOf = <T>(values: readonly T[], value: unknown): value is T => values.some(v => v === value);
export const isPlayerCount = (value: unknown): value is PlayerCount => value === 1 || value === 2;
function fail(message: string): never { throw Error(message); }
const unitOrNull = (v: unknown) => v === null || finite(v) && v >= 0 && v <= 1;

// Older JSON stores MediaPipe's visibility and presence separately; they are combined in place.
function upgradeLandmark(joint: Record<string, unknown>) {
  if ('confidence' in joint || !('visibility' in joint || 'presence' in joint)) return;
  const { visibility, presence } = joint;
  if (!unitOrNull(visibility) || !unitOrNull(presence)) fail('Confidence must be null or between 0 and 1');
  joint.confidence = visibility === null || presence === null ? null : Math.min(Number(visibility), Number(presence));
  delete joint.visibility; delete joint.presence;
}
/** Validates poses, converting legacy visibility/presence landmarks to a single confidence in place. */
export function assertPoses(poses: unknown): asserts poses is Pose[] {
  if (!isArray(poses) || poses.length > 2) fail('Expected at most two poses');
  let last = -1;
  for (const pose of poses) {
    if (!isObject(pose) || (pose.playerId !== 0 && pose.playerId !== 1) || pose.playerId <= last) fail('Pose IDs must be unique and ascending');
    last = pose.playerId;
    if (!isArray(pose.landmarks) || pose.landmarks.length !== 33) fail('A pose needs all 33 landmarks');
    for (const joint of pose.landmarks) {
      if (!isObject(joint) || !finite(joint.x) || !finite(joint.y) || !finite(joint.z)) fail('Landmark coordinates must be finite');
      upgradeLandmark(joint);
      if (!unitOrNull(joint.confidence)) fail('Confidence must be null or between 0 and 1');
    }
  }
}
export function validatePoses(poses: unknown): Pose[] {
  assertPoses(poses);
  return poses;
}
export const confidence = (p: Landmark) => p.confidence;
export function qualityFor(poses: readonly Pose[], origin: LandmarkOrigin = 'measured'): PoseQuality[] {
  return poses.map(p => ({ playerId: p.playerId, landmarkOrigins: p.landmarks.map(j => confidence(j) === null ? 'missing-confidence' : origin), scoreEligible: p.landmarks.map(j => { const c = confidence(j); return origin === 'measured' && c !== null && c >= .5; }), reviewed: false }));
}
const lerpOrNull = (a: number | null, b: number | null, alpha: number) => a === null || b === null ? null : a + (b - a) * alpha;
type AnyTimedPoses = TimedPoses<'songTimeMs'> | TimedPoses<'takeTimeMs'>;
const timeOf = (s: AnyTimedPoses, key: TimeKey) => key === 'songTimeMs' ? ('songTimeMs' in s ? s.songTimeMs : NaN) : ('takeTimeMs' in s ? s.takeTimeMs : NaN);
/** The snapshot at timeMs: exact samples are copied, neighbours closer than maxGap interpolated. */
export function sampleSnapshot(samples: readonly TimedPoses<'songTimeMs'>[], timeMs: number, timeKey?: 'songTimeMs', maxGap?: number): PoseSnapshot;
export function sampleSnapshot(samples: readonly TimedPoses<'takeTimeMs'>[], timeMs: number, timeKey: 'takeTimeMs', maxGap?: number): PoseSnapshot;
export function sampleSnapshot(samples: readonly AnyTimedPoses[], timeMs: number, timeKey: TimeKey = 'songTimeMs', maxGap = 200): PoseSnapshot {
  const at = (i: number) => timeOf(samples[i], timeKey);
  if (!samples.length || timeMs < at(0)-1e-5 || timeMs > at(samples.length - 1)+1e-5) return { poses: [], quality: [] };
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (at(mid) <= timeMs) lo = mid; else hi = mid - 1; }
  const a = samples[lo], b: AnyTimedPoses | undefined = samples[lo + 1];
  if (Math.abs(at(lo)-timeMs)<1e-5) return copy({ poses: a.poses, quality: a.quality || qualityFor(a.poses) });
  if (b&&Math.abs(at(lo + 1)-timeMs)<1e-5) return copy({ poses: b.poses, quality: b.quality || qualityFor(b.poses) });
  if (!b || at(lo + 1) - at(lo) > maxGap) return { poses: [], quality: [] };
  return interpolatePoses(a, b, (timeMs - at(lo)) / (at(lo + 1) - at(lo)));
}
/** The poses alpha of the way from a to b: absence is never interpolated across, kept origins propagate. */
export function interpolatePoses(a: { poses: Pose[]; quality?: PoseQuality[] }, b: { poses: Pose[]; quality?: PoseQuality[] }, alpha: number): PoseSnapshot {
  const poses: Pose[] = [], quality: PoseQuality[] = [];
  for (const pose of a.poses) {
    const next = b.poses.find(p => p.playerId === pose.playerId);
    if (!next) continue; // Absence is never interpolated across.
    const qa = (a.quality || qualityFor(a.poses)).find(q => q.playerId === pose.playerId);
    const qb = (b.quality || qualityFor(b.poses)).find(q => q.playerId === pose.playerId);
    if (!qa || !qb) throw TypeError('Missing pose quality');
    poses.push({ playerId: pose.playerId, landmarks: pose.landmarks.map((p,i) => {
      const q = next.landmarks[i];
      return { x: p.x + (q.x-p.x)*alpha, y: p.y + (q.y-p.y)*alpha, z: p.z + (q.z-p.z)*alpha,
        confidence: lerpOrNull(p.confidence, q.confidence, alpha) };
    }) });
    quality.push({ playerId: pose.playerId, landmarkOrigins: qa.landmarkOrigins.map((origin,i) => interpolatedOrigin(origin, qb.landmarkOrigins[i])), scoreEligible: qa.scoreEligible.map((v,i) => v && qb.scoreEligible[i]), reviewed: qa.reviewed && qb.reviewed });
  }
  return { poses, quality };
}
/** An interpolated joint keeps an edited, repaired or missing-confidence origin from either neighbour. */
export const interpolatedOrigin = (a: LandmarkOrigin, b: LandmarkOrigin): LandmarkOrigin =>
  KEPT_ORIGINS.includes(a) ? a : KEPT_ORIGINS.includes(b) ? b : 'resampled';
export function mirrorPose<T extends { landmarks: Landmark[] }>(pose: T): T {
  const result = copy(pose);
  result.landmarks.forEach(p => { p.x = 1-p.x; });
  for (const [a,b] of PAIRS) [result.landmarks[a],result.landmarks[b]] = [result.landmarks[b],result.landmarks[a]];
  return result;
}
const positive = (v: unknown) => finite(v) && v > 0;
export function assertChoreography(data: unknown): asserts data is Choreography {
  if (!isObject(data) || data.schema !== 'aerodance.choreography' || data.schemaVersion !== 1) fail('Unsupported choreography schema');
  const { durationMs, playableStartMs, playableEndMs } = data;
  if (!finite(durationMs) || durationMs <= 0 || !finite(playableStartMs) || !finite(playableEndMs) || playableStartMs < 0 || playableStartMs >= playableEndMs || playableEndMs > durationMs) fail('Invalid song bounds');
  if (!isObject(data.coordinates) || data.coordinates.kind !== 'mediapipe-image' || data.coordinates.mirrored !== false || data.coordinates.landmarkCount !== 33) fail('Unsupported coordinate convention');
  const tracks = data.tracks;
  if (!isArray(tracks) || tracks.length !== 2 || !isObject(tracks[0]) || tracks[0].playerId !== 0 || !isObject(tracks[1]) || tracks[1].playerId !== 1) fail('Both tracks are required');
  for (const track of tracks) {
    const c = isObject(track) ? track.calibration : undefined;
    if (!isObject(c) || !positive(c.inputWidth) || !positive(c.inputHeight) || !positive(c.torsoLength) || !finite(c.floorY) || !isObject(c.baseHip) || !finite(c.baseHip.x) || !finite(c.baseHip.y) || !finite(c.baseHip.z)) fail('Invalid track calibration');
    if(c.cameraScaleMode!==undefined && c.cameraScaleMode!=='body-relative') fail('Unsupported camera scale mode');
    if(c.cameraScaleMode==='body-relative' && !positive(c.bodyTorsoLength)) fail('Invalid body-relative calibration');
  }
  const samples = data.samples;
  if (!isArray(samples) || samples.length < 2) fail('Choreography needs at least two samples');
  let last = -Infinity;
  for (const sample of samples) {
    if (!isObject(sample) || !finite(sample.songTimeMs) || sample.songTimeMs <= last || sample.songTimeMs < playableStartMs || sample.songTimeMs > playableEndMs) fail('Invalid sample times');
    last = sample.songTimeMs;
    const poses = sample.poses, quality = sample.quality;
    assertPoses(poses);
    if (!isArray(quality) || quality.length !== poses.length) fail('Missing pose quality');
    poses.forEach((p,i) => {
      const q = quality[i];
      if (!isObject(q) || q.playerId !== p.playerId || !isArray(q.landmarkOrigins) || q.landmarkOrigins.length !== 33 || !isArray(q.scoreEligible) || q.scoreEligible.length !== 33 || typeof q.reviewed !== 'boolean' || q.scoreEligible.some(v => typeof v !== 'boolean') || q.landmarkOrigins.some(v => !oneOf(ORIGINS, v))) fail('Invalid quality masks');
    });
  }
  const firstSample = samples[0], lastSample = samples[samples.length - 1];
  if (!isObject(firstSample) || firstSample.songTimeMs !== playableStartMs || !isObject(lastSample) || lastSample.songTimeMs !== playableEndMs) fail('Missing endpoint anchors');
}
export function validateChoreography(data: unknown): Choreography {
  assertChoreography(data);
  return data;
}
