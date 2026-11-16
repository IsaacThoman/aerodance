import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Bliss Hills' views. The land is a fan of rows 58° either side of the menu camera's knoll, so
 * the views stand on or just ahead of it and look down the valley within that fan: a slow glide
 * down the valley, the turbines along the ridge on a long lens, and the glass domes by the river.
 */

const VIEWS: Record<string, Shot> = {
  valley: dolly([0, 9, 0], [3, 10, -30], [6, 4, -120], { toTarget: [10, 2, -200], seconds: 90, fov: 44 }),
  turbines: dolly([0, 9, 0], [2, 9.5, -4], [74, 22, -205], { toTarget: [102, 32, -178], seconds: 80, fov: 24 }),
  domes: dolly([-3, 9, 0], [3, 9.5, -2], [2, -1, -150], { toTarget: [5, -1.5, -150], seconds: 70, fov: 20 }),
};

export default function HillsSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
