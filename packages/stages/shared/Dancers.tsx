import { Suspense, useMemo } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import Character from '../../character/Character.tsx';
import type { CharacterAppearance } from '../../character/Character.tsx';
import { sampleSong } from '../../pose/song.ts';
import { firstPresentFrame, framesToPoses } from '../../pose/binary.ts';
import type { Pose } from '../../pose/choreography.ts';
import type { MotionTake } from '../../pose/motion.ts';
import type { DancerPlacement } from '../catalog.ts';
import DancerEntrance from './DancerEntrance.tsx';
import { coachesFor, routineCast } from './routine.ts';
import type { Coach, DancerRoutine } from './routine.ts';

export type { DancerRoutine };

export type DancerLook = CharacterAppearance;

// One per player: blue, purple, green and pink (the players screen's colours), a little more
// solid than the menu's dancers (default gel opacity 0.72) so they hold up against busy
// stage backgrounds.
export const DANCER_LOOKS: readonly DancerLook[] = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4']
  .map((color) => ({ color, gloss: 85, accessory: 'None', opacity: 0.85 }));
// A dancer of the song nobody is dancing: clear, pale glass, so the players' own coaches stand out.
export const UNCAST_LOOK: DancerLook = { color: '#d9f3ff', gloss: 85, accessory: 'None', opacity: 0.4 };

/**
 * Where dancer `i` of `count` stands on the floor (x from the middle) and how big: one in
 * the middle, two `spacing` apart, three or four closer together and smaller. More than four
 * (players doubling up on a dancer while others go unpicked) squeeze into the same width.
 */
export function dancerSpot(i: number, count: number, spacing: number) {
  if (count <= 2) return { x: (i - (count - 1) / 2) * spacing, scale: 1 };
  const step = (spacing / 2) * Math.min(1, 3 / (count - 1));
  return { x: (i - (count - 1) / 2) * step, scale: (0.65 * step) / (spacing / 2) };
}

// The rig's feet rest about this far above the group origin's floor.
const FOOT_CLEARANCE = 0.015;

// One pose ref per coach, sampled from a song's choreography at its current time each frame.
function useRoutinePoses(routine: DancerRoutine | null | undefined, coaches: readonly Coach[]): RefObject<Pose | null>[] {
  const refs = useMemo((): RefObject<Pose | null>[] => coaches.map(() => ({ current: null })), [coaches]);
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
  // Every dancer once, as if each had a player of their own.
  const everyone = useMemo(() => routine ? routine.bundle.choreography.tracks.map((_, dancer) => dancer) : [], [routine]);
  useFrame(() => {
    if (!routine) return;
    const { bundle } = routine;
    // Hold the last pose at the very end instead of vanishing.
    const t = Math.min(routine.timeMs(), bundle.song.playableEndMs - 1);
    const { poses } = sampleSong(bundle, t, everyone);
    refs.forEach((ref, i) => {
      const { dancer } = coaches[i];
      const first = opening[dancer];
      ref.current = poses.find((p) => p.playerId === dancer) ?? (first && t <= first.time ? first.pose : null);
    });
  }, -1);
  return refs;
}

/**
 * The glass dancers, standing on a stage's dance floor, mirrored like a dance coach.
 *   motion, playback: loop the captured demo (both dancers), or
 *   routine: { bundle, playerCount, cast?, timeMs() } dance a song's choreography: every one
 *     of its dancers, once in each colour of the players dancing them and in clear glass if
 *     nobody is (coachesFor; three or more stand closer and smaller); optional
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

// The demo motion is a duet, one dancer per player.
const DEMO: readonly Coach[] = [{ dancer: 0, player: 0 }, { dancer: 1, player: 1 }];

export default function Dancers({ motion, playback, routine, position = [0, 0, 0], rotationY = 0, spacing = 4, scale = 1, looks = DANCER_LOOKS }: DancersProps) {
  const tracks = routine?.bundle.choreography.tracks;
  const cast = routine ? routineCast(routine) : null;
  // A new array only when the cast does change, so the poses' refs stay put.
  const castKey = cast?.join() ?? '';
  const coaches = useMemo(() => (cast && tracks ? coachesFor(cast, tracks.length) : DEMO),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [castKey, tracks]);
  const poses = useRoutinePoses(routine, coaches);
  return (
    <group position={[position[0], position[1] + FOOT_CLEARANCE * scale, position[2]]} rotation={[0, rotationY, 0]} scale={scale}>
      <Suspense fallback={null}>
        {coaches.map(({ dancer, player }, i) => {
          const spot = dancerSpot(i, coaches.length, spacing);
          const look = player === null ? UNCAST_LOOK : looks[player % looks.length];
          return (
            // By spot, so a new cast recolours the coaches rather than bringing on new ones.
            <group key={i} position={[spot.x, 0, 0]} scale={spot.scale}>
              <DancerEntrance timeMs={routine?.entranceTimeMs} color={look.color} seed={i + 1}>
                <group scale={[-1, 1, 1]}>
                  {tracks ? (
                    <Character poseRef={poses[i]} calibration={tracks[dancer].calibration} appearance={look} />
                  ) : (
                    <Character motion={motion} person={dancer} playback={playback} appearance={look} />
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
