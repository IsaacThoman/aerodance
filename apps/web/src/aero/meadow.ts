import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AeroContext } from './context.ts';
import { splitIntoCells } from './instanceCells.ts';
import { freezeMatrices, mergeStatic } from './mergeStatic.ts';
import type { FlightPath } from './flight.ts';
import { TAU, canvas2d, col, hexMul } from './util.ts';

// The meadow's grass and flowers are drawn in 100 m cells, so only the cells in view are drawn.
function addInCells(ctx: AeroContext, mesh: THREE.InstancedMesh) {
  for (const part of splitIntoCells(mesh, 100)) ctx.root.add(part);
  mesh.dispose();
}

/* ------------------------------------------------------- meadow grass */
// 120,000 blades of five vertices each. As an instanced mesh, GPUs that shade vertices in
// fixed-size groups (Apple's) waste most of each group on such tiny instances, so the blades are
// drawn as plain indexed triangles instead, each vertex looking up its blade (gl_VertexID / 5)
// in a float texture: four texels per blade, the instance matrix's columns (with the translation
// in w) and the blade's colour.
const BLADE_W = 0.07, BLADES_PER_ROW = 256;
const bladeVertex = (a: THREE.Color, b: THREE.Color, c: THREE.Color) => {
  const v = (x: number, y: number, z: number) => `vec3(${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)})`;
  const w = BLADE_W;
  return `
  uniform float uTime;uniform highp sampler2D bladeData;
  const vec3 BLADE[5]=vec3[5](${[[-w, 0, 0], [w, 0, 0], [-w * 0.7, 0.5, 0.02], [w * 0.7, 0.5, 0.02], [0, 1, 0.07]].map((p) => v(p[0], p[1], p[2])).join(',')});
  const vec3 SHADE[5]=vec3[5](${[a, a, b, b, c].map((k) => v(k.r, k.g, k.b)).join(',')});`;
};
const bladeBegin = `
  int blade=gl_VertexID/5,corner=gl_VertexID-blade*5;
  ivec2 at=ivec2((blade%${BLADES_PER_ROW})*4,blade/${BLADES_PER_ROW});
  vec4 c0=texelFetch(bladeData,at,0),c1=texelFetch(bladeData,at+ivec2(1,0),0),c2=texelFetch(bladeData,at+ivec2(2,0),0);
  vec3 p=BLADE[corner];
  vec2 ip=vec2(c0.w,c2.w);
  float sw=sin(uTime*1.8+ip.x*.15+ip.y*.11)+.5*sin(uTime*3.1+ip.x*.4);
  p.x+=sw*p.y*p.y*.14;p.z+=sw*p.y*p.y*.07;
  vec3 transformed=c0.xyz*p.x+c1.xyz*p.y+c2.xyz*p.z+vec3(c0.w,c1.w,c2.w);`;
const bladeColor = `
  vColor=vec4(SHADE[gl_VertexID-(gl_VertexID/5)*5]*texelFetch(bladeData,ivec2(((gl_VertexID/5)%${BLADES_PER_ROW})*4+3,(gl_VertexID/5)/${BLADES_PER_ROW}),0).rgb,1.0);`;

