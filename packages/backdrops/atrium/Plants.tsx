import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { fill, mergeAll, sweepArc } from './geometry.ts';
import type { ProfilePoint } from './geometry.ts';
import { AXIS, BALCONY_THETA, GLASS_R, GLASS_THETA, LAYOUT_GLSL, LEVELS, PLANTER_R, TREES, VOID_R, polar } from './layout.ts';
import type { TreeSpot } from './layout.ts';
import { COMMON, atriumUniforms } from './shading.ts';

// Greenery: hedges spilling over every balcony, curtains of trailing plants hanging from them,
// broadleaf trees shading the left and palms by the glass. Leaves are glossy, Aero style: soft
// ball shading, clumps from noise, sun glints and a yellow-green glow where the sun is behind.

const FOLIAGE = /* glsl */ `
// w: surface, n: normal, blob: the leaf cluster's centre, crown: the whole crown's centre and
// radius (radius 0: no crown), tone: 0..1 colour variation.
vec3 foliage(vec3 w, vec3 n, vec3 blob, vec4 crown, float tone) {
  vec3 v = normalize(cameraPosition - w);
  vec3 s = normalize(uSunDir);
  vec3 ball = normalize(w - blob);
  float detail = 1.0 - smoothstep(0.03, 0.09, length(fwidth(w)));
  float n1 = snoise(w * 1.3);
  float n2 = snoise(w * 4.2 + 5.0) * detail;
  float clump = n1 * 0.6 + n2 * 0.4;
  vec3 nn = normalize(mix(n, ball, 0.55) + vec3(n1, n2, -n1) * 0.25);
  float sunAmt = sunLight(w);
  float diff = clamp(dot(nn, s) * 0.8 + 0.2, 0.0, 1.0) * sunAmt;
  // Darker inside the crown and underneath it.
  float ao = 0.6 + 0.4 * smoothstep(-0.9, 0.6, ball.y);
  if (crown.w > 0.0) {
    vec3 c = (w - crown.xyz) / crown.w;
    ao *= mix(0.35, 1.0, smoothstep(0.35, 1.0, length(c))) * (0.7 + 0.3 * smoothstep(-0.8, 0.5, c.y));
  }
  ao *= 0.8 + 0.2 * smoothstep(-0.6, 0.5, clump);
  vec3 dark = vec3(0.02, 0.15, 0.05);
  vec3 mid = mix(vec3(0.12, 0.44, 0.07), vec3(0.24, 0.56, 0.1), tone);
  vec3 lite = vec3(0.62, 0.92, 0.2);
  vec3 albedo = mix(dark, mid, smoothstep(-0.9, 0.3, clump + 0.3));
  vec3 col = albedo * ambient(nn) * ao * 0.75 + mix(albedo, lite, 0.5) * SUN * diff * 0.55 * (0.5 + 0.5 * ao);
  float back = pow(max(dot(-v, s), 0.0), 3.0) * pow(1.0 - max(dot(nn, v), 0.0), 2.0);
  col += vec3(0.45, 0.85, 0.12) * back * sunAmt * 0.7;
  // Glossy leaves catching the sun, and a soft sheen from the sky on top.
  float glint = smoothstep(0.35, 0.85, n2) * pow(max(dot(reflect(-s, nn), v), 0.0), 12.0);
  col += vec3(1.0, 1.0, 0.85) * glint * sunAmt * 1.6;
  col += vec3(0.5, 0.75, 0.9) * pow(1.0 - max(dot(nn, v), 0.0), 4.0) * max(nn.y, 0.0) * 0.25 * ao;
  return col;
}
`;

