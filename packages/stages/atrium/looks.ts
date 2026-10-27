import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { AXIS, GLASS_R, GLASS_THETA, polar } from './layout.ts';

export type RGB = readonly [r: number, g: number, b: number];

/** A shaft of light: where it enters (x, y, z), its width and its strength. */
export type Beam = readonly [x: number, y: number, z: number, width: number, strength: number];

/**
 * One time of day in the atrium: the light every shader shares (shading.ts turns these into
 * uniforms), the sky, and the three.js lights the dancers and their stage are lit by.
 */
export interface AtriumLook {
  id: 'day' | 'dusk' | 'night';
  /** Towards the sun (or the moon). */
  sunDir: THREE.Vector3;
  /** Sunlight, linear RGB times intensity. */
  sun: RGB;
  /** Sky light from above and bounce from below. */
  ambientUp: RGB;
  ambientDown: RGB;
  /** The sky in reflections and through the glass: near the horizon and overhead. */
  skyLow: RGB;
  skyHigh: RGB;
  /** The air between things and the camera, and how thick it is. */
  haze: RGB;
  hazeAmount: number;
  /** The building's own lights: 0 off (day) to 1 all on (night). */
  lamps: number;
  /** Their colour. */
  lamp: RGB;
  /** Stars in the sky (0..1). */
  stars: number;
  /** Clouds' lit and shaded sides. */
  cloudLit: RGB;
  cloudShade: RGB;
  /** The sun's glow in screen space. */
  glow: RGB;
  /** Light shafts: their colour (times strength) and where they enter. */
  shaft: RGB;
  beams: readonly Beam[];
  /** Dust motes in the beams (or, at night, fireflies drifting about). */
  mote: RGB;
  moteGlow: number;
  /** Their size (default 1): fireflies are bigger than dust. */
  moteSize?: number;
  /** Twinkling star glints on the glass. */
  glints: boolean;
  /** How dark the dancers' shadows fall on the floor (0..1). */
  shadow: number;
  sky: { top: string; horizon: string; bottom: string; exponent: number; sun: string; disc: number; glow: number; size: number };
  /** The dancers' key light (it casts their shadows), and hemisphere fill. */
  key: { position: Vec3; color: string; intensity: number };
  hemi: readonly [sky: string, ground: string, intensity: number];
  environment: { top: string; horizon: string; bottom: string; intensity: number; lights: readonly EnvironmentLight[] };
}

const rel = (x: number, y: number, z: number, width: number, strength: number): Beam => [AXIS.x + x, y, AXIS.z + z, width, strength];

/** Beams entering through the glass wall, for a low sun. */
const wallBeams = (list: readonly (readonly [theta: number, y: number, width: number, strength: number])[]): Beam[] =>
  list.map(([theta, y, width, strength]) => {
    const p = polar(GLASS_R - 0.2, theta, y);
    return [p.x, p.y, p.z, width, strength];
  });

const DOME_BEAM_Y = 23.8;

