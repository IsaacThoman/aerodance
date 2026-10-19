import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AeroContext } from './context.ts';
import { TAU, canvas2d, col, paintGeo, type PaintFn } from './util.ts';

// Gull: lathe body with head, eyes, beak and fanned tail; two-segment wings with feathered tips.
function gullAssets(ctx: AeroContext) {
  const paint = (g: THREE.BufferGeometry, fn: PaintFn) => { if (g.attributes.uv) g.deleteAttribute('uv'); return paintGeo(g.index ? g.toNonIndexed() : g, fn); };
  const white = col('#ffffff'), back = col('#dfe6ec'), dark = col('#16191c'), beak = col('#f4b81e'), grey = col('#c3ccd5');
  const body = new THREE.LatheGeometry([[0.001, -1.0], [0.1, -0.86], [0.2, -0.55], [0.26, -0.15], [0.26, 0.25], [0.21, 0.55], [0.13, 0.78], [0.001, 0.9]].map((p) => new THREE.Vector2(p[0], p[1])), 16);
  body.rotateX(Math.PI / 2); body.scale(1, 0.85, 1);
  const head = new THREE.SphereGeometry(0.18, 14, 10); head.scale(1, 0.95, 1.15); head.translate(0, 0.12, 0.9);
  const eyes = [-1, 1].map((s) => { const e = new THREE.SphereGeometry(0.035, 6, 4); e.translate(s * 0.13, 0.17, 0.98); return e; });
  const bk = new THREE.ConeGeometry(0.055, 0.3, 6); bk.rotateX(Math.PI / 2); bk.scale(1, 1.2, 1); bk.translate(0, 0.08, 1.18);
  const ts = new THREE.Shape(); ts.moveTo(-0.16, 0); ts.lineTo(0.16, 0); ts.lineTo(0.3, -0.5); ts.lineTo(0.1, -0.44); ts.lineTo(0, -0.52); ts.lineTo(-0.1, -0.44); ts.lineTo(-0.3, -0.5); ts.closePath();
  const tail = new THREE.ShapeGeometry(ts); tail.rotateX(Math.PI / 2); tail.translate(0, 0.06, -0.82);
  const bodyGeo = mergeGeometries([
    paint(body, (x, y, z, c) => c.copy(y > 0.12 ? back : white)),
    paint(head, (x, y, z, c) => c.copy(white)),
    ...eyes.map((e) => paint(e, (x, y, z, c) => c.copy(dark))),
    paint(bk, (x, y, z, c) => c.copy(z > 1.27 ? col('#e2412b') : beak)),
    paint(tail, (x, y, z, c) => c.copy(z < -1.22 ? grey : white)),
  ]);
  function wingShape(pts: [number, number][]) {
    const s = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); s.closePath();
    const g = new THREE.ShapeGeometry(s), p = g.attributes.position, uv = g.attributes.uv;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < p.count; i++) { x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i)); y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i)); }
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - x0) / (x1 - x0), (p.getY(i) - y0) / (y1 - y0));
    g.rotateX(Math.PI / 2);
    return g;
  }
  const inner = wingShape([[0, 0.3], [1.15, 0.25], [1.15, -0.3], [0.6, -0.4], [0, -0.44]]);
  const outer = wingShape([[0, 0.25], [0.75, 0.16], [1.45, -0.06], [1.35, -0.22], [0.7, -0.33], [0, -0.3]]);
  // inner: grey mantle, white trailing edge with notched secondaries
  const { c: ci, g: gi } = canvas2d(256, 128);
  gi.fillStyle = '#c9d3dc'; gi.fillRect(0, 0, 256, 128);
  gi.fillStyle = '#e6edf3'; gi.fillRect(0, 0, 256, 14);
  gi.fillStyle = '#ffffff'; gi.fillRect(0, 100, 256, 28);
  gi.strokeStyle = 'rgba(90,105,120,.35)'; gi.lineWidth = 1.5;
  for (let x = 6; x < 256; x += 14) { gi.beginPath(); gi.moveTo(x, 40); gi.lineTo(x - 6, 128); gi.stroke(); }
  gi.strokeStyle = 'rgba(255,255,255,.6)'; for (let x = 0; x < 256; x += 22) { gi.beginPath(); gi.moveTo(x, 18); gi.lineTo(x + 10, 44); gi.stroke(); }
  gi.globalCompositeOperation = 'destination-out';
  for (let x = 0; x < 256; x += 14) { gi.beginPath(); gi.moveTo(x, 128); gi.lineTo(x + 7, 118); gi.lineTo(x + 14, 128); gi.fill(); }
  // outer: grey to black tip, white mirrors, separated primaries
  const { c: co, g: go } = canvas2d(256, 128);
  const gr = go.createLinearGradient(0, 0, 256, 0); gr.addColorStop(0, '#c9d3dc'); gr.addColorStop(0.45, '#aeb9c4'); gr.addColorStop(0.62, '#1b1e22'); gr.addColorStop(1, '#0d0f11');
  go.fillStyle = gr; go.fillRect(0, 0, 256, 128);
  go.fillStyle = '#ffffff'; go.beginPath(); go.arc(222, 62, 9, 0, TAU); go.fill(); go.beginPath(); go.arc(190, 48, 6, 0, TAU); go.fill();
  go.fillStyle = 'rgba(255,255,255,.9)'; go.fillRect(0, 108, 120, 20);
  go.strokeStyle = 'rgba(0,0,0,.35)'; go.lineWidth = 1.5; for (let i = 0; i < 9; i++) { go.beginPath(); go.moveTo(40 + i * 22, 30); go.lineTo(70 + i * 22, 128); go.stroke(); }
  go.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i++) { const x = 130 + i * 18; go.beginPath(); go.moveTo(x, 128); go.lineTo(x + 10, 128); go.lineTo(x + 26, 50 + i * 4); go.closePath(); go.fill(); }
  const mk = (c: HTMLCanvasElement) => new THREE.MeshLambertMaterial({ map: ctx.tex(c), alphaTest: 0.5, side: THREE.DoubleSide });
  return { bodyGeo, inner, outer, bodyMat: new THREE.MeshLambertMaterial({ vertexColors: true }), innerMat: mk(ci), outerMat: mk(co) };
}

