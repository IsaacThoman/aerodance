import { KOI } from '../../../../../packages/backdrops/koi/layout.ts';
import type { KoiSwim } from '../../../../../packages/backdrops/koi/layout.ts';
import { backdropClock } from '../../../../../packages/backdrops/shared/frame.ts';
import { dolly, orbit, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Koi Pond's views. The pond is a floor plane seen from above, with nothing past its edges, so
 * every view looks steeply down on it: the whole pond drifting by, one koi followed on its loop,
 * the lotus cluster circled close, and the pond turning slowly straight overhead.
 */

// Where a koi is on its loop at backdrop time t (packages/backdrops/koi/Koi.tsx swimAt).
function swimAt(k: KoiSwim, t: number): [number, number] {
  const s = k.phase + k.speed * t;
  const cx = k.centre[0] + Math.sin(t * 0.021 + k.phase * 3) * k.wander;
  const cz = k.centre[1] + Math.cos(t * 0.017 + k.phase * 5) * k.wander * 0.7;
  return [cx + Math.cos(s) * k.radius[0] + Math.cos(k.lobes * s + k.phase) * k.lobe, cz + Math.sin(s) * k.radius[1] + Math.sin(k.lobes * s + k.phase) * k.lobe];
}

// The kohaku, the biggest, cruising the open middle: the camera follows the average of where it
// was and will be over a few seconds, so it glides after the fish rather than snapping to it.
const FOLLOWED = KOI[0];
const follow: Shot = () => {
  const t = backdropClock.time;
  let x = 0, z = 0;
  for (let i = -4; i <= 4; i++) { const [px, pz] = swimAt(FOLLOWED, t + i * 0.75); x += px / 9; z += pz / 9; }
  return { position: [x, 6.2, z + 2.2], target: [x, -0.5, z - 0.2], fov: 40 };
};

// Straight down, the pond turning a full circle every six minutes.
const overhead: Shot = (t) => {
  const a = (t / 360) * Math.PI * 2;
  return { position: [0.6 + Math.sin(a) * 0.4, 10.5, -1.4 + Math.cos(a) * 0.4], target: [0.6, -0.6, -1.4], fov: 40 };
};

const VIEWS: Record<string, Shot> = {
  pond: dolly([-1.6, 10.2, 6.4], [1.6, 9.8, 5.6], [-0.6, -0.6, -0.4], { toTarget: [0.6, -0.6, -0.8], seconds: 70, fov: 40 }),
  koi: follow,
  lotus: orbit([6.7, 0, -4.1], 3.2, 5.5, { seconds: -150, start: 0.6, fov: 40, bob: 0.25 }),
  overhead,
};

export default function KoiSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
