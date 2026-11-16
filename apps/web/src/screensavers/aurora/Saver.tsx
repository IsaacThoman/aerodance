import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Aurora's views. The scene is built to be seen across the lake from its near side (the mist
 * lies in flat bands facing that way, and the land is a strip of shore and peaks), so the views
 * stay out over the water looking north: the whole lake, a slow glide in towards the cabin, and
 * the curtains overhead with the peaks below.
 */

const VIEWS: Record<string, Shot> = {
  lake: dolly([-26, 4.5, 24], [26, 4, 24], [-9, 15, -200], { toTarget: [9, 15, -200], seconds: 90, fov: 50 }),
  cabin: dolly([10, 5, -55], [-3, 3, -122], [6, 11, -214], { toTarget: [6, 8, -214], seconds: 75, fov: 40 }),
  sky: dolly([-6, 2, 12], [6, 2, 12], [-190, 138, -400], { toTarget: [70, 117, -400], seconds: 110, fov: 55 }),
};

export default function AuroraSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
