import { Suspense, useMemo } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import Character from '../../character/Character.tsx';
import type { CharacterAppearance } from '../../character/Character.tsx';
import { sampleSong } from '../../pose/song.ts';
import { firstPresentFrame, framesToPoses } from '../../pose/binary.ts';
import type { Pose } from '../../pose/choreography.ts';
import type { MotionTake } from '../../pose/legacy.ts';
import type { DancerPlacement } from '../catalog.ts';
import DancerEntrance from './DancerEntrance.tsx';
import type { DancerRoutine } from './routine.ts';

export type { DancerRoutine };

export type DancerLook = CharacterAppearance;

// A little more solid than the menu's dancers (default gel opacity 0.72) so they
// hold up against busy stage backgrounds.
export const DANCER_LOOKS: readonly DancerLook[] = [
  { color: '#078fff', gloss: 85, accessory: 'None', opacity: 0.85 },
  { color: '#b86bff', gloss: 85, accessory: 'None', opacity: 0.85 },
];

// The rig's feet rest about this far above the group origin's floor.
const FOOT_CLEARANCE = 0.015;

// One pose ref per player, sampled from a song's choreography at its current time each frame.
function useRoutinePoses(routine: DancerRoutine | null | undefined): RefObject<Pose | null>[] {
  const refs = useMemo((): RefObject<Pose | null>[] => [{ current: null }, { current: null }], []);
  const opening = useMemo((): ({ time: number; pose: Pose } | null)[] => {
    if (!routine?.entranceTimeMs) return [];
    const { song, choreography } = routine.bundle;
    // Capture/export can leave a few empty frames before the first pose. Prepare that
    // pose for the entrance, but never fill a longer tracking gap or change scoring.
    return [0, 1].map((id) => {
      const frame = firstPresentFrame(choreography, id, song.playableStartMs,
        song.playableStartMs + choreography.song.maxInterpolationGapMs);
      const pose = frame < 0 ? undefined : framesToPoses(choreography, frame).poses.find((p) => p.playerId === id);
      return pose ? { time: choreography.times[frame], pose } : null;
    });
  }, [routine]);
  useFrame(() => {
    if (!routine) return;
    const { bundle, playerCount } = routine;
    // Hold the last pose at the very end instead of vanishing.
    const t = Math.min(routine.timeMs(), bundle.song.playableEndMs - 1);
    const { poses } = sampleSong(bundle, t, playerCount);
    for (const id of [0, 1]) refs[id].current = poses.find((p) => p.playerId === id) ??
      (opening[id] && t <= opening[id].time ? opening[id].pose : null);
  }, -1);
  return refs;
}

/**
 * The glass dancers, standing on a stage's dance floor, mirrored like a dance coach.
 *   motion, playback: loop the captured demo (both dancers), or
 *   routine: { bundle, playerCount, timeMs() } dance a song's choreography (one player
 *     dances alone in the middle); optional entranceTimeMs() reveals them at the first beat
 *   position: [x, y, z] of the floor surface between them
 *   rotationY: turn the pair (they face +z by default)
 *   spacing: distance between the two dancers
 *   scale: uniform scale (1 = ~2.6 units tall)
 */
export interface DancersProps extends Partial<DancerPlacement> {
  motion?: MotionTake | null;
  /** Seconds into the motion take. */
  playback?: RefObject<number>;
  routine?: DancerRoutine | null;
  looks?: readonly DancerLook[];
}

export default function Dancers({ motion, playback, routine, position = [0, 0, 0], rotationY = 0, spacing = 4, scale = 1, looks = DANCER_LOOKS }: DancersProps) {
  const poses = useRoutinePoses(routine);
  const solo = routine?.playerCount === 1;
  return (
    <group position={[position[0], position[1] + FOOT_CLEARANCE * scale, position[2]]} rotation={[0, rotationY, 0]} scale={scale}>
      <Suspense fallback={null}>
        {(solo ? [0] : [0, 1]).map((person) => (
          <group key={person} position={[solo ? 0 : (person === 0 ? -1 : 1) * (spacing / 2), 0, 0]}>
            <DancerEntrance timeMs={routine?.entranceTimeMs} color={looks[person].color} seed={person + 1}>
              <group scale={[-1, 1, 1]}>
                {routine ? (
                  <Character poseRef={poses[person]} calibration={routine.bundle.choreography.tracks[person].calibration} appearance={looks[person]} />
                ) : (
                  <Character motion={motion} person={person} playback={playback} appearance={looks[person]} />
                )}
              </group>
            </DancerEntrance>
          </group>
        ))}
      </Suspense>
    </group>
  );
}
