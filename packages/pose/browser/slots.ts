import { MAX_PLAYERS, validatePoses } from '../choreography.ts';
import type { Landmark, PlayerCount, Pose } from '../choreography.ts';

/** A landmark as a detector reports it (MediaPipe's NormalizedLandmark); confidences may be unset. */
export interface DetectedLandmark { x: number; y: number; z: number; visibility?: number | null; presence?: number | null; }
/** The one confidence stored per joint: min(visibility, presence), null when either is unset. */
export const detectedConfidence = (p: DetectedLandmark) => p.visibility == null || p.presence == null ? null : Math.min(p.visibility, p.presence);

/**
 * The player whose lane a hip centre x (unmirrored, 0-1) falls in, or null near a lane edge.
 * Lanes split the picture evenly; the mirrored preview shows P1 on the left, so P1's lane is
 * on the camera's right.
 */
export function laneOf(x: number, playerCount: PlayerCount, deadBand = 0.025): number | null {
  const at = x * playerCount;
  const lane = Math.min(playerCount - 1, Math.max(0, Math.floor(at)));
  const edge = Math.min(lane > 0 ? at - lane : Infinity, lane < playerCount - 1 ? lane + 1 - at : Infinity) / playerCount;
  return edge <= deadBand ? null : playerCount - 1 - lane;
}

// Regions, not identities: unreliable/competing detections never fill another slot.
export function assignPlayerSlots(detections: readonly (readonly DetectedLandmark[])[], playerCount: PlayerCount, deadBand = 0.025): Pose[] {
  const candidates: Landmark[][][] = Array.from({ length: playerCount }, () => []);
  for (const points of detections) {
    const landmarks = points.map(p => ({ x: p.x, y: p.y, z: p.z, confidence: detectedConfidence(p) }));
    try { validatePoses([{ playerId: 0, landmarks }]); } catch { continue; }
    const torso = [11, 12, 23, 24].map(i => landmarks[i]);
    if (torso.some(p => p.confidence === null || p.confidence < 0.5)) continue;
    const lane = laneOf((landmarks[23].x + landmarks[24].x) / 2, playerCount, deadBand);
    if (lane !== null) candidates[lane].push(landmarks);
  }
  return candidates.flatMap((poses, playerId) => poses.length === 1 ? [{ playerId, landmarks: poses[0] }] : []);
}

export class PlayerSlotMapper {
  streaks: number[];
  constructor() { this.streaks = Array<number>(MAX_PLAYERS).fill(0); }
  map(detections: readonly (readonly DetectedLandmark[])[], playerCount: PlayerCount): Pose[] {
    const poses = assignPlayerSlots(detections, playerCount);
    for (let id = 0; id < MAX_PLAYERS; id++) this.streaks[id] = poses.some(p => p.playerId === id) ? Math.min(2, this.streaks[id] + 1) : 0;
    // Require consecutive evidence when acquiring a lane shared with other players. Loss is immediate.
    return poses.filter(p => playerCount === 1 || this.streaks[p.playerId] >= 2);
  }
}
