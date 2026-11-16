import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Dewdrops' views. The leaves are placed in the menu camera's frame, their focus painted on, so
 * the views stay near that camera and only lean in on what it sees, on longer lenses: the whole
 * leaf ('leaf', the scene's own camera), along the beaded leaf, the drop gathering at its tip, and
 * the ladybug wandering the leaf below.
 */

const VIEWS: Record<string, Shot> = {
  drops: dolly([4.8, 2.2, 6], [2.6, 1.4, 6], [4.6, 2.6, 0], { toTarget: [2.4, 1.6, 0], seconds: 80, fov: 30 }),
  drip: dolly([1.0, 0.5, 5.5], [1.4, 0.7, 5.2], [0.8, 0.9, 0], { toTarget: [0.7, 0.8, 0], seconds: 60, fov: 26 }),
  ladybug: dolly([-4.0, -2.0, 6.5], [-3.2, -2.4, 6.3], [-4.2, -3.0, 1.5], { toTarget: [-3.6, -3.2, 1.5], seconds: 70, fov: 28 }),
};

export default function DewSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
