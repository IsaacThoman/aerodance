import { finite, isObject, isPlayerCount, oneOf } from '../pose/choreography.ts';
import type { Landmark, PlayerCount, Point3 } from '../pose/choreography.ts';
import { isPoseModelId } from '../pose/browser/models.ts';
import type { PoseModelId } from '../pose/browser/models.ts';
import { HAND_TRACKING, isPoseDetail, validateWebcamRecord } from '../pose/webcamRecord.ts';
import type { HandTracking, LivePose, PoseDetail, WebcamRecord } from '../pose/webcamRecord.ts';
import type { WebcamStatus } from '../pose/browser/WebcamPoseSource.ts';
import type { PoseDelegate } from '../pose/browser/pose.worker.ts';

/*
 * What the game and a paired phone say over their WebRTC data channels. The phone tracks
 * the players and sends only their poses; the game sends its settings and clock pings.
 * While the game shows a setup preview, the phone also sends a small, low-frame-rate copy
 * of its camera on the connection's one video track (empty the rest of the time).
 *
 *   live     unordered, never resent: poses and clock pings, where a late one is useless
 *   control  reliable and in order: settings and the phone's status
 *
 * Both ends ignore what they don't know, so a game and a phone page of different versions (the
 * Apple TV app's game, the deployed site's phone page) still work together: a newer field in a
 * message is left out by an older end, and an older end's messages lack it.
 */

export const LIVE_CHANNEL = 'live';
export const CONTROL_CHANNEL = 'control';
/** The phone stops sending poses while this much is still queued on the live channel. */
export const MAX_LIVE_BUFFER = 64 * 1024;

/** Which way the phone's camera faces: towards its screen (user) or away (environment). */
export type Facing = 'user' | 'environment';
export const isFacing = (value: unknown): value is Facing => value === 'user' || value === 'environment';

/** The phone's tracker, as the game shows it. */
export interface PhoneStatus {
  type: 'status';
  status: WebcamStatus;
  message: string;
  model: PoseModelId;
  delegate: PoseDelegate | null;
  facing: Facing;
  inferenceMs: number | null;
  /** How the phone's hands are doing, while the game asks for them (config's detail); left out otherwise. */
  hands?: HandTracking;
}

/**
 *   config  how many players to track and with which model, and the detail a minigame asks
 *           for (left out without one: an older phone page ignores it)
 *   game    whether a song is on (the phone dims its screen while one plays)
 *   ping    a clock round trip, answered with pong (packages/pairing/clock.ts)
 *   preview whether the game is showing a setup preview: the phone sends its video while on
 *   reset-tracking a new song's line-up, without restarting the camera
 */
export type GameMessage =
  | { type: 'config'; playerCount: PlayerCount; modelId: PoseModelId; detail?: PoseDetail }
  | { type: 'game'; playing: boolean }
  | { type: 'ping'; id: number; t0: number }
  | { type: 'preview'; on: boolean }
  | { type: 'reset-tracking' };
/** A pose record's times are on the phone's clock. */
export type PhoneMessage =
  | PhoneStatus
  | { type: 'pose'; record: WebcamRecord }
  | { type: 'pong'; id: number; t0: number; t1: number };

const STATUSES: readonly WebcamStatus[] = ['disconnected', 'connecting', 'initializing', 'connected', 'error'];

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string' || data.length > 256 * 1024) return null;
  try {
    const value: unknown = JSON.parse(data);
    return isObject(value) ? value : null;
  } catch { return null; }
}

/** A message from the game, or null for anything else. */
export function parseGameMessage(data: unknown): GameMessage | null {
  const m = parse(data);
  // (A detail this phone doesn't know of is none.)
  if (m?.type === 'config' && isPlayerCount(m.playerCount) && isPoseModelId(m.modelId)) {
    return { type: 'config', playerCount: m.playerCount, modelId: m.modelId, ...(isPoseDetail(m.detail) ? { detail: m.detail } : {}) };
  }
  if (m?.type === 'game' && typeof m.playing === 'boolean') return { type: 'game', playing: m.playing };
  if (m?.type === 'ping' && Number.isSafeInteger(m.id) && finite(m.t0)) return { type: 'ping', id: m.id as number, t0: m.t0 };
  if (m?.type === 'preview' && typeof m.on === 'boolean') return { type: 'preview', on: m.on };
  if (m?.type === 'reset-tracking') return { type: 'reset-tracking' };
  return null;
}

/** A message from the phone (its pose records checked in full), or null for anything else. */
export function parsePhoneMessage(data: unknown): PhoneMessage | null {
  const m = parse(data);
  if (!m) return null;
  if (m.type === 'pose') {
    try { return { type: 'pose', record: validateWebcamRecord(m.record) }; } catch { return null; }
  }
  if (m.type === 'pong' && Number.isSafeInteger(m.id) && finite(m.t0) && finite(m.t1)) return { type: 'pong', id: m.id as number, t0: m.t0, t1: m.t1 };
  if (m.type === 'status' && STATUSES.includes(m.status as WebcamStatus) && typeof m.message === 'string' && isPoseModelId(m.model) &&
      (m.delegate === null || m.delegate === 'GPU' || m.delegate === 'CPU') && isFacing(m.facing) && (m.inferenceMs === null || finite(m.inferenceMs))) {
    return { type: 'status', status: m.status as WebcamStatus, message: m.message.slice(0, 300), model: m.model, delegate: m.delegate, facing: m.facing, inferenceMs: m.inferenceMs,
      ...(oneOf(HAND_TRACKING, m.hands) ? { hands: m.hands } : {}) };
  }
  return null;
}

// Five decimals is a hundredth of a pixel at 640 px, and a third of the message. The extras
// take four: a tenth of a millimetre in the world landmarks, a tenth of a pixel in a hand's
// points (each record with them is about 5 KB more).
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const unit = (n: number | null) => (n === null ? null : round(n, 3));
const landmark = (j: Landmark, places: number): Landmark => ({ x: round(j.x, places), y: round(j.y, places), z: round(j.z, places), confidence: unit(j.confidence) });
const point = (p: Point3): Point3 => ({ x: round(p.x, 4), y: round(p.y, 4), z: round(p.z, 4) });

/** A pose record as the phone sends it: the same record, its landmarks (and any world landmarks and hands) rounded. */
export function poseMessage(record: WebcamRecord): string {
  const poses: LivePose[] = record.poses.map((pose) => ({
    playerId: pose.playerId,
    landmarks: pose.landmarks.map((j) => landmark(j, 5)),
    ...(pose.world ? { world: pose.world.map(point) } : {}),
    ...(pose.hands ? { hands: pose.hands.map((hand) => ({ side: hand.side, landmarks: hand.landmarks.map((j) => landmark(j, 4)), world: hand.world.map(point), score: unit(hand.score)! })) } : {}),
  }));
  return JSON.stringify({ type: 'pose', record: { ...record, poses } });
}
