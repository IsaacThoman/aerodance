import * as THREE from 'three';
import type { AeroContext } from './context.ts';
import type { FlightPath } from './flight.ts';
import { TAU, canvas2d, clamp, col, hexRGB } from './util.ts';

/** Envelope texture: 12 gores, colour bands by height (or a chequer when alt). */
function balloonTex(ctx: AeroContext, scheme: readonly string[], alt?: boolean) {
  const W = 512, H = 256, { c, g } = canvas2d(W, H), im = g.createImageData(W, H);
  const S = scheme.map(hexRGB), gores = 12;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x / W) * gores, local = u % 1, gi = Math.floor(u), tri = Math.abs(local - 0.5) * 2, vv = 1 - y / H;
    const idx = alt ? (gi + Math.floor(vv * 3)) % S.length : clamp(Math.floor(vv * S.length + (1 - tri) * 0.55 - 0.2), 0, S.length - 1);
    const s = S[idx]; let f = local < 0.03 || local > 0.97 ? 0.78 : 1; f *= 0.9 + 0.1 * Math.sin(local * Math.PI);
    if (Math.abs(vv - 0.32) < 0.008) f *= 0.8; // load tape
    const i = (y * W + x) * 4; im.data[i] = s[0] * f; im.data[i + 1] = s[1] * f; im.data[i + 2] = s[2] * f; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return ctx.tex(c);
}

interface Balloon { y: number; ph: number; x: number; z: number; scale: number; turn: number; scheme: number }

/** Hot-air balloons drifting around the route, lifted clear of the flight path. */
export function buildBalloons(ctx: AeroContext, path: FlightPath) {
  const { R, pick } = ctx.random;
  const BAL: Balloon[] = [];
  const schemes: [colours: string[], alt?: boolean][] = [[['#1f6fd6', '#2a9bf0', '#ff7a1a', '#ffb21f', '#ffd92a', '#ff3d2e']], [['#7a3cff', '#2a7bff', '#22c6ff', '#2fd36a', '#ffe02a', '#ff8f1f', '#ff3b3b']], [['#ffffff', '#ff4f8b', '#ffd23f', '#2ab0ff'], true], [['#0f5fd0', '#ffffff', '#ff3b3b', '#ffffff', '#0f5fd0']]];
  const mats = schemes.map(([s, alt]) => new THREE.MeshStandardMaterial({ map: balloonTex(ctx, s, alt), roughness: 0.45, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.8 }));
  const prof = [[2.5, 0], [3.5, 2], [5.8, 5], [8.2, 8.5], [9.7, 12], [10.2, 15], [9.9, 18], [8.6, 21], [6.4, 23.5], [3.4, 25.2], [0.01, 25.8]].map((p) => new THREE.Vector2(p[0], p[1]));
  const env = new THREE.LatheGeometry(prof, 48);
  const basket = new THREE.MeshLambertMaterial({ color: col('#9a6a3a') }), rope = new THREE.LineBasicMaterial({ color: col('#5a4a3a') }), flame = new THREE.MeshBasicMaterial({ color: col('#ffb347') });
  const spots = [[140, 250, -560], [300, 265, -520], [330, 240, -360], [470, 300, -210], [520, 250, 40], [370, 270, 110], [200, 320, -330], [0, 190, -120], [-150, 205, 80], [120, 175, 180], [-60, 60, 640], [170, 72, 700], [-210, 95, 520], [270, 115, 430], [-300, 160, -150], [60, 330, -260]];
  for (const [x, y0, z] of spots) {
    let y = y0; while (!path.clearOfPath(x, y, z, 40)) y += 30;
    const scheme = mats.indexOf(pick(mats));
    BAL.push({ y, x, z, scheme, scale: R(0.85, 1.45), turn: R(0, TAU), ph: R(0, TAU) });
  }
  // One instanced mesh per envelope pattern, one for the baskets and one for the burner flames;
  // the ropes of every balloon in one set of lines, moved here each frame.
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const parts = [
    ...mats.map((m, scheme) => ({ geo: env as THREE.BufferGeometry, mat: m as THREE.Material, local: at(0, 0, 0), of: BAL.filter((b) => b.scheme === scheme) })),
    { geo: new THREE.BoxGeometry(3, 2.4, 3), mat: basket, local: at(0, -6.5, 0), of: BAL },
    { geo: new THREE.SphereGeometry(0.6, 8, 6), mat: flame, local: at(0, -3.6, 0), of: BAL },
  ].filter((p) => p.of.length).map((p) => {
    const mesh = new THREE.InstancedMesh(p.geo, p.mat, p.of.length);
    mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ctx.root.add(mesh);
    return { mesh, local: p.local, of: p.of };
  });
  const lp: number[] = []; for (const sx of [-1, 1]) for (const sz of [-1, 1]) lp.push(sx * 1.3, -5.3, sz * 1.3, sx * 2.2, 0.2, sz * 2.2);
  const ropePos = new Float32Array(BAL.length * lp.length);
  const ropeGeo = new THREE.BufferGeometry(); ropeGeo.setAttribute('position', new THREE.BufferAttribute(ropePos, 3).setUsage(THREE.DynamicDrawUsage));
  const ropes = new THREE.LineSegments(ropeGeo, rope); ropes.frustumCulled = false; ctx.root.add(ropes);
  const d = new THREE.Object3D(), matrices = BAL.map(() => new THREE.Matrix4()), m = new THREE.Matrix4(), v = new THREE.Vector3();
  return {
    update(t: number, dt: number) {
      BAL.forEach((b, i) => {
        b.turn += dt * 0.02;
        d.position.set(b.x + Math.sin(t * 0.04 + b.ph) * 12, b.y + Math.sin(t * 0.25 + b.ph) * 3, b.z + Math.cos(t * 0.03 + b.ph) * 12);
        d.rotation.set(0, b.turn, 0); d.scale.setScalar(b.scale); d.updateMatrix(); matrices[i].copy(d.matrix);
        for (let k = 0; k < lp.length; k += 3) v.set(lp[k], lp[k + 1], lp[k + 2]).applyMatrix4(d.matrix).toArray(ropePos, i * lp.length + k);
      });
      for (const p of parts) {
        p.of.forEach((b, i) => p.mesh.setMatrixAt(i, m.multiplyMatrices(matrices[BAL.indexOf(b)], p.local)));
        p.mesh.instanceMatrix.needsUpdate = true;
      }
      ropeGeo.attributes.position.needsUpdate = true;
    },
  };
}
