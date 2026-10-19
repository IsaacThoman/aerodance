import { finite, isObject, isPlayerCount } from '../pose/choreography.ts';
import type { PlayerCount, Pose } from '../pose/choreography.ts';
import { isPoseModelId } from '../pose/browser/models.ts';
import type { PoseModelId } from '../pose/browser/models.ts';
import { validateWebcamRecord } from '../pose/webcamRecord.ts';
import type { WebcamRecord } from '../pose/webcamRecord.ts';
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
}

/**
 *   config  how many players to track and with which model
 *   game    whether a song is on (the phone dims its screen while one plays)
 *   ping    a clock round trip, answered with pong (packages/pairing/clock.ts)
 *   preview whether the game is showing a setup preview: the phone sends its video while on
 */
export type GameMessage =
  | { type: 'config'; playerCount: PlayerCount; modelId: PoseModelId }
  | { type: 'game'; playing: boolean }
  | { type: 'ping'; id: number; t0: number }
  | { type: 'preview'; on: boolean };
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
  if (m?.type === 'config' && isPlayerCount(m.playerCount) && isPoseModelId(m.modelId)) return { type: 'config', playerCount: m.playerCount, modelId: m.modelId };
  if (m?.type === 'game' && typeof m.playing === 'boolean') return { type: 'game', playing: m.playing };
  if (m?.type === 'ping' && Number.isSafeInteger(m.id) && finite(m.t0)) return { type: 'ping', id: m.id as number, t0: m.t0 };
  if (m?.type === 'preview' && typeof m.on === 'boolean') return { type: 'preview', on: m.on };
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
    return { type: 'status', status: m.status as WebcamStatus, message: m.message.slice(0, 300), model: m.model, delegate: m.delegate, facing: m.facing, inferenceMs: m.inferenceMs };
  }
  return null;
}

// Five decimals is a hundredth of a pixel at 640 px, and a third of the message.
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const unit = (n: number | null) => (n === null ? null : round(n, 3));

/** A pose record as the phone sends it: the same record, its landmarks rounded. */
export function poseMessage(record: WebcamRecord): string {
  const poses: Pose[] = record.poses.map((pose) => ({
    playerId: pose.playerId,
    landmarks: pose.landmarks.map((j) => ({ x: round(j.x, 5), y: round(j.y, 5), z: round(j.z, 5), visibility: unit(j.visibility), presence: unit(j.presence) })),
  }));
  return JSON.stringify({ type: 'pose', record: { ...record, poses } });
}
