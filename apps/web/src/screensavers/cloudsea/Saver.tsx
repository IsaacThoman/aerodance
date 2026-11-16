import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';
import { AirshipBillboard } from './Billboard.tsx';

/*
 * Cloud Sea's views. The deck is a fan of rows built out from under the menu camera, about 50°
 * either side of straight ahead, so every view keeps looking roughly the way it does (never more
 * than about 15° off, with the frame's edge inside the fan): a glide towards the sunrise, and
 * closer by the airship and the garden pods, which hang where the menu frames them. In scene,
 * the time is lit up on the airship's flank (Billboard.tsx), which the Airship view looks at.
 */

const VIEWS: Record<string, Shot> = {
  sunrise: dolly([0, 44, 60], [6, 41, 5], [170, -60, -940], { toTarget: [176, -63, -995], seconds: 100, fov: 45 }),
  airship: dolly([-47, 52, -28], [-57, 50, -56], [-68, 54, -111], { toTarget: [-69, 53, -112], seconds: 70, fov: 40 }),
  pods: dolly([95, 52, -40], [108, 50, -75], [150, 70, -220], { toTarget: [140, 66, -205], seconds: 80, fov: 36 }),
};

export default function CloudSeaSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return <AirshipBillboard ctx={ctx} />;
}
