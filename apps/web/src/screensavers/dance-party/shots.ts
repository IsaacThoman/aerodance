import type { StageId } from '../../../../../packages/stages/catalog.ts';
import { dolly } from '../kit.ts';
import type { Shot } from '../kit.ts';

/*
 * Dance Party's camera views, per stage: the stage's own shot (`stage`, left to its StageCamera),
 * then three of its own, each a slow move that looks good for minutes:
 *
 *   circle   swinging round the dancers, part of the way: the stages are built to be seen from
 *            the front, and behind them is open sand, a flat city map or a bare hillside
 *   close    low and near, sliding across the front, the glass bodies against the sky, the
 *            water's surface or the lights
 *   wide     high and wide, a crane over the stage's world: the reef, the city and its river, the
 *            waterfalls, the club's lights, the ocean at sunset, the atrium's column and dome
 *
 * Positions are in each stage's own units (1.5 to the metre, the dancers 2.6 tall, facing +z from
 * x = ±2), but the atrium's, built in metres, its dancers 1.8 m tall at z = 2.2, x = ±1.4.
 */

type V3 = readonly [number, number, number];

/**
 * Round `target` at `radius`, `height` above it, swinging `amplitude` radians either side of
 * `center` (0 is in front, +z) and back every `seconds`: towards +x first, or -x if negative.
 */
export function swing(target: V3, radius: number, height: number, { center = 0, amplitude, seconds = 100, fov, bob = 0.12 }: { center?: number; amplitude: number; seconds?: number; fov?: number; bob?: number }): Shot {
  return (t) => {
    const a = center + amplitude * Math.sin((t / seconds) * Math.PI * 2);
    return { position: [target[0] + Math.sin(a) * radius, target[1] + height + Math.sin(t * 0.17) * bob, target[2] + Math.cos(a) * radius], target, fov };
  };
}

const D = Math.PI / 180;

export const SHOTS: Record<StageId, Readonly<Record<string, Shot>>> = {
  // Open sand ~10 m down; the surface at y 9.5, coral bommies round the sand, the arch on the right.
  openreef: {
    circle: swing([0, 1.2, 0], 9.5, 1.3, { amplitude: 70 * D, fov: 42 }),
    close: dolly([3.6, 0.25, 5.6], [-3.6, 0.3, 5.6], [0.6, 1.35, 0], { toTarget: [-0.6, 1.35, 0], seconds: 50, fov: 42 }),
    wide: dolly([-8, 4.6, 15], [6, 6.8, 17], [-0.5, 0.8, -3], { toTarget: [0.5, 0.6, -3], seconds: 60, fov: 45 }),
  },
  // The rooftop terrace: the city, the river and the airship ahead (-z); a flat map behind.
  // Setting off leftwards, away from the clock floating behind the left dancer.
  sanctuary: {
    circle: swing([0, 1.6, 0], 10.5, 1.6, { amplitude: -55 * D, fov: 42 }),
    close: dolly([-3.6, 0.6, 5.6], [3.6, 0.5, 5.6], [-0.6, 1.5, 0], { toTarget: [0.6, 1.5, 0], seconds: 50, fov: 42 }),
    wide: dolly([-9, 9, 19], [6, 12.5, 22], [0, 2, -14], { toTarget: [0, 2, -16], seconds: 60, fov: 45 }),
  },
  // The clifftop meadow: the lake and its waterfalls ahead (-z); a bare hillside behind. These
  // set off leftwards, away from the clock flower behind the left dancer (clocks.tsx).
  falls: {
    circle: swing([0, 1.6, 0], 9.5, 1.8, { amplitude: -50 * D, fov: 45 }),
    close: dolly([-3.5, 0.6, 5.5], [3.5, 0.6, 5.5], [-0.6, 1.6, 0], { toTarget: [0.6, 1.6, 0], seconds: 50, fov: 45 }),
    wide: dolly([6, 11, 14], [-6, 9, 13], [0, -1, -26], { toTarget: [0, -1, -26], seconds: 60, fov: 50 }),
  },
  // A round room (radius 13.6, ceiling 10): the video wall, aquariums and DJ behind the dance floor.
  club: {
    circle: swing([0, 1.6, 0], 8.5, 1.4, { amplitude: 80 * D, seconds: 110, fov: 46 }),
    close: dolly([2.4, 0.7, 4.3], [-2.4, 0.7, 4.3], [0.6, 1.6, 0], { toTarget: [-0.6, 1.6, 0], seconds: 50, fov: 50 }),
    wide: dolly([-5, 8, 10], [5, 8.5, 10.5], [0, 1.5, -4], { toTarget: [0, 1.8, -4], seconds: 60, fov: 50 }),
  },
  // Golden hour: the sea and the sun ahead (-z); flat sand behind. The palm leans in at x -7.8.
  // Circling leftwards first, away from the lifebuoy clock on the right.
  beach: {
    circle: swing([0, 1.0, 1], 11, 1.2, { amplitude: -45 * D, fov: 38 }),
    close: dolly([3.4, 0.25, 6.5], [-1.2, 0.2, 6.8], [0.6, 1.4, 1], { toTarget: [-0.4, 1.4, 1], seconds: 50, fov: 40 }),
    wide: dolly([-5, 6.5, 19], [5, 9, 21], [0, 0.5, -25], { toTarget: [0, 0.5, -25], seconds: 60, fov: 45 }),
  },
  // In metres: the aquarium column at z -8 in its pool, balconies round the void from y 4.8.
  // Setting off leftwards, away from the clock hanging behind the left dancer.
  atrium: {
    circle: swing([0, 1.0, 2.2], 5.5, 0.6, { amplitude: -65 * D, fov: 52 }),
    close: dolly([-2.2, 0.25, 5.8], [2.4, 0.25, 5.6], [-0.4, 1.1, 2.0], { toTarget: [0.4, 1.05, 2.2], seconds: 50, fov: 50 }),
    wide: dolly([-4.5, 2.4, 8], [4, 2.8, 7.6], [0, 3.0, -4], { toTarget: [0, 3.3, -4], seconds: 60, fov: 58 }),
  },
};