/** Grass blades swaying in a vertex-shader wind, drawn in 100 m cells. */
export function buildMeadowGrass(ctx: AeroContext, path: FlightPath) {
  const { R, rnd } = ctx.random;
  const a = col('#2c7a1a'), b = col('#5ec12d'), c = col('#c8f06a');
  const N = 120000, rows = Math.ceil(N / BLADES_PER_ROW);
  const data = new Float32Array(BLADES_PER_ROW * 4 * rows * 4);
  const d = new THREE.Object3D(), cc = new THREE.Color(), cells = new Map<string, number[]>();
  for (let i = 0; i < N; i++) {
    let x: number, z: number; if (rnd() < 0.72) [x, z] = path.nearMeadow(26); else { x = R(-260, 320); z = R(270, 1000); }
    d.position.set(x, 0, z); d.rotation.set(R(-0.2, 0.2), R(0, TAU), R(-0.2, 0.2)); d.scale.set(R(0.8, 1.7), R(0.45, 1.35), 1); d.updateMatrix();
    const bb = R(0.75, 1.12); cc.setRGB(bb * R(0.9, 1.05), bb, bb * R(0.82, 1));
    const m = d.matrix.elements, o = i * 16;
    data[o] = m[0]; data[o + 1] = m[1]; data[o + 2] = m[2]; data[o + 3] = m[12];
    data[o + 4] = m[4]; data[o + 5] = m[5]; data[o + 6] = m[6]; data[o + 7] = m[13];
    data[o + 8] = m[8]; data[o + 9] = m[9]; data[o + 10] = m[10]; data[o + 11] = m[14];
    data[o + 12] = cc.r; data[o + 13] = cc.g; data[o + 14] = cc.b;
    const key = `${Math.floor(x / 100)},${Math.floor(z / 100)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, list = []);
    list.push(i);
  }
  const tex = new THREE.DataTexture(data, BLADES_PER_ROW * 4, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  ctx.disposables.push(tex);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.time;
    sh.uniforms.bladeData = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${bladeVertex(a, b, c)}`)
      .replace('#include <begin_vertex>', bladeBegin)
      .replace('#include <color_vertex>', bladeColor);
  };
  mat.customProgramCacheKey = () => 'aero-grass';
  const corners = [0, 1, 2, 1, 3, 2, 2, 3, 4];
  for (const list of cells.values()) {
    const index = new Uint32Array(list.length * 9), box = new THREE.Box3(), p = new THREE.Vector3();
    list.forEach((i, k) => {
      for (let j = 0; j < 9; j++) index[k * 9 + j] = i * 5 + corners[j];
      box.expandByPoint(p.set(data[i * 16 + 3], 0, data[i * 16 + 11]));
    });
    const g = new THREE.BufferGeometry();
    g.setIndex(new THREE.BufferAttribute(index, 1));
    // Blades are under 2 m tall and lean a little in the wind.
    box.expandByVector(p.set(2.5, 2.5, 2.5));
    g.boundingBox = box; g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    ctx.root.add(new THREE.Mesh(g, mat));
  }
}

/* --------------------------------------------------------------- flowers */
type FlowerKind = 'daisy' | 'cosmos' | 'yellow';

function flowerTex(ctx: AeroContext, kind: FlowerKind) {
  const { R } = ctx.random;
  const S = 128, { c, g } = canvas2d(S, S); g.translate(64, 64);
  const petals = kind === 'daisy' ? 18 : 8, fc = kind === 'daisy' ? '#ffffff' : kind === 'cosmos' ? '#ff6fb5' : '#ffd21f', len = kind === 'daisy' ? 52 : 50, wid = kind === 'daisy' ? 7 : 15;
  for (let i = 0; i < petals; i++) {
    g.save(); g.rotate((i / petals) * TAU);
    const gr = g.createLinearGradient(0, 0, len, 0); gr.addColorStop(0, hexMul(fc, kind === 'daisy' ? 0.9 : 0.85)); gr.addColorStop(1, fc);
    g.fillStyle = gr; g.beginPath(); g.ellipse(len / 2 + 6, 0, len / 2, wid, 0, 0, TAU); g.fill();
    if (kind !== 'daisy') { g.globalCompositeOperation = 'destination-out'; g.beginPath(); for (let k = -1; k <= 1; k++) { g.moveTo(len + 6, k * 5); g.lineTo(len - 2, k * 5 + 2.5); g.lineTo(len + 6, k * 5 + 5); } g.fill(); g.globalCompositeOperation = 'source-over'; }
    g.restore();
  }
  const cr = kind === 'daisy' ? 13 : 11, gr = g.createRadialGradient(-3, -3, 1, 0, 0, cr);
  gr.addColorStop(0, kind === 'yellow' ? '#a2541a' : '#ffe46a'); gr.addColorStop(1, kind === 'yellow' ? '#5a2a0c' : '#f0a91a');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, cr, 0, TAU); g.fill();
  g.fillStyle = 'rgba(120,60,0,.35)'; for (let i = 0; i < 30; i++) { const a = R(0, TAU), r = R(0, cr * 0.85); g.fillRect(Math.cos(a) * r, Math.sin(a) * r, 1.5, 1.5); }
  return ctx.tex(c);
}

