import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Skyline's views of the Aero world: its own drone flight ('flight', the scene's camera), and
 * three slow moves where the flight only passes. The world culls its grass, flowers, trees and
 * lamps to the camera's view each frame (hence useSettledViews), and its cloud layer hangs from
 * about 175 m, so the views stay below it: across the park towards downtown's towers, along the
 * lake towards the red arch bridge between the towers on its quays, and low through the flower
 * meadow looking back at the skyline.
 */

const VIEWS: Record<string, Shot> = {
  downtown: dolly([-140, 40, 560], [140, 42, 560], [-30, 70, 0], { toTarget: [30, 70, 0], seconds: 120, fov: 42 }),
  lake: dolly([-260, 26, -372], [-150, 24, -378], [200, 22, -380], { toTarget: [260, 20, -376], seconds: 90, fov: 45 }),
  meadow: dolly([60, 4.5, 640], [-20, 5, 610], [10, 45, 0], { toTarget: [-10, 45, 0], seconds: 100, fov: 45 }),
};

export default function SkylineSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
