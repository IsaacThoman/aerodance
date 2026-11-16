import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Ribbons' views. The ribbons are sweeps a little wider than the menu's frame, so the views stay
 * in front of them looking the same way, never far enough back or to the side to see where they
 * end: both sweeps under the light, a glide along the hero sweep towards the light, and one up the
 * aqua sweep as it rises to it.
 */

const VIEWS: Record<string, Shot> = {
  sweep: dolly([-1, 1, 17], [3, 1.6, 16], [1, 1.8, 0], { toTarget: [4, 2.2, 0], seconds: 80, fov: 48 }),
  light: dolly([-6, 5, 13], [6, 4, 13], [-3, 4.5, 0], { toTarget: [9, 4.5, 0], seconds: 90, fov: 42 }),
  aqua: dolly([-4, -6, 13], [8, -4, 13], [-1, -8, 0], { toTarget: [12, -4, 0], seconds: 90, fov: 42 }),
};

export default function RibbonsSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
