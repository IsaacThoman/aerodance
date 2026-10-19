import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import type { CityBuilder } from './cityBuilder.ts';
import type { AeroContext } from './context.ts';
import { createLakeNormalPixels, type LakeWave } from './lakeNormals.ts';
import { ReflectionRefresh } from './reflectionRefresh.ts';
import { TAU, canvas2d, col } from './util.ts';

/** Small tiling ripple normal map for the park ponds. */
function waterNormal(ctx: AeroContext) {
  const S = 256, { c, g } = canvas2d(S, S), im = g.createImageData(S, S), a = TAU / S;
  const H = (x: number, y: number) => Math.sin(x * a * 3 + y * a * 2) * 0.5 + Math.sin(x * a * 7 - y * a * 5) * 0.3 + Math.sin(x * a * 13 + y * a * 11) * 0.15 + Math.sin(-x * a * 4 + y * a * 9) * 0.25 + Math.sin(x * a * 21 - y * a * 17) * 0.06;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * 5, ny = -(H(x, y + 1) - H(x, y - 1)) * 5, nz = 1, l = Math.hypot(nx, ny, nz), i = (y * S + x) * 4;
    im.data[i] = (nx / l * 0.5 + 0.5) * 255; im.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; im.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return ctx.tex(c, true, false);
}

/** Quay walls, ferry piers and the arched bridge (static city geometry); returns the pond ripple map. */
export function buildLakeShore(ctx: AeroContext, b: CityBuilder, pondMat: THREE.MeshStandardMaterial) {
  const wNorm = waterNormal(ctx); wNorm.repeat.set(60, 6);
  pondMat.normalMap = wNorm;
  // Quay walls with glass railings along both shores
  for (const qz of [-265, -485]) {
    b.box('podium', 0, 0.1, qz, 2400, 2.2, 2.6);
    b.box('trim', 0, 1.25, qz, 2400, 0.1, 3);
    b.box('lobby', 0, 1.85, qz + (qz > -375 ? 1.1 : -1.1), 2400, 1.1, 0.12);
    for (let x = -1190; x <= 1190; x += 10) b.box('trim', x, 1.85, qz + (qz > -375 ? 1.1 : -1.1), 0.18, 1.2, 0.18);
  }
  // Ferry piers
  for (const [px, qz, dir] of [[-150, -265, -1], [420, -265, -1], [-330, -485, 1], [60, -485, 1]]) {
    b.box('deck', px, 0.9, qz + dir * 14, 6, 0.6, 26);
    for (let k = 0; k < 4; k++) for (const sx of [-1, 1]) b.cyl('dark', px + sx * 2.6, 0.2, qz + dir * (4 + k * 7), 0.25, 2, 6);
    b.box('lobby', px, 2.6, qz + dir * 24, 5, 2.8, 4);
    b.box('trim', px, 4.15, qz + dir * 24, 6, 0.3, 5);
  }
  const bx = 200, z0 = -255, z1 = -495, dy = 12;
  b.box('deck', bx, dy, (z0 + z1) / 2, 14, 1.6, Math.abs(z1 - z0));
  for (let z = z0 - 8; z > z1; z -= 22) b.box('deck', bx, dy / 2, z, 6, dy, 3);
  for (const sx of [-1, 1]) {
    b.box('bridge', bx + sx * 6.5, dy + 1.5, (z0 + z1) / 2, 0.5, 1.4, 240);
    const tg = new THREE.TorusGeometry(70, 1.1, 8, 64, Math.PI); tg.scale(1, 0.55, 1); tg.rotateY(Math.PI / 2); tg.translate(bx + sx * 6, dy, -375); b.add('bridge', tg);
    for (let a = 0.18; a < Math.PI - 0.15; a += Math.PI / 18) { const zz = -375 + Math.cos(a) * 70, top = dy + Math.sin(a) * 70 * 0.55; b.box('bridge', bx + sx * 6, (dy + top) / 2, zz, 0.35, top - dy, 0.35); }
  }
  for (let a = 0.5; a < Math.PI - 0.45; a += Math.PI / 12) { const zz = -375 + Math.cos(a) * 70, top = dy + Math.sin(a) * 70 * 0.55; b.box('bridge', bx, top, zz, 12, 0.8, 0.8); }
  return wNorm;
}

