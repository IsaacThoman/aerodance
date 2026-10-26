import { Suspense, useMemo } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import Character from '../../character/Character.tsx';
import type { CharacterAppearance } from '../../character/Character.tsx';
import { leadOf, sampleDancers } from '../../pose/song.ts';
import type { Cast } from '../../pose/song.ts';
import { firstPresentFrame, framesToPoses } from '../../pose/binary.ts';
import { MAX_DANCERS } from '../../pose/choreography.ts';
import type { Pose } from '../../pose/choreography.ts';
import { createPerformanceSampler } from '../../pose/performance.ts';
import type { CharacterPose } from '../../pose/performance.ts';
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
/** A dancer nobody follows: frosted glass, so the ones the players follow stand out in their colours. */
export const SPARE_LOOK: DancerLook = { color: '#d8eefa', gloss: 85, accessory: 'None', opacity: 0.55 };

/** A song's dancers dressed for a cast: each in the colour of the first player following them, or spare. */
export function castLooks(cast: Cast, dancers: number, looks: readonly DancerLook[] = DANCER_LOOKS): DancerLook[] {
  return Array.from({ length: dancers }, (_, dancer) => {
    const lead = leadOf(cast, dancer);
    return lead < 0 ? SPARE_LOOK : looks[lead % looks.length];
  });
}

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

// One pose ref per dancer, sampled from a song's choreography at its current time each frame.
function useRoutinePoses(routine: DancerRoutine | null | undefined) {
  const refs = useMemo((): RefObject<Pose | null>[] => Array.from({ length: MAX_DANCERS }, () => ({ current: null })), []);
  const performances = useMemo((): RefObject<CharacterPose | null>[] => Array.from({ length: MAX_DANCERS }, () => ({ current: null })), []);
  const performers = useMemo(() => routine?.bundle.performance?.tracks.map(t => createPerformanceSampler(t.clips)) ?? [], [routine?.bundle.performance]);
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
    if (!routine) { performances.forEach(r => { r.current = null; }); return; }
    const { bundle } = routine;
    // Hold the last pose at the very end instead of vanishing.
    const t = Math.min(routine.timeMs(), bundle.song.playableEndMs - 1);
    const { poses } = sampleDancers(bundle, t);
    refs.forEach((ref, id) => {
      const first = opening[id];
      ref.current = poses.find((p) => p.playerId === id) ?? (first && t <= first.time ? first.pose : null);
      performances[id].current = performers[id]?.(t) ?? null;
    });
  }, -1);
  return { poses: refs, performances };
}

/**
 * The glass dancers, standing on a stage's dance floor, mirrored like a dance coach.
 *   motion, playback: loop the captured demo (both dancers), or
 *   routine: { bundle, cast, timeMs() } dance a song's choreography: every dancer it has, each
 *     in the colour of the first player following them (cast) and frosted when nobody does
 *     (one dances alone in the middle; three or four stand closer and smaller); optional
 *     entranceTimeMs() reveals them at the first beat
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
  const { poses, performances } = useRoutinePoses(routine);
  const tracks = routine?.bundle.choreography.tracks;
  // The song's dancers; the demo motion is a duet.
  const count = tracks?.length ?? 2;
  const cast = routine?.cast;
  const dressed = useMemo(() => (cast ? castLooks(cast, count, looks) : looks), [cast, count, looks]);
  return (
    <group position={[position[0], position[1] + FOOT_CLEARANCE * scale, position[2]]} rotation={[0, rotationY, 0]} scale={scale}>
      <Suspense fallback={null}>
        {Array.from({ length: count }, (_, person) => {
          const spot = dancerSpot(person, count, spacing);
          const look = dressed[person % dressed.length];
          return (
            <group key={person} position={[spot.x, 0, 0]} scale={spot.scale}>
              <DancerEntrance timeMs={routine?.entranceTimeMs} color={look.color} seed={person + 1}>
                <group scale={[-1, 1, 1]}>
                  {tracks ? (
                    <Character poseRef={poses[person]} performanceRef={performances[person]} calibration={tracks[person].calibration} appearance={look} />
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