const plantVertex = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aCenter;
attribute vec4 aCrown;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying vec4 vCenter;
varying vec4 vCrown;
void main() {
  vec3 p = position;
  // aCenter.w: how much this vertex sways (0 for wood and fixed hedges).
  float ph = aCenter.x * 0.37 + aCenter.z * 0.23;
  float sway = aCenter.w;
  p.x += sin(uTime * 0.7 + ph) * 0.12 * sway;
  p.z += cos(uTime * 0.55 + ph * 1.3) * 0.09 * sway;
  p.y += sin(uTime * 1.3 + ph * 2.0) * 0.03 * sway;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = aColor;
  vCenter = aCenter;
  vCrown = aCrown;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const plantFragment = /* glsl */ `
${COMMON}
${FOLIAGE}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying vec4 vCenter;
varying vec4 vCrown;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 col;
  if (vColor.r > 0.0) {
    // Bark, with the ringed scars of old fronds on the palms (the paler wood).
    vec3 s = normalize(uSunDir);
    float sun = max(dot(n, s), 0.0) * sunLight(vWorld);
    float rings = vColor.r > 0.5 ? 0.82 + 0.18 * smoothstep(0.2, 0.8, fract(vWorld.y * 1.6)) : 1.0;
    col = vColor * rings * (ambient(n) * 0.8 + SUN * sun * 0.6);
  } else {
    col = foliage(vWorld, n, vCenter.xyz, vCrown, vColor.g);
  }
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

// Wood is coloured (r > 0); leaves carry their tone in g with r = 0.
const BARK = [0.36, 0.29, 0.23] as const;
const PALM_BARK = [0.55, 0.47, 0.37] as const;

function lumpy(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const m = mergeVertices(g);
  g.dispose();
  const p = m.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + amount * (Math.sin(x * 2.1 + seed) * Math.sin(y * 1.7 + seed * 2) * Math.sin(z * 2.3 + seed * 3) + 0.5 * Math.sin(x * 4.3 + y * 3.1 + seed));
    p.setXYZ(i, x * k, y * k, z * k);
  }
  m.computeVertexNormals();
  return m;
}

/** Leaves: a cluster centre (and sway), the crown it belongs to (centre and radius) and a tone. */
const leaves = (g: THREE.BufferGeometry, center: THREE.Vector3, tone: number, sway: number, crown = center, crownR = 0) =>
  fill(fill(fill(g, 'aColor', [0, tone, 0]), 'aCenter', [center.x, center.y, center.z, sway]), 'aCrown', [crown.x, crown.y, crown.z, crownR]);
const wood = (g: THREE.BufferGeometry, color: readonly number[] = BARK) => fill(fill(fill(g, 'aColor', color), 'aCenter', [0, 0, 0, 0]), 'aCrown', [0, 0, 0, 0]);

/** A tapered cylinder from p0 (radius r0) to p1 (radius r1). */
function limb(p0: THREE.Vector3, p1: THREE.Vector3, r0: number, r1: number, segments = 9): THREE.BufferGeometry {
  const dir = p1.clone().sub(p0);
  const g = new THREE.CylinderGeometry(r1, r0, dir.length(), segments, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  return g.translate((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
}

function broadleaf(spot: TreeSpot, parts: THREE.BufferGeometry[]) {
  const rand = makeRandom(spot.seed * 31 + 7);
  const base = polar(spot.r, spot.theta);
  const h = spot.height;
  const crown = new THREE.Vector3(base.x, h * 0.68, base.z);
  const crownR = h * 0.34;
  // A trunk forking into three limbs that reach up into the crown.
  const fork = new THREE.Vector3(base.x, h * 0.4, base.z);
  parts.push(wood(limb(new THREE.Vector3(base.x, 0.6, base.z), fork, 0.42, 0.28, 10)));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rand.range(0, 1);
    const tip = crown.clone().add(new THREE.Vector3(Math.cos(a) * crownR * 0.5, rand.range(-0.5, 0.8), Math.sin(a) * crownR * 0.5));
    parts.push(wood(limb(fork, tip, 0.24, 0.1, 8)));
  }
  // The crown: clusters of leaves over a domed shell, a few inside to fill it.
  const blobs = 24;
  for (let i = 0; i < blobs; i++) {
    const u = rand.next();
    const a = rand.range(0, Math.PI * 2);
    const up = 1 - 1.6 * u * u;
    const ring = Math.sqrt(Math.max(0, 1 - up * up));
    const shell = i < 4 ? 0.35 : rand.range(0.75, 1);
    const off = new THREE.Vector3(Math.cos(a) * ring * crownR * shell, up * crownR * 0.62 * shell, Math.sin(a) * ring * crownR * shell);
    const center = crown.clone().add(off);
    const radius = h * rand.range(0.085, 0.12) * (i < 4 ? 1.5 : 1);
    const blob = lumpy(new THREE.IcosahedronGeometry(radius, 2), 0.1, spot.seed * 7 + i).scale(1, 0.85, 1).translate(center.x, center.y, center.z);
    parts.push(leaves(blob, center, rand.next(), 1, crown, crownR));
  }
}

function palm(spot: TreeSpot, parts: THREE.BufferGeometry[]) {
  const rand = makeRandom(spot.seed * 17 + 3);
  const base = polar(spot.r, spot.theta);
  const h = spot.height;
  const lean = new THREE.Vector3(rand.range(-1, 1), 0, rand.range(-1, 1)).normalize().multiplyScalar(h * 0.08);
  const segs = 7;
  let top = new THREE.Vector3();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const p0 = new THREE.Vector3(base.x + lean.x * t0 * t0, 0.5 + t0 * h, base.z + lean.z * t0 * t0);
    const p1 = new THREE.Vector3(base.x + lean.x * t1 * t1, 0.5 + t1 * h, base.z + lean.z * t1 * t1);
    // A gently leaning trunk, tapering in segments.
    parts.push(wood(limb(p0, p1, 0.26 - t0 * 0.07, 0.2 - t1 * 0.05), PALM_BARK));
    top = p1;
  }
  // Fronds: tapered, creased strips arching out and down from the crown.
  const fronds = 11;
  const scale = THREE.MathUtils.clamp(h / 10, 0.5, 1);
  const crownCenter = top.clone().add(new THREE.Vector3(0, -0.8 * scale, 0));
  for (let k = 0; k < fronds; k++) {
    const len = rand.range(3.6, 4.6) * scale;
    const g = new THREE.PlaneGeometry(1, 1, 10, 2);
    const p = g.attributes.position;
    const droop = rand.range(0.7, 1.1);
    for (let i = 0; i < p.count; i++) {
      const t = p.getX(i) + 0.5;
      const across = p.getY(i);
      const width = Math.sin(Math.min(t * 1.15, 1) * Math.PI) * 0.62 + 0.04;
      const x = t * len;
      const y = Math.sin(t * 1.4) * 0.9 - t * t * len * 0.55 * droop - Math.abs(across) * 0.18;
      p.setXYZ(i, x, y, across * width);
    }
    g.computeVertexNormals();
    g.rotateZ(rand.range(-0.05, 0.25));
    g.rotateY((k / fronds) * Math.PI * 2 + rand.range(-0.2, 0.2));
    g.translate(top.x, top.y, top.z);
    parts.push(leaves(g, crownCenter, 0.6 + rand.next() * 0.4, 1, crownCenter, 0));
  }
}

/** Plump hedges along every balcony's planter and planted beds at the foot of the shop fronts and the glass. */
function hedges(parts: THREE.BufferGeometry[]) {
  const ring = (rc: number, yc: number, w: number, h: number, theta0: number, theta1: number, lumps = 1) => {
    const profile: ProfilePoint[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (1.15 - (i / 8) * 1.3);
      profile.push([rc + Math.cos(a) * w, yc + Math.sin(a) * h]);
    }
    const g = sweepArc(profile, theta0, theta1, 220);
    // Lumpy, so the silhouette isn't a clean tube.
    const p = g.attributes.position;
    const centers = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const theta = Math.atan2(x - AXIS.x, z - AXIS.z);
      const bump = 1 + 0.28 * Math.sin((theta * 61) / lumps) * Math.sin((theta * 23) / lumps + y * 3) + 0.12 * Math.sin((theta * 140) / lumps + y * 7);
      const cx = AXIS.x + rc * Math.sin(theta);
      const cz = AXIS.z + rc * Math.cos(theta);
      p.setXYZ(i, cx + (x - cx) * bump, yc + (y - yc) * bump, cz + (z - cz) * bump);
      centers.set([cx, yc - h * 0.5, cz, 0], i * 4);
    }
    g.computeVertexNormals();
    fill(g, 'aColor', [0, 0.35, 0]);
    fill(g, 'aCrown', [0, 0, 0, 0]);
    g.setAttribute('aCenter', new THREE.BufferAttribute(centers, 4));
    g.deleteAttribute('uv');
    parts.push(g);
  };
  for (const y of LEVELS) ring(VOID_R + 0.36, y + 0.74, 0.5, 0.42, BALCONY_THETA[0] + 0.03, BALCONY_THETA[1]);
  ring(VOID_R + 2.2, 0.15, 0.9, 0.85, BALCONY_THETA[0] + 0.08, BALCONY_THETA[1]);
  // A deep tropical bed along the foot of the glass wall.
  ring(GLASS_R - 1.7, 0.3, 1.5, 1.9, GLASS_THETA[0] - 0.15, GLASS_THETA[1] - 0.02, 2.2);
}

function buildPlants(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const spot of TREES) {
    (spot.kind === 'palm' ? palm : broadleaf)(spot, parts);
    if (!spot.planter) continue;
    // Ground cover mounded in the planter.
    const base = polar(spot.r, spot.theta, 0.9);
    const mound = lumpy(new THREE.IcosahedronGeometry(PLANTER_R * 0.95, 2), 0.15, spot.seed * 5).scale(1, 0.4, 1).translate(base.x, base.y, base.z);
    parts.push(leaves(mound, base.clone().setY(0.4), 0.7, 0));
  }
  hedges(parts);
  return mergeAll(parts);
}

export function Plants() {
  const geometry = useDisposable(buildPlants);
  const material = useDisposable(() =>
    shaderMaterial({ uniforms: { ...atriumUniforms }, side: THREE.DoubleSide, vertexShader: plantVertex, fragmentShader: plantFragment }),
  );
  return <mesh geometry={geometry} material={material} />;
}

/**
 * Trailing plants hanging from each balcony's planter: one band per balcony whose shader cuts
 * a ragged, clumpy hem of vines, swaying gently at the tips.
 */
const curtainVertex = /* glsl */ `
attribute float aTop;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vTop;
${LAYOUT_GLSL}
void main() {
  // The tips hang out from the fascia and swing a little, the more the further down.
  vec3 p = position;
  float drop = aTop - p.y;
  vec2 radial = normalize(p.xz - AXIS.xz);
  float sway = sin(uTime * 0.6 + uv.x * 0.25) * 0.5 + sin(uTime * 0.37 + uv.x * 0.11) * 0.5;
  p.xz -= radial * (drop * drop * 0.012 * (1.0 + sway * 0.6));
  p.xz += vec2(-radial.y, radial.x) * drop * drop * 0.008 * sway;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vTop = aTop;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const curtainFragment = /* glsl */ `
${COMMON}
${FOLIAGE}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vTop;
void main() {
  float u = vUv.x;
  float drop = vTop - vWorld.y;
  // Clumps along the balcony, strands within them, each strand its own length.
  float clump = smoothstep(-0.35, 0.6, snoise(vec2(u * 0.16, vTop * 0.37)));
  float strand = floor(u / 0.5);
  float fu = fract(u / 0.5);
  float h1 = hash12(vec2(strand, vTop));
  float len = 0.9 + clump * (0.5 + 3.0 * h1 * h1);
  float edge = len + 0.3 * snoise(vec2(u * 2.6, vWorld.y * 1.8));
  float sheet = 1.0 - smoothstep(len * 0.35, len * 0.9, drop);
  float strandMask = 1.0 - smoothstep(0.32, 0.48, abs(fu - 0.5) + 0.1 * snoise(vec2(u * 4.0, vWorld.y * 3.0)));
  float body = max(sheet, strandMask);
  float px = fwidth(drop) * 1.2;
  float alpha = body * (1.0 - smoothstep(edge - px, edge + px, drop));
  if (alpha < 0.01) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 col = foliage(vWorld, n, vWorld - n * 0.5 + vec3(0.0, 0.6, 0.0), vec4(0.0), 0.5 + 0.5 * h1);
  // Deeper shade towards the tips.
  col *= mix(1.0, 0.7, smoothstep(0.0, 3.5, drop));
  gl_FragColor = vec4(haze(col, vWorld) * alpha, alpha);
}
`;

export function Curtains() {
  const geometry = useDisposable(() =>
    mergeAll(
      LEVELS.map((y) => {
        const top = y + 0.8;
        const profile: ProfilePoint[] = [];
        // Just in front of the fascia, the top edge tucked into the planter.
        for (let i = 0; i <= 8; i++) profile.push([i === 0 ? VOID_R + 0.06 : VOID_R - 0.14, top - (i / 8) * 4.2]);
        return fill(sweepArc(profile, BALCONY_THETA[0] + 0.03, BALCONY_THETA[1], 160), 'aTop', [top]);
      }),
    ),
  );
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...atriumUniforms },
      side: THREE.DoubleSide,
      transparent: true,
      premultipliedAlpha: true,
      vertexShader: curtainVertex,
      fragmentShader: curtainFragment,
    }),
  );
  return <mesh geometry={geometry} material={material} renderOrder={2} />;
}