const day: AtriumLook = {
  id: 'day',
  // High, behind and to the right, so beams slant steeply down to the left through the dome.
  sunDir: new THREE.Vector3(0.36, 0.84, -0.4).normalize(),
  sun: [2.0, 1.9, 1.72],
  ambientUp: [0.54, 0.67, 0.83],
  ambientDown: [0.45, 0.49, 0.45],
  skyLow: [0.9, 1.0, 1.1],
  skyHigh: [0.35, 0.68, 1.05],
  haze: [0.84, 0.93, 1.0],
  hazeAmount: 0.28,
  lamps: 0,
  lamp: [1.0, 0.86, 0.66],
  stars: 0,
  cloudLit: [1.25, 1.25, 1.22],
  cloudShade: [0.66, 0.78, 0.92],
  glow: [1.0, 0.93, 0.78],
  shaft: [0.75, 0.72, 0.63],
  beams: [
    rel(6, DOME_BEAM_Y, -7.5, 2.2, 1.0),
    rel(10, DOME_BEAM_Y, -3, 1.5, 0.8),
    rel(2, DOME_BEAM_Y, -12, 1.6, 0.75),
    rel(13.5, DOME_BEAM_Y, -9, 2.8, 0.85),
    rel(8, DOME_BEAM_Y, -14, 2.0, 0.6),
    rel(15.5, DOME_BEAM_Y, 0, 1.8, 0.7),
    rel(-2, DOME_BEAM_Y, -5, 1.2, 0.5),
    rel(12, DOME_BEAM_Y, 5, 2.2, 0.55),
  ],
  mote: [1.0, 0.97, 0.88],
  moteGlow: 0.12,
  glints: true,
  shadow: 0.32,
  sky: { top: '#0f5cc8', horizon: '#9ad6ff', bottom: '#d4f0ff', exponent: 0.45, sun: '#fff2d6', disc: 3, glow: 0.8, size: 1.4 },
  key: { position: [9, 16, 12], color: '#fff6e8', intensity: 2.4 },
  hemi: ['#d6ecff', '#9fb8a0', 0.7],
  environment: {
    top: '#bfe6ff',
    horizon: '#2a8fe0',
    bottom: '#3f7a6a',
    intensity: 1.6,
    lights: [
      { position: [0, 26, -6], color: '#eaf6ff', intensity: 4, size: [24, 24] },
      { position: [14, 22, -16], color: '#fff2d8', intensity: 5, size: [6, 6] },
      { position: [0, 6, -12], color: '#3fd8ff', intensity: 2.5, size: [4, 14] },
      { position: [-18, 6, -4], color: '#7fe07a', intensity: 1.4, size: [10, 10] },
      { position: [18, 8, -10], color: '#7fd0ff', intensity: 2, size: [10, 14] },
      { position: [0, 4, 24], color: '#cfefff', intensity: 1.6, size: [20, 6] },
    ],
  },
};

// Golden hour: the sun low through the glass wall on the right, its beams reaching across the
// room, a peach and lilac sky, and the building's lights coming on.
const DUSK_THETA = 2.15;
const dusk: AtriumLook = {
  id: 'dusk',
  sunDir: new THREE.Vector3(Math.sin(DUSK_THETA) * 0.96, 0.27, Math.cos(DUSK_THETA) * 0.96).normalize(),
  sun: [3.9, 2.2, 1.0],
  ambientUp: [0.32, 0.32, 0.54],
  ambientDown: [0.32, 0.24, 0.28],
  skyLow: [1.15, 0.76, 0.56],
  skyHigh: [0.38, 0.42, 0.85],
  haze: [1.0, 0.76, 0.62],
  hazeAmount: 0.32,
  lamps: 0.55,
  lamp: [1.0, 0.8, 0.55],
  stars: 0,
  cloudLit: [1.35, 0.9, 0.7],
  cloudShade: [0.55, 0.45, 0.68],
  glow: [0.9, 0.55, 0.28],
  shaft: [1.9, 1.1, 0.5],
  beams: wallBeams([
    [GLASS_THETA[0] + 0.35, 3.5, 1.6, 0.8],
    [GLASS_THETA[0] + 0.6, 8.0, 2.2, 1.0],
    [GLASS_THETA[0] + 0.85, 5.5, 1.4, 0.7],
    [GLASS_THETA[0] + 1.05, 11.5, 2.0, 0.75],
    [GLASS_THETA[0] + 0.2, 13.0, 1.8, 0.6],
    [GLASS_THETA[0] + 1.3, 7.5, 1.6, 0.55],
  ]),
  mote: [1.0, 0.82, 0.6],
  moteGlow: 0.16,
  glints: true,
  shadow: 0.34,
  sky: { top: '#3d4cae', horizon: '#ffb27a', bottom: '#ffd6a8', exponent: 0.6, sun: '#ffd08a', disc: 4, glow: 1.2, size: 1.6 },
  key: { position: [14, 5.5, 1.5], color: '#ffc890', intensity: 2.6 },
  hemi: ['#c8b8ff', '#c08a6a', 0.6],
  environment: {
    top: '#6a6ad0',
    horizon: '#ff9a6a',
    bottom: '#5a3a4a',
    intensity: 1.4,
    lights: [
      { position: [20, 6, -16], color: '#ffb070', intensity: 6, size: [8, 8] },
      { position: [0, 26, -6], color: '#b8a8ff', intensity: 2.5, size: [24, 24] },
      { position: [0, 6, -12], color: '#3fd8ff', intensity: 2.5, size: [4, 14] },
      { position: [-18, 6, -4], color: '#ffcf8a', intensity: 1.6, size: [10, 10] },
      { position: [0, 4, 24], color: '#ffd8c0', intensity: 1.4, size: [20, 6] },
    ],
  },
};

