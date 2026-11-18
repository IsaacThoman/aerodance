import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Bubbles' views. Everything here is laid out in fractions of the menu camera's frame and wraps
 * just beyond its top and bottom, so a view has to stay inside that frame: the depths as the menu
 * frames them (the scene's own camera, 'depths'), and a longer lens drifting across the bubbles
 * from the middle to the big ones on the right.
 */

const VIEWS: Record<string, Shot> = {
  bubbles: dolly([0, 0, 10], [0.15, 0, 10], [0.3, -0.3, 0], { toTarget: [2.6, 0.3, 0], seconds: 80, fov: 30 }),
};

export default function BubblesSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