/** Flower heads (instanced billboards) on instanced stems. */
export function buildFlowers(ctx: AeroContext, path: FlightPath) {
  const { R, rnd } = ctx.random;
  const STEMS: number[] = [], geo = new THREE.PlaneGeometry(1, 1), d = new THREE.Object3D();
  const kinds: [kind: FlowerKind, size: number, count: number][] = [['daisy', 0.6, 3000], ['cosmos', 0.8, 2200], ['yellow', 0.75, 2200]];
  for (const [kind, size, n] of kinds) {
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: flowerTex(ctx, kind), alphaTest: 0.5, side: THREE.DoubleSide, color: col('#f4f4f4') }), n);
    for (let i = 0; i < n; i++) {
      let x: number, z: number;
      if (rnd() < 0.8) { let p: THREE.Vector3; [x, z, p] = path.nearMeadow(20); const dx = x - p.x, dz = z - p.z; if (dx * dx + dz * dz < 2.5) x += dx < 0 ? -1.6 : 1.6; } else { x = R(-250, 300); z = R(280, 1000); }
      const h = R(0.55, 1.45), s = size * R(0.75, 1.25);
      d.position.set(x, h, z); d.rotation.set(-Math.PI / 2 + R(0.35, 1.0), R(0, TAU), 0, 'YXZ'); d.scale.set(s, s, s); d.updateMatrix(); im.setMatrixAt(i, d.matrix); STEMS.push(x, h, z);
    }
    addInCells(ctx, im);
  }
  const sg = new THREE.CylinderGeometry(0.022, 0.03, 1, 3); sg.translate(0, 0.5, 0);
  const sm = new THREE.InstancedMesh(sg, new THREE.MeshBasicMaterial({ color: col('#3f9a25') }), STEMS.length / 3);
  for (let i = 0; i < STEMS.length / 3; i++) { d.position.set(STEMS[i * 3], 0, STEMS[i * 3 + 2]); d.rotation.set(0, 0, 0); d.scale.set(1, STEMS[i * 3 + 1], 1); d.updateMatrix(); sm.setMatrixAt(i, d.matrix); }
  addInCells(ctx, sm);
}

/* -------------------------------------------------- tulips + windmills */
/** Striped tulip field beside the meadow. */
export function buildTulips(ctx: AeroContext) {
  const { R } = ctx.random;
  const cup = new THREE.LatheGeometry([[0, 0], [0.12, 0.03], [0.2, 0.12], [0.22, 0.26], [0.19, 0.38], [0.13, 0.45]].map((p) => new THREE.Vector2(p[0], p[1])), 7);
  const stem = new THREE.CylinderGeometry(0.03, 0.035, 1, 3); stem.translate(0, 0.5, 0);
  const pts: [x: number, z: number, band: number][] = [], cols = ['#ff2a2a', '#ffd21a', '#ff5fa2', '#ff8a1a', '#ffffff'].map((h) => col(h));
  for (let x = -142, row = 0; x < -46; x += 2.0, row++) { const band = Math.floor(row / 6) % cols.length; for (let z = 520; z < 770; z += 1.6) pts.push([x + R(-0.4, 0.4), z + R(-0.5, 0.5), band]); }
  const N = pts.length;
  const cm = new THREE.InstancedMesh(cup, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), N);
  const st = new THREE.InstancedMesh(stem, new THREE.MeshBasicMaterial({ color: col('#3c8f24') }), N);
  const d = new THREE.Object3D(), c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const [x, z, b] = pts[Math.floor((i / N) * pts.length)], h = R(0.7, 1.1), s = R(1.1, 1.5);
    d.position.set(x, 0, z); d.rotation.set(0, 0, 0); d.scale.set(1, h, 1); d.updateMatrix(); st.setMatrixAt(i, d.matrix);
    d.position.y = h; d.rotation.set(R(-0.15, 0.15), R(0, TAU), R(-0.15, 0.15)); d.scale.set(s, s, s); d.updateMatrix(); cm.setMatrixAt(i, d.matrix);
    c.copy(cols[b]).multiplyScalar(R(0.85, 1.1)); cm.setColorAt(i, c);
  }
  addInCells(ctx, cm); addInCells(ctx, st);
}

export function buildWindmills(ctx: AeroContext) {
  const MILLS: THREE.Group[] = [];
  const tw = new THREE.MeshLambertMaterial({ color: col('#6b4632') }), cap = new THREE.MeshLambertMaterial({ color: col('#3e2a1e') }), sail = new THREE.MeshLambertMaterial({ color: col('#f3ead8') });
  for (const [x, z] of [[-168, 575], [-175, 650], [-160, 725]]) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 4, 18, 8), tw); t.position.y = 9; g.add(t);
    const c = new THREE.Mesh(new THREE.ConeGeometry(3.2, 4.5, 8), cap); c.position.y = 20.2; g.add(c);
    const bl = new THREE.Group(); bl.position.set(3.4, 17, 0);
    for (let k = 0; k < 4; k++) {
      const arm = new THREE.Group(); arm.rotation.x = (k * Math.PI) / 2;
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.3, 13, 0.4), cap); a.position.y = 6.5; arm.add(a);
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.15, 10, 2.4), sail); s.position.set(0, 8, 1.3); arm.add(s);
      bl.add(arm);
    }
    g.add(bl); ctx.root.add(g); MILLS.push(bl); ctx.moving.push(bl);
    // The sails turn as one: two meshes (arms, sails) instead of eight.
    for (const arm of bl.children) freezeMatrices(arm);
    mergeStatic(bl, [...bl.children]);
  }
  return {
    update(dt: number) { for (const m of MILLS) m.rotation.x += dt * 0.5; },
  };
}