function lakeNormals(ctx: AeroContext) {
  const { R } = ctx.random;
  // Seamless ripple normal map: a sum of waves with whole-number frequencies so it tiles.
  const S = 512, { c, g } = canvas2d(S, S), im = g.createImageData(S, S);
  const waves = ctx.random.withRng(8080, () => Array.from({ length: 48 }, (): LakeWave => {
    const k = 2 + Math.floor(R(0, 1) ** 2 * 40), a = R(0, TAU);
    return [Math.round(Math.cos(a) * k), Math.round(Math.sin(a) * k), R(0, TAU), 1 / (k ** 1.1)];
  }));
  createLakeNormalPixels(S, waves, im.data);
  g.putImageData(im, 0, 0);
  return ctx.tex(c, true, false);
}

// @types/three leaves Water's uniforms untyped; these are the ones the world drives.
interface WaterUniforms {
  [uniform: string]: THREE.IUniform;
  time: THREE.IUniform<number>;
  eye: THREE.IUniform<THREE.Vector3>;
  size: THREE.IUniform<number>;
}

interface Boat { g: THREE.Group; x: number; z: number; dir: number; v: number; ph: number; heel: number }

function buildBoats(ctx: AeroContext, glassMat: THREE.Material) {
  const { root, tex } = ctx;
  const { R, rnd, pick } = ctx.random;
  const BOATS: Boat[] = [];
  const hullShape = new THREE.Shape();
  hullShape.moveTo(0, 4.2); hullShape.quadraticCurveTo(1.5, 2, 1.3, -3.6); hullShape.lineTo(-1.3, -3.6); hullShape.quadraticCurveTo(-1.5, 2, 0, 4.2);
  const hull = new THREE.ExtrudeGeometry(hullShape, { depth: 1.1, bevelEnabled: true, bevelSize: 0.15, bevelThickness: 0.15, bevelSegments: 2, curveSegments: 10 });
  hull.rotateX(-Math.PI / 2); hull.rotateY(Math.PI); hull.translate(0, -0.3, 0);
  const deck = new THREE.ShapeGeometry(hullShape, 10); deck.rotateX(-Math.PI / 2); deck.rotateY(Math.PI); deck.scale(0.9, 1, 0.9); deck.translate(0, 0.98, 0);
  const sail = new THREE.Shape(); sail.moveTo(0, 0); sail.lineTo(0, 9); sail.lineTo(3.4, 0.4); sail.closePath();
  const jib = new THREE.Shape(); jib.moveTo(0, 0); jib.lineTo(0, 7.5); jib.lineTo(-2.6, 0.2); jib.closePath();
  const sailGeo = new THREE.ShapeGeometry(sail); sailGeo.rotateY(Math.PI / 2); sailGeo.translate(0, 1.6, -0.4);
  const jibGeo = new THREE.ShapeGeometry(jib); jibGeo.rotateY(Math.PI / 2); jibGeo.translate(0, 1.4, 0.4);
  const { c: wc, g: wg } = canvas2d(128, 256);
  for (let i = 0; i < 260; i++) { const t = rnd(), y = t * 256, spread = 6 + t * 54, side = rnd() < 0.5 ? -1 : 1; wg.fillStyle = `rgba(255,255,255,${(0.75 * (1 - t)).toFixed(2)})`; wg.beginPath(); wg.arc(64 + side * spread * R(0.75, 1), y, R(1.5, 3.5) * (1 - t * 0.5), 0, TAU); wg.fill(); }
  const wakeMat = new THREE.MeshBasicMaterial({ map: tex(wc), transparent: true, depthWrite: false, fog: true });
  const wakeGeo = new THREE.PlaneGeometry(7, 26); wakeGeo.rotateX(-Math.PI / 2); wakeGeo.translate(0, 0.08, -16);
  const hullMats = ['#ffffff', '#e8f1fa', '#ffffff', '#1d5ec8'].map((h) => new THREE.MeshStandardMaterial({ color: col(h), roughness: 0.35, metalness: 0.05 }));
  const deckMat = new THREE.MeshLambertMaterial({ color: col('#c89a62') });
  const sailMats = ['#ffffff', '#fff7e6', '#ff6a3d', '#2fb3ff'].map((h) => new THREE.MeshLambertMaterial({ color: col(h), side: THREE.DoubleSide }));
  const mastMat = new THREE.MeshLambertMaterial({ color: col('#d9dee4') });
  for (let i = 0; i < 12; i++) {
    const g = new THREE.Group(), sailing = i < 8;
    g.add(new THREE.Mesh(hull, pick(hullMats)), new THREE.Mesh(deck, deckMat));
    if (sailing) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 10, 6), mastMat); mast.position.y = 6; g.add(mast);
      const sm = pick(sailMats);
      g.add(new THREE.Mesh(sailGeo, sm), new THREE.Mesh(jibGeo, rnd() < 0.5 ? sm : sailMats[0]));
    } else {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1, 2.4), glassMat); cab.position.set(0, 1.5, 0.4); g.add(cab);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2, 0.15, 2.8), hullMats[0]); roof.position.set(0, 2.05, 0.3); g.add(roof);
    }
    const wake = new THREE.Mesh(wakeGeo, wakeMat); wake.renderOrder = 1; g.add(wake);
    const dir = rnd() < 0.5 ? 1 : -1;
    g.scale.setScalar(sailing ? 1 : 0.85);
    root.add(g); ctx.moving.push(g);
    BOATS.push({ g, x: R(-600, 600), z: R(-450, -300), dir, v: sailing ? R(1.5, 3) : R(4, 7), ph: R(0, TAU), heel: sailing ? R(0.08, 0.16) : 0 });
  }
  return BOATS;
}

