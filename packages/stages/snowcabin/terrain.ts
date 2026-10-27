// The land: a level dance floor in a clearing of drifted snow, rising gently into the forest
// and then the foothills, with the kit's snowy massifs all the way round.
import { smoothstep } from '../shared/random.ts';
import { fbm2, makeNoise2 } from '../polar/noise.ts';
import { massifHeight } from '../polar/Land.tsx';
import type { LandArea, Peak } from '../polar/Land.tsx';
import { cabinClearance } from './layout.ts';

// [x, z, height, radius]: tallest beyond the dancers, lower round the sides and behind the camera.
const PEAKS: readonly Peak[] = [
  [250, -720, 150, 290],
  [-260, -820, 120, 300],
  [700, -900, 130, 300],
  [-800, -900, 110, 340],
  [-980, -260, 130, 320],
  [-1020, 380, 105, 300],
  [960, -180, 115, 300],
  [1060, 420, 145, 340],
  [320, 960, 150, 320],
  [-360, 1010, 115, 300],
  [820, 860, 95, 280],
  [-860, 820, 125, 300],
];

const drift = makeNoise2(23);
const hills = makeNoise2(71);

/** The snowfield's reach; the kit's land takes over beyond it. */
export const FIELD_RADIUS = 150;

/** Snow height at (x, z), everywhere: clearing, forest floor, foothills and peaks. */
export function landHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // Soft drifts across the clearing, leaving the dance floor level.
  let h = (0.5 * fbm2(drift, x * 0.05, z * 0.05, 3) + 0.15) * smoothstep(6, 16, r);
  h += smoothstep(24, 80, r) * (2.6 + 1.8 * fbm2(hills, x * 0.02, z * 0.02, 2));
  h += smoothstep(100, 430, r) * (30 + 24 * fbm2(hills, x * 0.004 + 3.1, z * 0.004, 3));
  // Level where the cabin and its deck stand.
  h *= smoothstep(0, 4, cabinClearance(x, z));
  return h + massifHeight(PEAKS, x, z);
}

/** The snowfield mesh's height: the land, dipping under the far land at its rim so the two never fight. */
export const fieldHeight = (x: number, z: number): number => landHeight(x, z) - 4 * smoothstep(FIELD_RADIUS - 14, FIELD_RADIUS, Math.hypot(x, z));

/**
 * The far land for the kit's Mountains: the same heights, sunk out of sight (and cut away) under
 * the snowfield. Drawn as two halves, the far one and the one behind the camera turned round,
 * so the rows bunch up towards the clearing on both.
 */
export const farHeight = (x: number, z: number): number => landHeight(x, z) - 40 * (1 - smoothstep(FIELD_RADIUS - 30, FIELD_RADIUS - 14, Math.hypot(x, z)));
export const FAR_CUT = -2;
export const LAND_AHEAD: LandArea = { left: -1900, right: 1900, front: 0, back: -1900 };
export const LAND_BEHIND: LandArea = { left: 1900, right: -1900, front: 0, back: 1900 };
