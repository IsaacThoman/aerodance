// Where everything is: the lake all round the dancers (they stand in its middle, at the
// origin), its shore and the land and peaks beyond, the cabin up the far slope, the hut and
// lanterns out on the ice, and the curtains overhead. Angles go clockwise from north (-z), the
// way the gameplay camera looks, so a spot at angle a and radius r is (r sin a, -r cos a).
import type { Vec3 } from '../catalog.ts';
import { fbm2, makeNoise2 } from '../polar/noise.ts';
import { massifHeight } from '../polar/Land.tsx';
import type { LandArea, Peak } from '../polar/Land.tsx';
import type { Curtain } from '../polar/Aurora.tsx';
import { smoothstep } from '../shared/random.ts';

export const at = (angle: number, radius: number): [x: number, z: number] => [radius * Math.sin(angle), -radius * Math.cos(angle)];

const shoreNoise = makeNoise2(23);
const bankNoise = makeNoise2(97);
const hillNoise = makeNoise2(41);

/** How far the shore is from the dancers at an angle: 300 or so, coves and points all round. */
export function shoreRadius(angle: number): number {
  // Noise read round a circle, so it meets itself again behind the camera.
  const c = Math.cos(angle) * 2.2;
  const s = Math.sin(angle) * 2.2;
  return 305 + 40 * fbm2(shoreNoise, c + 5, s + 5, 3) + 18 * Math.sin(2 * angle + 0.7);
}

// [x, z, height, radius]: snowy massifs all the way round, tallest beyond the cabin, and a far,
// hazy range showing over the lower ones.
const PEAKS: readonly Peak[] = [
  [250, -760, 150, 290],
  [480, -850, 118, 240],
  [90, -920, 98, 230],
  [-190, -1000, 78, 280],
  [-560, -840, 52, 320],
  [-960, -900, 82, 340],
  [820, -980, 128, 300],
  [1180, -700, 96, 320],
  [-760, -1380, 170, 380],
  [-1250, -1420, 200, 420],
  [-330, -1520, 150, 360],
  [1250, -150, 140, 340],
  [1000, 420, 96, 300],
  [1550, 600, 170, 400],
  [520, 960, 120, 300],
  [-200, 1050, 150, 340],
  [-700, 900, 104, 320],
  [-1150, 420, 130, 340],
  [-1100, -250, 92, 300],
  [-1700, 200, 190, 420],
  [200, 1650, 200, 440],
];

/** A low wooded bank, forested foothills, then the peaks; below 0 out on the lake. */
function hills(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const shore = shoreRadius(Math.atan2(x, -z));
  const bank = smoothstep(shore - 4, shore + 16, r) * (6 + 3 * fbm2(bankNoise, x * 0.02, z * 0.02, 2)) - 3;
  const foot = smoothstep(shore + 10, shore + 200, r) * (16 + 16 * fbm2(hillNoise, x * 0.0045, z * 0.0045, 3));
  return bank + foot + massifHeight(PEAKS, x, z);
}

// How far up the slope beyond the shore the cabin stands.
const CABIN_RISE = 115;
const [cabinX, cabinZ] = at(0, shoreRadius(0) + CABIN_RISE);
const cabinY = hills(cabinX, cabinZ);

/**
 * The glass A-frame straight ahead, between the two dancers, up the wooded slope across the lake
 * so that it glows above their heads (and the results' winner's), not behind them.
 */
export const CABIN = {
  position: [cabinX, cabinY, cabinZ] as Vec3,
  /** Turned to face the dancers. */
  heading: 0,
  /** Where its windows glow, for the warm path across the ice and its halo. */
  light: [cabinX, cabinY + 6.5, cabinZ + 2] as Vec3,
};

/** Whether (x, z) is in the cabin's clearing or the gap in the trees below it that shows it from the lake. */
export function cabinView(x: number, z: number): boolean {
  const r = Math.hypot(x, z);
  return Math.hypot(x - cabinX, z - cabinZ) < 16 || (Math.abs(Math.atan2(x, -z)) < 0.035 && r < -cabinZ + 10);
}