/* ------------------------------------------------------------ butterflies */
type WingKind = 'monarch' | 'morpho' | 'swallow';

function wingTex(ctx: AeroContext, kind: WingKind) {
  const S = 128, { c, g } = canvas2d(S, S);
  const shape = () => { g.beginPath(); g.ellipse(58, 44, 56, 34, -0.35, 0, TAU); g.ellipse(42, 92, 38, 28, 0.45, 0, TAU); };
  g.save(); shape(); g.clip();
  if (kind === 'monarch') { g.fillStyle = '#ff8a1c'; g.fillRect(0, 0, S, S); g.strokeStyle = '#1a120a'; g.lineWidth = 3; for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(0, 64); g.lineTo(130 * Math.cos(-1.1 + i * 0.33), 64 + 130 * Math.sin(-1.1 + i * 0.33)); g.stroke(); } }
  else if (kind === 'morpho') { const gr = g.createLinearGradient(0, 64, 128, 20); gr.addColorStop(0, '#0a3fd8'); gr.addColorStop(0.6, '#1f8bff'); gr.addColorStop(1, '#3fe0ff'); g.fillStyle = gr; g.fillRect(0, 0, S, S); }
  else { g.fillStyle = '#ffe14d'; g.fillRect(0, 0, S, S); g.fillStyle = '#14110c'; for (let i = 0; i < 6; i++) { g.save(); g.translate(18 + i * 18, 0); g.rotate(0.35); g.fillRect(0, -20, i % 2 ? 5 : 9, 170); g.restore(); } g.fillStyle = '#2a7bff'; g.beginPath(); g.arc(30, 106, 6, 0, TAU); g.fill(); g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(48, 112, 4, 0, TAU); g.fill(); }
  g.restore();
  g.save(); shape(); g.lineWidth = 10; g.strokeStyle = '#120d08'; g.stroke(); g.restore();
  g.fillStyle = '#ffffff'; for (let i = 0; i < 14; i++) { const a = -1.4 + i * 0.2; g.beginPath(); g.arc(60 + 54 * Math.cos(a) * 0.95, 44 + 34 * Math.sin(a) * 0.95, 1.8, 0, TAU); g.fill(); }
  return ctx.tex(c);
}

interface Butterfly { kind: number; s: number; ax: number; az: number; ay: number; ph: number; f: number; sp: number; rad: number }

// Butterflies fly entirely in the vertex shader. Each circles its spot (ax, ay, az) at radius
// rad, at q = t * sp + ph, facing along its path, at scale s; its wings beat by
// a = sin(t * f + ph) * 1.05 + 0.2 about the body, the left one mirrored (wingSide -1).
// flight = (ax, ay, az, s), flight2 = (ph, sp, rad, f) per butterfly.
const flightVertex = `
  attribute vec4 flight;attribute vec4 flight2;uniform float uTime;
  #ifdef BUTTERFLY_WING
  attribute float wingSide;
  #endif
  vec3 flyPose(vec3 p,float w){
    #ifdef BUTTERFLY_WING
    float a=sin(uTime*flight2.w+flight2.x)*1.05+0.2,c=cos(a),s=sin(a);
    p=vec3(c*p.x-s*p.y,s*p.x+c*p.y,p.z);p.x*=wingSide;
    #endif
    float q=uTime*flight2.y+flight2.x,r=flight2.z,y=flight.y+sin(q*1.7)*0.6;
    vec3 at=vec3(flight.x+sin(q)*r,y,flight.z+cos(q*0.8)*r);
    vec3 ahead=vec3(flight.x+sin(q+0.05)*r,y,flight.z+cos((q+0.05)*0.8)*r);
    vec3 zA=normalize(ahead-at),xA=normalize(cross(vec3(0.0,1.0,0.0),zA)),yA=cross(zA,xA);
    return mat3(xA,yA,zA)*(p*flight.w)+w*at;
  }`;

function flying<M extends THREE.Material>(ctx: AeroContext, m: M, wing: boolean) {
  if (wing) m.defines = { ...m.defines, BUTTERFLY_WING: '' };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${flightVertex}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = flyPose(normal, 0.0);')
      .replace('#include <begin_vertex>', 'vec3 transformed = flyPose(position, 1.0);');
  };
  m.customProgramCacheKey = () => (wing ? 'butterfly-wings' : 'butterfly-body');
  return m;
}

