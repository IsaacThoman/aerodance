// The webcam capture record WebcamPoseSource emits, and its validation.
import { MAX_PLAYERS, assertPoses, finite, isArray, isObject, isPlayerCount, oneOf } from './choreography.ts';
import type { CaptureInput, Landmark, PlayerCount, Point3, Pose } from './choreography.ts';
import { poseModel } from './browser/models.ts';
import type { PoseModelId } from './browser/models.ts';

/**
 * How a record's browser times were measured: the frame observed in this browser, or in a
 * paired phone's browser and moved onto this one's clock (packages/pairing/clock.ts).
 */
export type WebcamTimingMethod = 'browser-frame-observation' | 'remote-clock-sync';
export const WEBCAM_TIMING_METHODS: readonly WebcamTimingMethod[] = ['browser-frame-observation', 'remote-clock-sync'];

/**
 * Extra tracking a game can ask a live source for (PoseSource.setDetail in apps/web). 'world'
 * keeps MediaPipe's 3D world landmarks with each pose; 'hands' does too and, with one player,
 * runs the Hand Landmarker on their wrists, which costs tracking time. The songs never ask for
 * either, so their records stay as they were.
 */
export type PoseDetail = 'world' | 'hands';
export const POSE_DETAILS: readonly PoseDetail[] = ['world', 'hands'];
export const isPoseDetail = (value: unknown): value is PoseDetail => POSE_DETAILS.includes(value as PoseDetail);
/**
 * The hands, while they're asked for: their model loading, running, dropped by a phone too slow
 * to run it (the world landmarks carry on), or not to be had (more than one player, a replay, a
 * model that wouldn't load, a phone page too old to know of it).
 */
export type HandTracking = 'loading' | 'on' | 'dropped' | 'unavailable';
export const HAND_TRACKING: readonly HandTracking[] = ['loading', 'on', 'dropped', 'unavailable'];
export type HandSide = 'left' | 'right';
const HAND_SIDES: readonly HandSide[] = ['left', 'right'];
/** MediaPipe's hand landmarks: the wrist, then four points up each of the thumb and fingers. */
export const HAND_POINTS = 21;

/** A hand the Hand Landmarker found at a pose's wrist. */
export interface TrackedHand {
  /** Whose hand it is: the player's own left or right. */
  side: HandSide;
  /**
   * Its 21 points in the whole picture (0-1), unmirrored like a pose's landmarks, z from the
   * wrist in x's scale. The Hand Landmarker gives no confidence per point, so it's null.
   */
  landmarks: Landmark[];
  /** The same points in metres, round the hand's middle (x to the picture's right, y down, z away from the camera). */
  world: Point3[];
  /** How sure the Hand Landmarker is that it's a `side` hand, 0-1. */
  score: number;
}
/**
 * A pose from a live source: a song's Pose and, with the 'hands' detail, MediaPipe's 33 world
 * landmarks (metres from the hips' centre: x to the picture's right, y down, z away from the
 * camera) and, with one player, the hands found at their wrists (an empty list: none found).
 */
export interface LivePose extends Pose {
  world?: Point3[];
  hands?: TrackedHand[];
}

/** One webcam tracking result, timed by the browser frame it was measured from. */
export interface WebcamRecord {
  schema: 'aerodance.webcam-record'; schemaVersion: 1; type: 'pose';
  sessionId: string; seq: number; playerCount: PlayerCount;
  /** Always unmirrored. */
  input: CaptureInput;
  modelId: PoseModelId;
  mediaTimeMs: number; frameBrowserTimeMs: number; resultBrowserTimeMs: number;
  timingMethod: WebcamTimingMethod;
  poses: LivePose[];
}

const points3 = (value: unknown, count: number) => isArray(value) && value.length === count &&
  value.every(p => isObject(p) && finite(p.x) && finite(p.y) && finite(p.z));
const unit = (n: unknown) => finite(n) && n >= 0 && n <= 1;
/** Whether a value is a whole TrackedHand: its side, 21 points of each kind, a score. */
export const isTrackedHand = (hand: unknown): hand is TrackedHand => isObject(hand) && oneOf(HAND_SIDES, hand.side) && unit(hand.score) &&
  points3(hand.world, HAND_POINTS) && points3(hand.landmarks, HAND_POINTS) &&
  (hand.landmarks as Record<string, unknown>[]).every(p => p.confidence === null || unit(p.confidence));
/**
 * Validates live poses: a song's poses (assertPoses, up to maxPlayers), and the world landmarks
 * and hands of any that have them. A pose without them is as valid as ever.
 */
export function assertLivePoses(poses: unknown, maxPlayers = MAX_PLAYERS): asserts poses is LivePose[] {
  assertPoses(poses, maxPlayers);
  for (const pose of poses as (Pose & Record<string, unknown>)[]) {
    if (pose.world !== undefined && !points3(pose.world, 33)) throw Error('World landmarks need all 33 points');
    const { hands } = pose;
    if (hands !== undefined && (!isArray(hands) || hands.length > 2 || !hands.every(isTrackedHand) ||
        new Set(hands.map(hand => (hand as TrackedHand).side)).size !== hands.length)) throw Error('Invalid tracked hands');
  }
}

const atLeast = (n: unknown, min: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const time = (n: unknown): n is number => finite(n) && n >= 0;
export function assertWebcamRecord(record: unknown): asserts record is WebcamRecord {
  const invalid = () => Error('Invalid webcam capture record');
  if (!isObject(record)) throw invalid();
  const { frameBrowserTimeMs, resultBrowserTimeMs, mediaTimeMs, input } = record;
  if (record.schema !== 'aerodance.webcam-record' || record.schemaVersion !== 1 || record.type !== 'pose' ||
      typeof record.sessionId !== 'string' || !record.sessionId.trim() ||
      !atLeast(record.seq, 1) || !isPlayerCount(record.playerCount) ||
      !isObject(input) || !atLeast(input.width, 1) || !atLeast(input.height, 1) || input.mirrored !== false ||
      !time(frameBrowserTimeMs) || !time(resultBrowserTimeMs) || !time(mediaTimeMs) ||
      resultBrowserTimeMs < frameBrowserTimeMs || !oneOf(WEBCAM_TIMING_METHODS, record.timingMethod)) {
    throw invalid();
  }
  poseModel(record.modelId);
  const { poses, playerCount } = record;
  assertLivePoses(poses, MAX_PLAYERS);
  if (poses.some(pose => pose.playerId >= playerCount)) throw Error('Invalid webcam player ID');
}
export function validateWebcamRecord(record: unknown): WebcamRecord {
  assertWebcamRecord(record);
  return record;
}
