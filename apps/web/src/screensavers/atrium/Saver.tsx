import { dolly, orbit, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Atrium's views. It's the atrium stage's whole round room, built to be walked round, so the
 * camera can circle inside it: in from the entrance towards the aquarium column, round the column
 * on the floor by the pool, and slowly round under the ribbed dome, looking up.
 */

// The aquarium column's foot (packages/stages/atrium/layout.ts AXIS).
const AXIS = [0, 0, -8] as const;

// Circling the column inside the pool's rim, looking up past the gallery to the dome's crown.
const dome: Shot = (t) => {
  const a = (t / 300) * Math.PI * 2 + 0.6;
  const s = Math.sin(a), c = Math.cos(a);
  return { position: [AXIS[0] + s * 6, 3.5, AXIS[2] + c * 6], target: [AXIS[0] - s * 9, 17, AXIS[2] - c * 9], fov: 60 };
};

const VIEWS: Record<string, Shot> = {
  atrium: dolly([0, 2.3, 4.6], [0, 2.8, 1.8], [0, 6.2, -8], { toTarget: [0, 7.2, -8], seconds: 70, fov: 56 }),
  column: orbit([AXIS[0], 6, AXIS[2]], 8, -3, { seconds: 200, fov: 56, bob: 0.3 }),
  dome,
};

export default function AtriumSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
