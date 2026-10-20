import { Suspense, useMemo } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import Character from '../../character/Character.tsx';
import type { CharacterAppearance } from '../../character/Character.tsx';
import { sampleSong } from '../../pose/song.ts';
import { firstPresentFrame, framesToPoses } from '../../pose/binary.ts';
import { MAX_PLAYERS, partOf } from '../../pose/choreography.ts';
import type { Pose } from '../../pose/choreography.ts';
import type { MotionTake } from '../../pose/motion.ts';
import type { DancerPlacement } from '../catalog.ts';
import DancerEntrance from './DancerEntrance.tsx';
import type { DancerRoutine } from './routine.ts';

export type { DancerRoutine };

export type DancerLook = CharacterAppearance;

// One per player: blue, purple, green and pink (the players screen's colours), a little more
// solid than the menu's dancers (default gel opacity 0.72) so they hold up against busy
// stage backgrounds.
export const DANCER_LOOKS: readonly DancerLook[] = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4']
  .map((color) => ({ color, gloss: 85, accessory: 'None', opacity: 0.85 }));

/**
 * Where dancer `i` of `count` stands on the floor (x from the middle) and how big: one in
 * the middle, two `spacing` apart, three or four closer together and smaller.
 */
export function dancerSpot(i: number, count: number, spacing: number) {
  const crowd = count > 2;
  return { x: (i - (count - 1) / 2) * spacing / (crowd ? 2 : 1), scale: crowd ? 0.65 : 1 };
}

// The rig's feet rest about this far above the group origin's floor.
const FOOT_CLEARANCE = 0.015;

// One pose ref per player, sampled from a song's choreography at its current time each frame.
function useRoutinePoses(routine: DancerRoutine | null | undefined): RefObject<Pose | null>[] {
  const refs = useMemo((): RefObject<Pose | null>[] => Array.from({ length: MAX_PLAYERS }, () => ({ current: null })), []);
  const opening = useMemo((): ({ time: number; pose: Pose } | null)[] => {
    if (!routine?.entranceTimeMs) return [];
    const { song, choreography } = routine.bundle;
    // Capture/export can leave a few empty frames before the first pose. Prepare that
    // pose for the entrance, but never fill a longer tracking gap or change scoring.
    return choreography.tracks.map((_, id) => {
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
    refs.forEach((ref, id) => {
      const first = opening[partOf(id, opening.length)];
      ref.current = id >= playerCount ? null : poses.find((p) => p.playerId === id) ?? (first && t <= first.time ? first.pose : null);
    });
  }, -1);
  return refs;
}

/**
 * The glass dancers, standing on a stage's dance floor, mirrored like a dance coach.
 *   motion, playback: loop the captured demo (both dancers), or
 *   routine: { bundle, playerCount, timeMs() } dance a song's choreography, one dancer per
 *     player in their colour (one player dances alone in the middle; three or four stand
 *     closer, smaller, and repeat the duet's parts); optional entranceTimeMs() reveals them
 *     at the first beat
 *   position: [x, y, z] of the floor surface between them
 *   rotationY: turn the pair (they face +z by default)
 *   spacing: distance between two dancers
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
  // The demo motion is a duet.
  const count = routine?.playerCount ?? 2;
  const tracks = routine?.bundle.choreography.tracks;
  return (
    <group position={[position[0], position[1] + FOOT_CLEARANCE * scale, position[2]]} rotation={[0, rotationY, 0]} scale={scale}>
      <Suspense fallback={null}>
        {Array.from({ length: count }, (_, person) => {
          const spot = dancerSpot(person, count, spacing);
          const look = looks[person % looks.length];
          return (
            <group key={person} position={[spot.x, 0, 0]} scale={spot.scale}>
              <DancerEntrance timeMs={routine?.entranceTimeMs} color={look.color} seed={person + 1}>
                <group scale={[-1, 1, 1]}>
                  {tracks ? (
                    <Character poseRef={poses[person]} calibration={tracks[partOf(person, tracks.length)].calibration} appearance={look} />
                  ) : (
                    <Character motion={motion} person={person} playback={playback} appearance={look} />
                  )}
                </group>
              </DancerEntrance>
            </group>
          );
        })}
      </Suspense>
    </group>
  );
}
