import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { inDistrict } from './city.ts';
import type { AeroContext } from './context.ts';
import { col, paintGeo } from './util.ts';

/** Downtown street centre lines (both axes). */
export const STREETS = [-175, -105, -35, 35, 105, 175];

/* ------------------------------------------------------------ street lamps */
export function buildStreetLamps(ctx: AeroContext) {
  const LAMPS: [x: number, z: number, ry: number][] = [];
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, hex: string) => { const c = col(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; };
  let g: THREE.BufferGeometry = new THREE.CylinderGeometry(0.08, 0.14, 7, 6); g.translate(0, 3.5, 0); parts.push(paint(g, '#e9eef3'));
  g = new THREE.BoxGeometry(0.1, 0.1, 2.2); g.translate(0, 6.9, 1.0); parts.push(paint(g, '#e9eef3'));
  g = new THREE.BoxGeometry(0.5, 0.18, 0.9); g.translate(0, 6.8, 2.0); parts.push(paint(g, '#ffffff'));
  g = new THREE.CylinderGeometry(0.22, 0.26, 0.4, 8); g.translate(0, 0.2, 0); parts.push(paint(g, '#8a99a8'));
  const lampGeo = mergeGeometries(parts); parts.forEach((p) => p.dispose());
  for (const c of STREETS) for (let s = -238; s <= 238; s += 30) {
    if (STREETS.some((o) => Math.abs(o - s) < 14)) continue;
    LAMPS.push([c + 9.5, s, -Math.PI / 2], [c - 9.5, s, Math.PI / 2], [s, c + 9.5, Math.PI], [s, c - 9.5, 0]);
  }
  // lamps along the district streets
  const nearCross = (v: number) => { const m = (((v - 35) % 70) + 70) % 70; return m < 13 || m > 57; };
  for (let c = -665; c <= 665; c += 70) for (let s = -735; s <= 245; s += 35) {
    if (nearCross(s)) continue;
    for (const [x, z, ry] of [[c + 9.5, s, -Math.PI / 2], [c - 9.5, s, Math.PI / 2]]) if (inDistrict(x, z)) LAMPS.push([x, z, ry]);
  }
  for (let c = -735; c <= 245; c += 70) for (let s = -665; s <= 665; s += 35) {
    if (nearCross(s)) continue;
    for (const [x, z, ry] of [[s, c + 9.5, Math.PI], [s, c - 9.5, 0]]) if (inDistrict(x, z)) LAMPS.push([x, z, ry]);
  }
  const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), LAMPS.length);
  const d = new THREE.Object3D();
  LAMPS.forEach(([x, z, ry], i) => { d.position.set(x, 0, z); d.rotation.set(0, ry, 0); d.updateMatrix(); lamps.setMatrixAt(i, d.matrix); });
  lamps.castShadow = true; ctx.root.add(lamps);
}

/* ------------------------------------------------------------------- cars */
/** A car driving along one street: on the line x = c (ax) or z = c, between lo and hi. */
interface Car { ax: boolean; c: number; dir: number; s: number; v: number; lo: number; hi: number }

function moveCars(mesh: THREE.InstancedMesh, list: Car[], dt: number, dmy: THREE.Object3D) {
  for (let i = 0; i < list.length; i++) {
    const c = list[i]; c.s += c.dir * c.v * dt; if (c.s > c.hi) c.s = c.lo; if (c.s < c.lo) c.s = c.hi;
    if (c.ax) dmy.position.set(c.c, 0, c.s); else dmy.position.set(c.s, 0, c.c);
    dmy.rotation.set(0, (c.ax ? 0 : Math.PI / 2) + (c.dir < 0 ? Math.PI : 0), 0); dmy.updateMatrix(); mesh.setMatrixAt(i, dmy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export interface Traffic {
  /** `scratch` is a reusable Object3D for building instance matrices. */
  update(dt: number, scratch: THREE.Object3D): void;
}

/** Downtown and district traffic. */
export function buildTraffic(ctx: AeroContext): Traffic {
  const { root } = ctx;
  const { R, RI, rnd, pick } = ctx.random;
  const Q = ctx.quality.Q;
  const CARN = Math.round(170 * Q);
  const carGeo = (() => {
    const paint = (g: THREE.BufferGeometry, hex: string) => { g.deleteAttribute('uv'); return paintGeo(g.toNonIndexed(), (x, y, z, c) => c.copy(col(hex))); };
    const a = new THREE.BoxGeometry(1.9, 0.75, 4.4); a.translate(0, 0.62, 0);
    const b = new THREE.BoxGeometry(1.7, 0.6, 2.3); b.translate(0, 1.27, -0.2);
    const wl: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const w = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 10); w.rotateZ(Math.PI / 2); w.translate(sx * 0.9, 0.34, sz * 1.4); wl.push(paint(w, '#22262b')); }
    const g = mergeGeometries([paint(a, '#ffffff'), paint(b, '#3a5470'), ...wl]);
    return g;
  })();
  const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cars = new THREE.InstancedMesh(carGeo, carMat, CARN);
  const CARS: Car[] = [];
  const carCols = ['#ffffff', '#e8edf2', '#2a7bff', '#ff4040', '#ffd23a', '#28b46a', '#2b3036', '#9aa7b4'];
  for (let i = 0; i < CARN; i++) {
    const dir = rnd() < 0.5 ? 1 : -1;
    CARS.push({ ax: rnd() < 0.5, c: pick(STREETS) + dir * 4, dir, s: R(-245, 245), v: R(7, 12), lo: -245, hi: 245 });
    cars.setColorAt(i, col(pick(carCols)));
  }
  cars.frustumCulled = false; root.add(cars);
  // traffic on the district streets
  const DCARS: Car[] = [];
  const dcarN = Math.round(260 * Q);
  const dcars = new THREE.InstancedMesh(carGeo, carMat, dcarN);
  ctx.random.withRng(616161, () => {
    for (let i = 0; i < dcarN; i++) {
      const dir = rnd() < 0.5 ? 1 : -1, east = rnd() < 0.55;
      let car: Pick<Car, 'ax' | 'c' | 'lo' | 'hi'>;
      if (east) { // east/west districts: N-S streets x = ±(315..665), or E-W streets z in -175..245 over |x| 245..665
        const sg = rnd() < 0.5 ? -1 : 1;
        car = rnd() < 0.5
          ? { ax: true, c: sg * (315 + 70 * RI(0, 5)) + dir * 4, lo: -245, hi: 245 }
          : { ax: false, c: -175 + 70 * RI(0, 6) + dir * 4, lo: sg > 0 ? 245 : -665, hi: sg > 0 ? 665 : -245 };
      } else { // north district
        car = rnd() < 0.5
          ? { ax: true, c: -665 + 70 * RI(0, 19) + dir * 4, lo: -735, hi: -525 }
          : { ax: false, c: -595 - 70 * RI(0, 2) + dir * 4, lo: -665, hi: 665 };
      }
      DCARS.push({ ...car, dir, s: R(car.lo, car.hi), v: R(7, 12) });
      dcars.setColorAt(i, col(pick(carCols)));
    }
  });
  dcars.frustumCulled = false; root.add(dcars);
  return {
    update(dt, scratch) {
      moveCars(cars, CARS, dt, scratch);
      moveCars(dcars, DCARS, dt, scratch);
    },
  };
}
