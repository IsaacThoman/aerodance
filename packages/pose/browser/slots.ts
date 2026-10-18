import { validatePoses } from '../choreography.ts';
import type { Landmark, PlayerCount, Pose } from '../choreography.ts';

/** A landmark as a detector reports it (MediaPipe's NormalizedLandmark); confidences may be unset. */
export interface DetectedLandmark { x: number; y: number; z: number; visibility?: number | null; presence?: number | null; }
/** The one confidence stored per joint: min(visibility, presence), null when either is unset. */
export const detectedConfidence = (p: DetectedLandmark) => p.visibility == null || p.presence == null ? null : Math.min(p.visibility, p.presence);

// Regions, not identities: unreliable/competing detections never fill another slot.
export function assignPlayerSlots(detections: readonly (readonly DetectedLandmark[])[], playerCount: PlayerCount, deadBand = 0.025): Pose[] {
  const candidates: Landmark[][][] = [[], []];
  for (const points of detections) {
    const landmarks = points.map(p => ({ x: p.x, y: p.y, z: p.z, confidence: detectedConfidence(p) }));
    try { validatePoses([{ playerId: 0, landmarks }]); } catch { continue; }
    const torso = [11, 12, 23, 24].map(i => landmarks[i]);
    if (torso.some(p => p.confidence === null || p.confidence < 0.5)) continue;
    const x = (landmarks[23].x + landmarks[24].x) / 2;
    if (playerCount === 2 && Math.abs(x - 0.5) <= deadBand) continue;
    candidates[playerCount === 1 ? 0 : x < 0.5 ? 1 : 0].push(landmarks);
  }
  return candidates.flatMap((poses, playerId) => poses.length === 1 ? [{ playerId, landmarks: poses[0] }] : []);
}

export class PlayerSlotMapper {
  streaks: [number, number];
  constructor() { this.streaks = [0, 0]; }
  map(detections: readonly (readonly DetectedLandmark[])[], playerCount: PlayerCount): Pose[] {
    const poses = assignPlayerSlots(detections, playerCount);
    for (let id = 0; id < 2; id++) this.streaks[id] = poses.some(p => p.playerId === id) ? Math.min(2, this.streaks[id] + 1) : 0;
    // Require consecutive evidence when acquiring a two-player region. Loss is immediate.
    return poses.filter(p => playerCount === 1 || this.streaks[p.playerId] >= 2);
  }
}