export interface Lake {
  update(t: number, dt: number, camera: THREE.Camera): void;
  /** Diagnostics: false stops the reflection pass (the water keeps its last reflection). */
  reflect: boolean;
}

/** The reflective lake and its boats. */
export function buildLake(ctx: AeroContext, wNorm: THREE.Texture, glassMat: THREE.Material): Lake {
  const small = ctx.quality.small;
  const lakeGeo = new THREE.PlaneGeometry(2400, 220);
  const water = new Water(lakeGeo, {
    textureWidth: small ? 256 : 512, textureHeight: small ? 256 : 512,
    waterNormals: lakeNormals(ctx), sunDirection: ctx.sun.clone(), sunColor: 0xffffff,
    waterColor: 0x0a5aa8, distortionScale: 1.4, fog: true,
  });
  const uniforms = water.material.uniforms as WaterUniforms;
  uniforms.size.value = 2.2;
  water.rotation.x = -Math.PI / 2; water.position.set(0, 0.4, -375);
  ctx.root.add(water);
  // Skip the reflection pass while the drone is down in the meadow, where the lake is hidden.
  const reflect = water.onBeforeRender;
  const refresh = new ReflectionRefresh(30);
  let elapsed = 0;
  water.onBeforeRender = (r, sc, cam, geo, mat, group) => {
    if (lake.reflect && (cam.position.z < 280 || cam.position.y > 60) && refresh.shouldRefresh(elapsed, cam)) {
      reflect.call(water, r, sc, cam, geo, mat, group);
    }
  };

  // Boats: sailboats and small motor launches drifting along the lake, each with a wake
  const BOATS = ctx.random.withRng(9090, () => buildBoats(ctx, glassMat));

  const lake: Lake = {
    reflect: true,
    update(t, dt, camera) {
      elapsed = t;
      wNorm.offset.set(t * 0.004, t * 0.006);
      uniforms.time.value = t * 0.6;
      uniforms.eye.value.copy(camera.position);
      for (const b of BOATS) {
        b.x += b.dir * b.v * dt; if (b.x > 640) b.x = -640; if (b.x < -640) b.x = 640;
        b.g.position.set(b.x, 0.45 + Math.sin(t * 1.3 + b.ph) * 0.06, b.z + Math.sin(t * 0.05 + b.ph) * 6);
        b.g.rotation.set(Math.sin(t * 1.1 + b.ph) * 0.02, b.dir > 0 ? Math.PI / 2 : -Math.PI / 2, b.dir * b.heel + Math.sin(t * 0.9 + b.ph) * 0.03);
      }
    },
  };
  return lake;
}
