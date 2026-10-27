import * as THREE from 'three';
import { makeRandom, smoothstep } from '../shared/random.ts';
import { cabinClearance } from './layout.ts';

// Where the 3D spruces stand round the clearing, and which way the moon throws their shadows.

/** How many spruce shapes there are (Pines.tsx), each one instanced mesh. */
export const VARIANTS = 3;

/** Towards the moon from the clearing: the shadow-casting light sits along it. */
export const MOON_LIGHT = new THREE.Vector3(-14, 12, 5);

export interface PineSpot {
  x: number;
  z: number;
  height: number;
  turn: number;
  variant: number;
}

/** The ring round the clearing: thick behind the camera and down the sides, a few framing the cabin and the meadow. */
function layoutPines(): PineSpot[] {
  const rand = makeRandom(77);
  const spots: PineSpot[] = [];
  const add = (x: number, z: number, height: number) => spots.push({ x, z, height, turn: rand.range(0, Math.PI * 2), variant: spots.length % VARIANTS });
  // Picked by hand, for the view from the front.
  for (const [x, z, h] of [
    [17.5, -14, 15], [21, -9, 18], [23, -21, 21], [13.5, -27, 10], [27, -5, 16],
    [-25.5, -26, 19], [-21, -33, 16], [-29, -15, 17], [-30, -4, 20], [-25, 3, 14],
    [33, -26, 22], [16.5, -33, 13],
  ] as const) {
    add(x, z, h);
  }
  for (let tries = 0; tries < 2000 && spots.length < 58; tries++) {
    // a: 0 straight out beyond the dancers, where the meadow stays open.
    const a = rand.range(-Math.PI, Math.PI);
    const r = rand.range(28, 70);
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r;
    if (Math.abs(a) < 0.75 + smoothstep(30, 58, r) * -0.25) continue;
    if (cabinClearance(x, z) < 3) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 5.5)) continue;
    add(x, z, rand.range(10, 20) * (0.8 + r / 140));
  }
  return spots;
}

export const PINES: readonly PineSpot[] = layoutPines();

/** The spruces whose moon shadows reach into the clearing, nearest first, for the snow to darken. */
export const SHADOW_PINES: readonly PineSpot[] = (() => {
  const toward = new THREE.Vector2(MOON_LIGHT.x, MOON_LIGHT.z);
  const reach = toward.length() / MOON_LIGHT.y;
  toward.normalize();
  return PINES.map((p) => {
    // The shadow's tip, and how close it comes to the middle.
    const tip = new THREE.Vector2(p.x, p.z).addScaledVector(toward, -p.height * reach);
    return { p, near: Math.min(tip.length(), Math.hypot(p.x, p.z)) };
  })
    .filter(({ near }) => near < 26)
    .sort((a, b) => a.near - b.near)
    .slice(0, 10)
    .map(({ p }) => p);
})();
