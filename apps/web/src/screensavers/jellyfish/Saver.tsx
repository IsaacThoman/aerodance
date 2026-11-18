import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Jellyfish's views. The drifting jellies wrap round just beyond the menu camera's 4:3 frame, so
 * every view stays inside that frame wherever they could be (checked over each move, at 16:9 and
 * 4:3): the open water as the menu frames it ('water', the scene's own camera), close by the big
 * sea nettle, and by the moon jelly with its glowing gonads.
 */

const VIEWS: Record<string, Shot> = {
  nettle: dolly([0.6, 3.2, 10.8], [1.6, 3.7, 9.6], [2, 4.1, 2], { toTarget: [2, 4.3, 2], seconds: 70, fov: 36 }),
  moon: dolly([-4.3, 5.2, 4.6], [-5.0, 5.6, 4.0], [-6.4, 7.2, -2.4], { toTarget: [-6.6, 7.6, -2.4], seconds: 70, fov: 30 }),
};

export default function JellyfishSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
