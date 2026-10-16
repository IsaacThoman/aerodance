import * as THREE from 'three';
import type { BubbleSpec } from './bubbles.ts';
import type { CityBuilder } from './cityBuilder.ts';
import type { AeroContext } from './context.ts';
import type { FlightPath } from './flight.ts';
import { spireTower, tower, twistTower } from './towers.ts';
import type { TreeSpec } from './trees.ts';
import { TAU, clamp, col } from './util.ts';

/** True inside the street-grid districts around downtown (east/west and north of the lake). */
export const inDistrict = (x: number, z: number) => (Math.abs(x) > 245 && Math.abs(x) < 665 && z > -245 && z < 245) || (z < -525 && z > -735 && Math.abs(x) < 665);

export interface CityOptions {
  grassTex: THREE.Texture;
  path: FlightPath;
  /** Park bubbles are added here; they are built later with the rest. */
  bubbles: BubbleSpec[];
  /** District trees are planted here (city trees go to the builder's own list). */
  districtTrees: TreeSpec[];
}

export interface City {
  /** Park ponds; the lake section gives them a ripple normal map. */
  pondMat: THREE.MeshStandardMaterial;
}

/** Downtown, its parks and landmarks, and the outer street-grid districts. */
export function buildCity(ctx: AeroContext, b: CityBuilder, { grassTex, path, bubbles, districtTrees }: CityOptions): City {
  const { root } = ctx;
  const { R, rnd, pick, withRng } = ctx.random;

  /* ------------------------------------------------------------------ parks */
  const parkMat = new THREE.MeshLambertMaterial({ map: grassTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const pondMat = new THREE.MeshStandardMaterial({ color: col('#3aa6e0'), metalness: 0.5, roughness: 0.05, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  function park(cx: number, cz: number, withBubbles = true) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(44, 44), parkMat);
    m.rotation.x = -Math.PI / 2; m.position.set(cx, 0.1, cz); m.receiveShadow = true; root.add(m);
    const px = cx + R(-6, 6), pz = cz + R(-6, 6);
    const pond = new THREE.Mesh(new THREE.CircleGeometry(7, 40), pondMat);
    pond.rotation.x = -Math.PI / 2; pond.position.set(px, 0.15, pz); root.add(pond);
    b.cyl('trim', px, 0.25, pz, 7.4, 0.5, 40);
    b.cyl('trim', px, 0.9, pz, 0.6, 1.6, 12); b.cyl('trim', px, 1.8, pz, 1.6, 0.3, 16);
    // curved footpath ring
    const ring = new THREE.RingGeometry(12, 13.6, 48); ring.rotateX(-Math.PI / 2); ring.translate(px, 0.2, pz); b.add('deck', ring);
    for (let i = 0; i < 16; i++) {
      const x = cx + R(-19, 19), z = cz + R(-19, 19), dd = Math.hypot(x - px, z - pz);
      if (dd > 9 && Math.abs(dd - 12.8) > 1.8) b.tree(x, z, R(1.5, 2.4), pick(['round', 'round', 'conifer', 'poplar'] as const));
    }
    for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.4; b.box('podium', px + Math.cos(a) * 14.6, 0.45, pz + Math.sin(a) * 14.6, 2.2, 0.15, 0.7, -a); }
    if (withBubbles) for (let i = 0; i < 5; i++) bubbles.push({ x: cx + R(-15, 15), y: R(3, 20), z: cz + R(-15, 15), r: R(1, 3), rise: R(1.5, 3), range: 45 });
  }

  /* ----------------------------------------------------------- city blocks */
  const parks = new Set(['-2,1', '1,2', '2,-2', '-1,-2']);
  const landmarks = new Set(['0,0', '1,-1']);
  twistTower(b, 0, 0, 30, 290, Math.PI / 2);
  spireTower(b, 70, -70);
  // A pair of slim towers, optionally joined by a glass sky bridge at a random height.
  function skyBridge(cx: number, cz: number, ax: boolean, dims: [number, number][], hs: number[], minHeight: number) {
    const gap = ax ? 22 - (dims[0][0] + dims[1][0]) / 2 : 22 - (dims[0][1] + dims[1][1]) / 2;
    if (gap > 1.5 && Math.min(...hs) > minHeight) {
      const by = Math.min(...hs) * R(0.35, 0.6), len = gap + 1;
      b.box('lobby', cx, by, cz, ax ? len : 5, 4, ax ? 5 : len);
      b.box('trim', cx, by + 2.2, cz, ax ? len : 5.6, 0.4, ax ? 5.6 : len);
      b.box('trim', cx, by - 2.2, cz, ax ? len : 5.6, 0.4, ax ? 5.6 : len);
    }
  }
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const key = i + ',' + j, cx = i * 70, cz = j * 70;
    if (landmarks.has(key)) continue;
    if (parks.has(key)) { park(cx, cz); continue; }
    const cf = Math.exp(-(cx * cx + cz * cz) / (2 * 130 * 130));
    const H = () => 40 + 175 * cf * R(0.55, 1.15) + R(0, 45);
    const r = rnd();
    if (r < 0.28) tower(b, cx + R(-2, 2), cz + R(-2, 2), R(26, 35), R(26, 35), H() + 15);
    else if (r < 0.66) {
      const ax = rnd() < 0.5, dims: [number, number][] = [], hs: number[] = [];
      for (const s of [-1, 1]) {
        const w = ax ? R(13, 17) : R(24, 37), d = ax ? R(24, 37) : R(13, 17), h = H();
        tower(b, cx + (ax ? s * 11 : 0), cz + (ax ? 0 : s * 11), w, d, h); dims.push([w, d]); hs.push(h);
      }
      skyBridge(cx, cz, ax, dims, hs, -Infinity);
    } else for (const sx of [-1, 1]) for (const sz of [-1, 1]) tower(b, cx + sx * 11 + R(-1, 1), cz + sz * 11 + R(-1, 1), R(11, 16), R(11, 16), H() * R(0.7, 1));
  }
  // The original sparse outer skyline is still generated with the main random stream so
  // everything after it keeps its layout, but its geometry is discarded and replaced by the
  // street-grid districts below.
  b.sink = true;
  for (const sg of [-1, 1]) for (let gx = 275; gx < 720; gx += 36) for (let gz = -228; gz <= 230; gz += 36) {
    if (rnd() > 0.55) continue;
    const fall = 1 - (gx - 270) / 560;
    tower(b, sg * (gx + R(-5, 5)), gz + R(-5, 5), R(13, 24), R(13, 24), 35 + R(20, 140) * fall, true);
  }
  for (let gx = -720; gx <= 720; gx += 38) for (let gz = -530; gz >= -820; gz -= 38) {
    if (rnd() > 0.5) continue;
    tower(b, gx + R(-6, 6), gz + R(-6, 6), R(14, 26), R(14, 26), R(50, 185), true);
  }
  b.sink = false;

  /* --------------------------------------------- outer districts on a street grid */
  // Grid: blocks are 70 m, centred on multiples of 70, streets on 35 + 70k (same as downtown).
  // East/west districts: |i| 4..9, j -3..3. North district (across the lake): j -8..-10.
  function maxTowerH(x: number, z: number, r: number) {
    let lim = 1e9;
    for (const p of path.points) { const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz < (r + 35) ** 2) lim = Math.min(lim, p.y - 50); }
    return lim;
  }
  function districtBlock(cx: number, cz: number) {
    const scale = clamp(1.3 - Math.hypot(cx, cz) / 650, 0.35, 1);
    const r = rnd();
    if (r < 0.1) { park(cx, cz, false); return; }
    const H = () => 32 + R(25, 150) * scale + R(0, 20);
    const place = (x: number, z: number, w: number, d: number, h0: number) => {
      const h = Math.min(h0, maxTowerH(x, z, Math.max(w, d) * 0.75));
      if (h < 16) { for (let k = 0; k < 4; k++) b.tree(x + R(-w / 3, w / 3), z + R(-d / 3, d / 3), R(1.4, 2.2)); return 0; }
      tower(b, x, z, w, d, h, false);
      return h;
    };
    if (r < 0.32) place(cx + R(-2, 2), cz + R(-2, 2), R(24, 34), R(24, 34), H() + 10);
    else if (r < 0.68) {
      const ax = rnd() < 0.5, dims: [number, number][] = [], hs: number[] = [];
      for (const sd of [-1, 1]) {
        const w = ax ? R(13, 17) : R(24, 37), d = ax ? R(24, 37) : R(13, 17);
        hs.push(place(cx + (ax ? sd * 11 : 0), cz + (ax ? 0 : sd * 11), w, d, H())); dims.push([w, d]);
      }
      skyBridge(cx, cz, ax, dims, hs, 40);
    } else for (const sx of [-1, 1]) for (const sz of [-1, 1]) place(cx + sx * 11 + R(-1, 1), cz + sz * 11 + R(-1, 1), R(11, 16), R(11, 16), H() * R(0.6, 1));
  }
  withRng(424242, () => {
    const cityTrees = b.treeList;
    b.treeList = districtTrees;
    for (let i = -9; i <= 9; i++) for (let j = -10; j <= 3; j++) {
      const east = Math.abs(i) >= 4 && Math.abs(j) <= 3, north = j <= -8;
      if (east || north) districtBlock(i * 70, j * 70);
    }
    b.treeList = cityTrees;
  });
  return { pondMat };
}
