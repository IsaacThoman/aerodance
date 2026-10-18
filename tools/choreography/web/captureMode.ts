import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';

export type CaptureMode = 'both' | 'p1' | 'p2';
export const capturePlayers = (mode: CaptureMode): number[] => mode === 'both' ? [0, 1] : [mode === 'p1' ? 0 : 1];
export const detectionCount = (mode: CaptureMode): PlayerCount => mode === 'both' ? 2 : 1;
/** Solo inference always uses slot zero; authoring can send it to either track. */
export const capturePoses = (poses: readonly Pose[], mode: CaptureMode): Pose[] =>
  mode === 'both' ? [...poses] : poses.filter(p => p.playerId === 0).map(p => ({ ...p, playerId: mode === 'p1' ? 0 : 1 }));
