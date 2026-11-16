import { dolly, useCameraViews } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Orbit's views. Space, the stars and the Moon are drawn about the camera wherever it is, so the
 * station can be circled; the sun is placed on the planet's limb as seen from the menu camera,
 * though, so the views that show it rising stand there. The Earth as the menu frames it ('earth',
 * the scene's own camera), a long lens along the limb to the sunrise, and the station swinging
 * slowly to and fro in front of the Earth.
 */

// Where the station hangs (packages/backdrops/orbit/Station.tsx: 52 units out through (0.41, 0.16) of the frame).
const STATION = [-5.8, 12.4, -50.2] as const;

const station: Shot = (t) => {
  const a = -0.5 + 0.9 * Math.sin((t / 150) * Math.PI * 2);
  return { position: [STATION[0] + Math.sin(a) * 15, STATION[1] + 2 + Math.sin(t * 0.05) * 0.6, STATION[2] + Math.cos(a) * 15], target: [...STATION], fov: 40 };
};

const VIEWS: Record<string, Shot> = {
  sunrise: dolly([0, 0, 0], [-1.5, 2, 5], [30, 10.5, -92.5], { toTarget: [34, 13, -92], seconds: 80, fov: 22 }),
  station,
};

export default function OrbitSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, VIEWS);
  return null;
}
