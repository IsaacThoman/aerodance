import { MAX_DANCERS } from '../../../packages/pose/choreography.ts';
import type { PlayerCount, Pose } from '../../../packages/pose/choreography.ts';

/**
 * Who a capture records: every dancer the song has, each in their own part of the picture
 * ('all'), or one dancer anywhere in the whole frame, saved as P1 to P4. Takes from earlier
 * editors name a duet's 'both'.
 */
export type CaptureMode = 'all' | 'p1' | 'p2' | 'p3' | 'p4';
const SOLO_MODES = ['p1', 'p2', 'p3', 'p4'] as const;
/** The dancer a solo capture records, or null when it records everyone. */
export const soloPlayer = (mode: CaptureMode): number | null => mode === 'all' ? null : Number(mode[1]) - 1;
/** The dancers a capture records for a song with `dancers` dancers. */
export const capturePlayers = (mode: CaptureMode, dancers = 2): number[] => {
  const solo = soloPlayer(mode);
  return solo === null ? Array.from({ length: dancers }, (_, id) => id) : [solo];
};
/** How many people the tracker looks for. */
export const detectionCount = (mode: CaptureMode, dancers = 2): PlayerCount =>
  (soloPlayer(mode) === null ? dancers : 1) as PlayerCount;
/** The capture file's pose slots: one per dancer, or up to a solo dancer's own. */
export const captureSlots = (mode: CaptureMode, dancers = 2): PlayerCount =>
  (soloPlayer(mode) === null ? dancers : soloPlayer(mode)! + 1) as PlayerCount;
/** The modes a song with `dancers` dancers offers: all of them (with two or more), then each alone. */
export const captureModes = (dancers: number): CaptureMode[] =>
  [...(dancers > 1 ? ['all' as const] : []), ...SOLO_MODES.slice(0, Math.min(dancers, MAX_DANCERS))];
export const isCaptureMode = (v: unknown): v is CaptureMode => v === 'all' || SOLO_MODES.some(m => m === v);
/** A mode's label in the players menus. */
export const captureModeLabel = (mode: CaptureMode, dancers: number) => {
  const solo = soloPlayer(mode);
  return solo !== null ? `P${solo + 1} only` : dancers === 2 ? 'Both players' : `All ${dancers} dancers`;
};
/** Solo inference always uses slot zero; authoring can send it to any track. */
export const capturePoses = (poses: readonly Pose[], mode: CaptureMode): Pose[] => {
  const solo = soloPlayer(mode);
  return solo === null ? [...poses] : poses.filter(p => p.playerId === 0).map(p => ({ ...p, playerId: solo }));
};
/** This mode if a song with `dancers` dancers has it, else all of them (one dancer: P1). */
export const fittingMode = (mode: CaptureMode, dancers: number): CaptureMode =>
  captureModes(dancers).includes(mode) ? mode : captureModes(dancers)[0];