// Night: a low moon through the glass wall and stars over the dome, the shop fronts and soffits
// glowing warm, the aquarium lit from within, light pooling under the water, fireflies about.
const night: AtriumLook = {
  id: 'night',
  // The moon, low over the park: it shows through the glass wall right of the column, in the
  // middle of a pane (the wall's mullions are 4.8 apart), and its light falls in barred patches.
  sunDir: new THREE.Vector3(0.229, 0.324, -0.918).normalize(),
  sun: [0.36, 0.46, 0.72],
  ambientUp: [0.12, 0.16, 0.3],
  ambientDown: [0.2, 0.17, 0.16],
  skyLow: [0.1, 0.14, 0.3],
  skyHigh: [0.03, 0.05, 0.14],
  haze: [0.1, 0.14, 0.28],
  hazeAmount: 0.3,
  lamps: 1,
  lamp: [0.72, 0.48, 0.24],
  stars: 1,
  cloudLit: [0.32, 0.38, 0.55],
  cloudShade: [0.08, 0.1, 0.2],
  glow: [0.2, 0.25, 0.4],
  shaft: [0.18, 0.24, 0.4],
  beams: wallBeams([
    [2.35, 14.5, 1.6, 0.6],
    [2.6, 10.5, 2.0, 0.5],
    [2.15, 7.0, 1.4, 0.4],
  ]),
  mote: [0.75, 1.0, 0.45],
  moteGlow: 0.7,
  moteSize: 2.0,
  glints: false,
  shadow: 0.26,
  sky: { top: '#020a26', horizon: '#1a2e6a', bottom: '#24305a', exponent: 0.5, sun: '#dfe8ff', disc: 1.8, glow: 0.18, size: 1.0 },
  // A cool key from the front and bright panels behind the camera, so the glass dancers read
  // against the glowing column instead of going dark.
  key: { position: [8, 14, 12], color: '#d8e4ff', intensity: 2.3 },
  hemi: ['#6a7ad0', '#5a3a2a', 0.7],
  environment: {
    top: '#1a2a6a',
    horizon: '#2a4aa0',
    bottom: '#2a1a34',
    intensity: 1.9,
    lights: [
      { position: [0, 6, -12], color: '#2ff0ff', intensity: 4, size: [4, 16] },
      { position: [-20, 5, -4], color: '#ffb060', intensity: 3, size: [14, 6] },
      { position: [16, 7, -12], color: '#ffc070', intensity: 2.2, size: [12, 6] },
      { position: [0, 26, -6], color: '#6070c0', intensity: 1.6, size: [20, 20] },
      { position: [0, 5, 24], color: '#a8c4ff', intensity: 4, size: [24, 10] },
      { position: [-14, 10, 16], color: '#d8a0ff', intensity: 2.5, size: [10, 8] },
      { position: [0, -2, 0], color: '#2fc8ff', intensity: 1.5, size: [10, 10] },
    ],
  },
};

export const LOOKS = { day, dusk, night } as const;