export function buildButterflies(ctx: AeroContext, path: FlightPath) {
  const { R, pick } = ctx.random;
  const BFLY: Butterfly[] = [];
  const wg = new THREE.PlaneGeometry(1, 1); wg.translate(0.5, 0, 0); wg.rotateX(Math.PI / 2);
  const kinds: WingKind[] = ['monarch', 'morpho', 'swallow'];
  const mats = kinds.map((k, kind) => {
    const t = wingTex(ctx, k);
    return { m: flying(ctx, new THREE.MeshLambertMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.35, alphaTest: 0.5, side: THREE.DoubleSide }), true), kind };
  });
  const body = new THREE.CylinderGeometry(0.035, 0.025, 0.5, 5); body.rotateX(Math.PI / 2);
  const bm = flying(ctx, new THREE.MeshBasicMaterial({ color: col('#1a120a') }), false);
  for (let i = 0; i < 100; i++) {
    const [x, z, p] = path.nearMeadow(14), { kind } = pick(mats);
    const s = R(0.45, 0.75);
    let ax = x; const az = z, dx = x - p.x, dz = z - p.z; if (dx * dx + dz * dz < 9) ax += dx < 0 ? -3 : 3;
    BFLY.push({ kind, s, ax, az, ay: R(1.2, 3.2), ph: R(0, TAU), f: R(9, 14), sp: R(0.3, 0.7), rad: R(1.5, 4) });
  }
  // A pair of wings: the left copy mirrored and wound the other way round.
  const flat = wg.toNonIndexed(), nv = flat.attributes.position.count;
  const pair = mergeGeometries([flat, flat]);
  pair.setAttribute('wingSide', new THREE.BufferAttribute(new Float32Array(nv * 2).fill(1, 0, nv).fill(-1, nv), 1));
  const index: number[] = [];
  for (let i = 0; i < nv; i += 3) index.push(i, i + 1, i + 2);
  for (let i = nv; i < 2 * nv; i += 3) index.push(i, i + 2, i + 1);
  pair.setIndex(index);
  flat.dispose(); wg.dispose();
  const withFlights = (geo: THREE.BufferGeometry, list: Butterfly[]) => {
    geo.setAttribute('flight', new THREE.InstancedBufferAttribute(Float32Array.from(list.flatMap((b) => [b.ax, b.ay, b.az, b.s])), 4));
    geo.setAttribute('flight2', new THREE.InstancedBufferAttribute(Float32Array.from(list.flatMap((b) => [b.ph, b.sp, b.rad, b.f])), 4));
    return geo;
  };
  const meshes: THREE.InstancedMesh[] = mats.map(({ m, kind }) => {
    const list = BFLY.filter((b) => b.kind === kind);
    return new THREE.InstancedMesh(withFlights(pair.clone(), list), m, list.length);
  });
  pair.dispose();
  meshes.push(new THREE.InstancedMesh(withFlights(body, BFLY), bm, BFLY.length));
  // They stay over the meadow: one bounding sphere for culling.
  const box = new THREE.Box3();
  for (const b of BFLY) box.expandByPoint(new THREE.Vector3(b.ax, b.ay, b.az));
  const bounds = box.getBoundingSphere(new THREE.Sphere()); bounds.radius += 8;
  for (const m of meshes) { m.boundingSphere = bounds.clone(); ctx.root.add(m); }
}

/* ---------------------------------------------------------------- sparkles */
/** Two twinkling point clouds over the meadow, blinking in antiphase. */
export function buildSparkles(ctx: AeroContext, path: FlightPath) {
  const { R } = ctx.random;
  const SPK: THREE.PointsMaterial[] = [];
  const { c, g } = canvas2d(64, 64), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(220,255,240,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(31, 4, 2, 56); g.fillRect(4, 31, 56, 2);
  const t = ctx.tex(c);
  for (let k = 0; k < 2; k++) {
    const n = 500, a: number[] = [];
    for (let i = 0; i < n; i++) { const [x, z] = path.nearMeadow(16); a.push(x, R(0.3, 5), z); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    const m = new THREE.PointsMaterial({ map: t, size: 0.55, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: col(k ? '#d8ffe9' : '#fff7cf') });
    const p = new THREE.Points(geo, m); p.frustumCulled = false; ctx.root.add(p); SPK.push(m);
  }
  return {
    update(t: number) { SPK[0].opacity = 0.5 + 0.5 * Math.sin(t * 2.3); SPK[1].opacity = 0.5 + 0.5 * Math.sin(t * 2.3 + Math.PI); },
  };
}