type GullAssets = ReturnType<typeof gullAssets>;

// All the gulls are drawn as three instanced meshes (bodies, inner wings, outer wings). Each
// wing mesh holds both wings: `wingSide` mirrors the left one. A gull's pose is its instance
// matrix plus `flap` (inner wing roll, outer wing roll, inner wing sweep), applied here as the
// gull's wing joints were: shoulder at (0.16, 0.12, 0.18), wrist 1.15 out along the wing.
const wingVertex = `
  attribute float wingSide;attribute vec3 flap;
  vec3 wingPose(vec3 p,float w){
    #ifdef OUTER_WING
    float cb=cos(flap.y),sb=sin(flap.y);p=vec3(cb*p.x-sb*p.y,sb*p.x+cb*p.y,p.z);p.x+=1.15*w;
    #endif
    float ca=cos(flap.x),sa=sin(flap.x),cy=cos(flap.z),sy=sin(flap.z);
    p=vec3(ca*p.x-sa*p.y,sa*p.x+ca*p.y,p.z);
    p=vec3(cy*p.x+sy*p.z,p.y,-sy*p.x+cy*p.z);
    p+=w*vec3(0.16,0.12,0.18);p.x*=wingSide;return p;
  }`;

/** Lambert material whose vertices are posed by wingPose (see above). */
function wingMaterial(base: THREE.MeshLambertMaterial, outer: boolean) {
  const m = base.clone();
  if (outer) m.defines = { ...m.defines, OUTER_WING: '' };
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${wingVertex}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = wingPose(normal, 0.0);')
      .replace('#include <begin_vertex>', 'vec3 transformed = wingPose(position, 1.0);');
  };
  m.customProgramCacheKey = () => (outer ? 'gull-outer-wing' : 'gull-inner-wing');
  return m;
}

/** Both wings of one geometry: the second copy mirrored by wingSide -1, wound the other way round. */
function pairOfWings(g: THREE.BufferGeometry) {
  const flat = g.index ? g.toNonIndexed() : g;
  const n = flat.attributes.position.count;
  const both = mergeGeometries([flat, flat]);
  const side = new Float32Array(n * 2).fill(1, 0, n).fill(-1, n);
  both.setAttribute('wingSide', new THREE.BufferAttribute(side, 1));
  // Mirroring turns the triangles over; swap two corners so they face the same way as before.
  const index: number[] = [];
  for (let i = 0; i < n; i += 3) index.push(i, i + 1, i + 2);
  for (let i = n; i < 2 * n; i += 3) index.push(i, i + 2, i + 1);
  both.setIndex(index);
  if (flat !== g) flat.dispose();
  return both;
}

interface Gull { i: number }
/** A gull circling centre c at radius rad, bobbing by hv. */
interface CirclingGull extends Gull { c: THREE.Vector3; rad: number; a: number; w: number; hv: number; ph: number; fs: number; s: number }
interface FormationGull extends Gull { off: THREE.Vector3; ph: number; fs: number }