/** Height of the land at (x, z), with a flat clearing for the cabin. */
export function landHeight(x: number, z: number): number {
  const h = hills(x, z);
  const cabin = Math.hypot(x - cabinX, z - cabinZ);
  return h + (cabinY - h) * (1 - smoothstep(9, 18, cabin));
}

// The land in four pieces round the lake (the kit's terrain is a grid on a rectangle). Each
// runs left to right as seen from the dancers, so its triangles face up; rows bunch up at the
// lake side.
const FAR = 2100;
export const LAND: readonly { area: LandArea; grid: [number, number]; mirrorGrid: [number, number] }[] = [
  { area: { left: -FAR, right: FAR, front: -200, back: -FAR }, grid: [240, 56], mirrorGrid: [120, 24] },
  { area: { left: FAR, right: -FAR, front: 200, back: FAR }, grid: [200, 44], mirrorGrid: [100, 20] },
  { area: { left: FAR, right: 200, front: -200, back: 200 }, grid: [120, 24], mirrorGrid: [60, 12] },
  { area: { left: -200, right: -FAR, front: -200, back: 200 }, grid: [120, 24], mirrorGrid: [60, 12] },
];

/**
 * The cleared rink round the dancers: polished ice inside, snow shovelled up round its edge.
 * Wider than the camera's circle round them, so its near edge is always behind the camera.
 */
export const RINK = { radius: 18 };

/** Which way the wind blows the snow across the ice and the hut's smoke (x, z, normalised). */
export const WIND: readonly [x: number, z: number] = [0.94, 0.34].map((v) => v / Math.hypot(0.94, 0.34)) as [number, number];

/** [x, z, rx, rz]: loops traced by skates round the rink. */
export const SKATE_LOOPS: readonly [number, number, number, number][] = [
  [0, 0.5, 6.5, 5.0],
  [1.2, -0.8, 4.0, 3.4],
  [-2.5, 1.5, 3.0, 2.6],
  [3.0, 2.0, 2.4, 2.1],
  [-0.8, -1.5, 8.0, 6.4],
  [2.0, 1.0, 7.2, 5.6],
  [-3.6, -2.2, 2.0, 1.8],
];

/** The ice-fishing hut, out on the lake left of the dancers, turned a little towards them. */
export const HUT = { position: at(-0.62, 52), heading: 0.9 };

/**
 * Glass lanterns on stakes in the snow round the rink, out of the way of the camera's circle and
 * either side of the dancers from the front; and one by the hut.
 */
export const LANTERNS: readonly [x: number, z: number][] = [
  ...[-5, -3, -1, 1, 3, 5].map((k) => at((k * Math.PI) / 6, RINK.radius + 0.6)),
  [HUT.position[0] + 3.2, HUT.position[1] + 2.4],
];
export const LANTERN_HEIGHT = 1.25;

// The near curtains, all round the sky: the brightest across the north beyond the cabin, fainter
// ones east, south and west. Fainter, farther ones are painted into the sky (Sky.tsx). The
// bright, low ones are mirrored in the ice. The side ones fold more shallowly: the preview sees
// them at a slant, where deep folds turn back over themselves into hard seams.
export const CURTAINS: readonly Curtain[] = [
  { line: [-2600, -1500, 2600, -2700], bottom: [300, 220], height: [950, 850], fold: 170, bow: 320, gain: [0.75, 1.0], rays: 90, seed: 0.13, reflected: true },
  { line: [-1500, -1250, 1700, -1600], bottom: [190, 160], height: [720, 640], fold: 120, bow: 140, gain: [0.9, 0.75], rays: 80, seed: 0.57, reflected: true },
  { line: [1900, -900, 2200, 1900], bottom: [260, 300], height: [800, 700], fold: 70, bow: 200, gain: [0.7, 0.5], rays: 70, seed: 0.31, reflected: true },
  { line: [1800, 2300, -2000, 1900], bottom: [320, 280], height: [760, 900], fold: 70, bow: 240, gain: [0.45, 0.7], rays: 80, seed: 0.79, reflected: false },
  { line: [-2100, 1500, -1700, -1700], bottom: [280, 240], height: [820, 760], fold: 70, bow: 200, gain: [0.55, 0.8], rays: 75, seed: 0.91, reflected: true },
];
