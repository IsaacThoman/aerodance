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

// All the gulls are drawn as three instanced meshes (bodies, inner wings, outer wings), flown
// and posed entirely in the vertex shader. Each wing mesh holds both wings: `wingSide` mirrors
// the left one. A circling gull goes round centre c at radius rad from angle a0 at w rad/s,
// bobbing by hv, facing along its path and banked into the turn; the V formation circles above
// the clouds. The wings flap at the shoulder (0.16, 0.12, 0.18) and the wrist, 1.15 out.
// gullA = (c, rad) or (offset in the V, -1); gullB = (a0, w, hv, ph); gullC = (flap rate, scale).
const gullVertex = `
  attribute vec4 gullA;attribute vec4 gullB;attribute vec2 gullC;uniform float uTime;
  #ifdef GULL_WING
  attribute float wingSide;
  #endif
  vec3 gullPose(vec3 p,float w){
    float t=uTime,ph=gullB.w,glide;vec3 at;mat3 turn;
    if(gullA.w>0.0){
      float a=gullB.x+gullB.y*t,a2=a+gullB.y*0.2,r=gullA.w;
      glide=0.5+0.5*sin(t*0.35+ph);
      at=vec3(gullA.x+cos(a)*r,gullA.y+sin(a*2.0+ph)*gullB.z-sin(t*gullC.x+ph)*0.12*glide,gullA.z+sin(a)*r);
      vec3 ahead=vec3(gullA.x+cos(a2)*r,gullA.y+sin(a2*2.0+ph)*gullB.z,gullA.z+sin(a2)*r);
      vec3 zA=normalize(ahead-at),xA=normalize(cross(vec3(0.0,1.0,0.0),zA)),yA=cross(zA,xA);
      float roll=-sign(gullB.y)*0.32,cr=cos(roll),sr=sin(roll);
      turn=mat3(xA,yA,zA)*mat3(cr,sr,0.0,-sr,cr,0.0,0.0,0.0,1.0);
    }else{
      float va=0.05*t,yaw=atan(-sin(va),cos(va)),cy=cos(yaw),sy=sin(yaw),cr=cos(-0.12),sr=sin(-0.12);
      vec3 off=vec3(gullA.x*cy+gullA.z*sy,gullA.y,-gullA.x*sy+gullA.z*cy);
      glide=0.75;
      at=vec3(230.0+cos(va)*170.0+off.x,305.0+off.y+sin(t*0.5+ph)*0.4,-260.0+sin(va)*170.0+off.z);
      turn=mat3(cy,0.0,-sy,0.0,1.0,0.0,sy,0.0,cy)*mat3(cr,sr,0.0,-sr,cr,0.0,0.0,0.0,1.0);
    }
    #ifdef GULL_WING
    float f=t*gullC.x+ph;
    #ifdef OUTER_WING
    float b=sin(f-0.9)*0.5*glide+0.06,cb=cos(b),sb=sin(b);p=vec3(cb*p.x-sb*p.y,sb*p.x+cb*p.y,p.z);p.x+=1.15*w;
    #endif
    float a=sin(f)*0.62*glide+0.08,ca=cos(a),sa=sin(a),fy=sin(f+1.2)*0.12*glide,cy2=cos(fy),sy2=sin(fy);
    p=vec3(ca*p.x-sa*p.y,sa*p.x+ca*p.y,p.z);
    p=vec3(cy2*p.x+sy2*p.z,p.y,-sy2*p.x+cy2*p.z);
    p+=w*vec3(0.16,0.12,0.18);p.x*=wingSide;
    #endif
    return turn*(p*(w>0.5?gullC.y:1.0))+w*at;
  }`;

/** A material whose vertices are flown and posed by gullPose (see above). */
function gullMaterial(base: THREE.MeshLambertMaterial, part: 'body' | 'inner' | 'outer', ctx: AeroContext) {
  const m = base.clone();
  if (part !== 'body') m.defines = { ...m.defines, GULL_WING: '', ...(part === 'outer' ? { OUTER_WING: '' } : {}) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${gullVertex}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = gullPose(normal, 0.0);')
      .replace('#include <begin_vertex>', 'vec3 transformed = gullPose(position, 1.0);');
  };
  m.customProgramCacheKey = () => `gull-${part}`;
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

/** Circling gull flocks, plus a V formation above the clouds. Everything moves in the shader. */
export function buildBirds(ctx: AeroContext) {
  const { root } = ctx;
  const { R, rnd } = ctx.random;
  const GULL: GullAssets = gullAssets(ctx);
  const A: number[] = [], B: number[] = [], C: number[] = [];
  const flocks: [centre: [number, number, number], radius: [number, number], count: number, scale: number][] = [[[0, 150, 0], [60, 160], 14, 1.5], [[90, 215, -470], [30, 90], 10, 1.5], [[-70, 72, -330], [30, 80], 8, 1.3], [[40, 26, 560], [40, 110], 8, 0.9], [[260, 260, -380], [40, 100], 8, 1.5]];
  for (const [c, [r0, r1], n, sc] of flocks) for (let i = 0; i < n; i++) {
    const s = sc * R(0.85, 1.15);
    const centre = new THREE.Vector3(...c).add(new THREE.Vector3(R(-20, 20), R(-15, 15), R(-20, 20)));
    const rad = R(r0, r1), a = R(0, TAU), w = R(0.08, 0.16) * (rnd() < 0.5 ? 1 : -1), hv = R(4, 12), ph = R(0, TAU), fs = R(5.5, 7.5);
    A.push(centre.x, centre.y, centre.z, rad); B.push(a, w, hv, ph); C.push(fs, s);
  }
  // V formation above the clouds
  for (let k = 0; k < 9; k++) {
    const rank = Math.ceil(k / 2), side = k === 0 ? 0 : k % 2 ? 1 : -1;
    A.push(side * rank * 5, R(-0.6, 0.6), -rank * 5, -1); B.push(0, 0, 0, k * 0.35); C.push(6, 1.6);
  }
  const count = C.length / 2;
  const inner = pairOfWings(GULL.inner), outer = pairOfWings(GULL.outer);
  GULL.inner.dispose(); GULL.outer.dispose();
  const meshes = ([[GULL.bodyGeo, GULL.bodyMat, 'body'], [inner, GULL.innerMat, 'inner'], [outer, GULL.outerMat, 'outer']] as const).map(([geo, mat, part]) => {
    geo.setAttribute('gullA', new THREE.InstancedBufferAttribute(Float32Array.from(A), 4));
    geo.setAttribute('gullB', new THREE.InstancedBufferAttribute(Float32Array.from(B), 4));
    geo.setAttribute('gullC', new THREE.InstancedBufferAttribute(Float32Array.from(C), 2));
    const m = new THREE.InstancedMesh(geo, gullMaterial(mat, part, ctx), count);
    m.frustumCulled = false;
    root.add(m);
    return m;
  });
  for (const m of [GULL.bodyMat, GULL.innerMat, GULL.outerMat]) m.dispose();
  ctx.disposables.push(GULL.bodyGeo, inner, outer);
  return meshes;
}
