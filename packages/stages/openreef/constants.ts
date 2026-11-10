import type { Vec3 } from '../catalog.ts';
import type { StageCameraProps } from '../shared/hooks.ts';

// Scene-wide layout constants shared by the stage modules.

// Water surface height; the reef floor sits ~10 m below it.
export const SURFACE_Y = 9.5;

// Direction sunlight travels underwater: slanting down from the left. The
// shadow-casting light, caustics and god rays all follow it.
export const SUN_TRAVEL: Vec3 = [0.5, -1, 0.1];

// The dancers stand on the sand (SAND_Y in Reef.tsx).
export const CAMERA = { position: [0, 2.35, 15], target: [0, 1.0, 0], fov: 41 } satisfies StageCameraProps;
// Light shafts are kept off the dancers as seen from here, a little above CAMERA (where the
// camera stood when the stage had a glass dome round the dancers). Moving it moves the shafts.
export const SHAFT_VIEW = { position: [0, 2.8, 15], target: [0, 1.45, 0], fov: 41 } satisfies StageCameraProps;