/** Circling gull flocks, plus a V formation above the clouds. */
export function buildBirds(ctx: AeroContext) {
  const { root } = ctx;
  const { R, rnd } = ctx.random;
  const GULL: GullAssets = gullAssets(ctx);
  const BIRDS: CirclingGull[] = [];
  const flocks: [centre: [number, number, number], radius: [number, number], count: number, scale: number][] = [[[0, 150, 0], [60, 160], 14, 1.5], [[90, 215, -470], [30, 90], 10, 1.5], [[-70, 72, -330], [30, 80], 8, 1.3], [[40, 26, 560], [40, 110], 8, 0.9], [[260, 260, -380], [40, 100], 8, 1.5]];
  let count = 0;
  for (const [c, [r0, r1], n, sc] of flocks) for (let i = 0; i < n; i++) {
    const s = sc * R(0.85, 1.15);
    BIRDS.push({ i: count++, s, c: new THREE.Vector3(...c).add(new THREE.Vector3(R(-20, 20), R(-15, 15), R(-20, 20))), rad: R(r0, r1), a: R(0, TAU), w: R(0.08, 0.16) * (rnd() < 0.5 ? 1 : -1), hv: R(4, 12), ph: R(0, TAU), fs: R(5.5, 7.5) });
  }
  // V formation above the clouds
  const VFORM = { c: new THREE.Vector3(230, 305, -260), rad: 170, a: 0, w: 0.05 }, VBIRDS: FormationGull[] = [];
  for (let k = 0; k < 9; k++) {
    const rank = Math.ceil(k / 2), side = k === 0 ? 0 : k % 2 ? 1 : -1;
    VBIRDS.push({ i: count++, off: new THREE.Vector3(side * rank * 5, R(-0.6, 0.6), -rank * 5), ph: k * 0.35, fs: 6 });
  }

  const inner = pairOfWings(GULL.inner), outer = pairOfWings(GULL.outer);
  GULL.inner.dispose(); GULL.outer.dispose();
  const flap = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  flap.setUsage(THREE.DynamicDrawUsage);
  inner.setAttribute('flap', flap); outer.setAttribute('flap', flap);
  ctx.disposables.push(GULL.bodyGeo, inner, outer);
  const meshes = [
    new THREE.InstancedMesh(GULL.bodyGeo, GULL.bodyMat, count),
    new THREE.InstancedMesh(inner, wingMaterial(GULL.innerMat, false), count),
    new THREE.InstancedMesh(outer, wingMaterial(GULL.outerMat, true), count),
  ];
  GULL.innerMat.dispose(); GULL.outerMat.dispose();
  for (const m of meshes) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(m); }

  const tmp = new THREE.Vector3(), heading = new THREE.Vector3(), d = new THREE.Object3D();
  const pose = (i: number, t: number, f: number, ph: number, glide: number) => {
    d.updateMatrix();
    for (const m of meshes) m.setMatrixAt(i, d.matrix);
    const fa = flap.array as Float32Array;
    fa[i * 3] = Math.sin(t * f + ph) * 0.62 * glide + 0.08;
    fa[i * 3 + 1] = Math.sin(t * f + ph - 0.9) * 0.5 * glide + 0.06;
    fa[i * 3 + 2] = Math.sin(t * f + ph + 1.2) * 0.12 * glide;
  };
  return {
    update(t: number, dt: number) {
      for (const b of BIRDS) {
        b.a += b.w * dt;
        const yAt = (a: number) => b.c.y + Math.sin(a * 2 + b.ph) * b.hv;
        const a2 = b.a + b.w * 0.2;
        tmp.set(b.c.x + Math.cos(a2) * b.rad, yAt(a2), b.c.z + Math.sin(a2) * b.rad);
        const glide = 0.5 + 0.5 * Math.sin(t * 0.35 + b.ph);
        d.position.set(b.c.x + Math.cos(b.a) * b.rad, yAt(b.a) - Math.sin(t * b.fs + b.ph) * 0.12 * glide, b.c.z + Math.sin(b.a) * b.rad);
        d.scale.setScalar(b.s);
        d.lookAt(tmp); d.rotateZ(-Math.sign(b.w) * 0.32);
        pose(b.i, t, b.fs, b.ph, glide);
      }
      VFORM.a += VFORM.w * dt;
      const lx = VFORM.c.x + Math.cos(VFORM.a) * VFORM.rad, lz = VFORM.c.z + Math.sin(VFORM.a) * VFORM.rad;
      heading.set(-Math.sin(VFORM.a), 0, Math.cos(VFORM.a));
      const yaw = Math.atan2(heading.x, heading.z);
      d.scale.setScalar(1.6);
      for (const b of VBIRDS) {
        tmp.copy(b.off).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
        d.position.set(lx + tmp.x, VFORM.c.y + tmp.y + Math.sin(t * 0.5 + b.ph) * 0.4, lz + tmp.z);
        d.rotation.set(0, yaw, 0); d.rotateZ(-0.12);
        pose(b.i, t, b.fs, b.ph, 0.75);
      }
      for (const m of meshes) m.instanceMatrix.needsUpdate = true;
      flap.needsUpdate = true;
    },
  };
}
