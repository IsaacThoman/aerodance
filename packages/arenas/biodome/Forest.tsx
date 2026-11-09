import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { DOME, FLOOR_Y } from './layout.ts';
import { LIGHT, fbm3, fill, fx, limb, merge, valueNoise3 } from './shading.ts';
import { RIVER, TREES, crownBlobs, fromCentre, riverDistance, type Tree } from './trees.ts';

// The rainforest round and below the deck: broad, bulging crowns of glossy leaves packed into a
// canopy, pale smooth trunks rising out of a misty floor, and a river winding across it from
// the foot of the lower fall.

// ------------------------------------------------------------------ crowns and trunks

const FOLIAGE = /* glsl */ `
// Overlapping leaves shingled over a cluster, in cells round its centre: x the leaf's coverage
// (0 in the dark gaps between), y how far along it (0 base, 1 tip), z its own random, w how
// much of the pattern shows (it fades out where its cells get too small to draw).
vec4 shingles(vec3 w, vec3 blob, float r) {
  vec3 d = w - blob;
  float len = max(length(d), 1e-3);
  float el = asin(clamp(d.y / len, -1.0, 1.0));
  float az = length(d.xz) > 1e-4 ? atan(d.x, d.z) : 0.0;
  vec2 q = vec2(az * max(cos(el), 0.3) * r, el * r * 0.9) / 0.42;
  float fade = 1.0 - smoothstep(0.12, 0.26, length(fwidth(q)));
  float cover = 0.0;
  float along = 0.5;
  float rnd = 0.5;
  for (int k = 0; k < 2; k++) {
    vec2 o = q + float(k) * vec2(0.5, 0.47);
    vec2 cell = floor(o);
    vec2 h = hash22(cell + float(k) * 13.7);
    vec2 f = fract(o) - 0.5 - (h - 0.5) * 0.4;
    f = vec2(f.x * cos(h.y - 0.5) - f.y * sin(h.y - 0.5), f.x * sin(h.y - 0.5) + f.y * cos(h.y - 0.5));
    float t = clamp((0.42 - f.y) / 0.97, 0.0, 1.0);
    float hw = 0.42 * pow(sin(3.14159 * pow(t, 0.75)), 0.8) + 0.001;
    float px = fwidth(f.x) + 1e-3;
    float c = (1.0 - smoothstep(hw - px, hw + px, abs(f.x))) * step(-0.55, f.y) * step(f.y, 0.42);
    if (c > 0.02) { cover = max(cover, c); along = t; rnd = h.x; }
  }
  return vec4(cover, along, rnd, fade);
}

// w: surface, n: normal, blob: the leaf cluster's centre and radius, crown: the crown's centre and
// radius, tone: colour variation; n1 (the clumps' noise) varies slowly, so the vertex shader works it out.
vec3 foliage(vec3 w, vec3 n, vec4 blob, vec4 crown, float tone, float n1, float bloom) {
  vec3 v = normalize(cameraPosition - w);
  vec3 s = uSunDir;
  vec3 ball = normalize(w - blob.xyz + vec3(0.0, 1e-4, 0.0));
  float detail = 1.0 - smoothstep(0.04, 0.14, length(fwidth(w)));
  float n2 = snoise(vec2(w.x + w.z * 0.63, w.y - w.z * 0.77) * 1.9 + 5.0) * detail;
  float clump = n1 * 0.7 + n2 * 0.3;
  vec4 sh = shingles(w, blob.xyz, blob.w);
  float leaf = step(0.02, sh.x) * sh.w;
  vec3 nn = normalize(mix(n, ball, 0.5) + vec3(n1, n2, -n1) * 0.2);
  // Each leaf lies flush at its base and lifts away at its tip.
  vec3 downhill = normalize(vec3(0.0, -1.0, 0.0) + ball * ball.y + vec3(1e-4, 0.0, 0.0));
  nn = normalize(nn - downhill * (sh.y - 0.35) * 0.6 * leaf);
  float reach = sunReach(w);
  float diff = clamp(dot(nn, s) * 0.85 + 0.15, 0.0, 1.0) * reach;
  float ao = 0.62 + 0.38 * smoothstep(-0.9, 0.6, ball.y);
  vec3 c = (w - crown.xyz) / crown.w;
  ao *= mix(0.45, 1.0, smoothstep(0.3, 0.9, length(c))) * (0.65 + 0.35 * smoothstep(-0.5, 0.4, c.y));
  ao *= 0.7 + 0.3 * smoothstep(-0.55, 0.55, clump);
  // The dark gaps between leaves.
  ao *= mix(1.0, mix(0.5, 1.0, smoothstep(0.0, 0.6, sh.x)) * (0.88 + 0.12 * sh.y), sh.w);
  vec3 dark = vec3(0.01, 0.09, 0.04);
  vec3 mid = mix(vec3(0.04, 0.32, 0.1), vec3(0.18, 0.5, 0.06), tone);
  vec3 lite = vec3(0.52, 0.86, 0.18);
  vec3 albedo = mix(dark, mid, smoothstep(-0.9, 0.3, clump + 0.3));
  albedo *= mix(1.0, 0.86 + 0.28 * sh.z, leaf);
  if (bloom > 0.1) {
    // Blossom over the crown's sunny top, or a bronze flush of new leaves.
    vec3 flower = bloom < 0.3 ? vec3(1.0, 0.42, 0.68) : bloom < 0.5 ? vec3(1.0, 0.36, 0.1) : bloom < 0.7 ? vec3(1.0, 0.82, 0.16) : bloom < 0.9 ? vec3(0.62, 0.42, 1.0) : vec3(0.62, 0.3, 0.12);
    float top = smoothstep(-0.3, 0.6, nn.y + ball.y * 0.5);
    float dots = bloom > 0.9 ? smoothstep(-0.2, 0.5, n2 + n1 * 0.4) : smoothstep(0.05, 0.45, n2 + n1 * 0.3);
    dots = mix(dots, step(bloom > 0.9 ? 0.35 : 0.5, sh.z) * leaf, sh.w);
    albedo = mix(albedo, flower * 0.9, dots * top * (bloom > 0.9 ? 0.6 : 0.85));
  }
  vec3 col = albedo * ambient(nn) * ao * 0.95 + mix(albedo, lite, 0.28) * SUN * diff * 0.62 * (0.4 + 0.6 * ao);
  float back = pow(max(dot(-v, s), 0.0), 3.0) * pow(1.0 - max(dot(nn, v), 0.0), 2.0);
  col += vec3(0.45, 0.85, 0.12) * back * reach * 0.7;
  // Glossy leaves catch the sun, one here and there.
  float glossy = mix(smoothstep(0.3, 0.85, n2), step(0.55, sh.z) * leaf, sh.w);
  float glint = glossy * pow(max(dot(reflect(-s, nn), v), 0.0), 18.0);
  col += vec3(1.0, 1.0, 0.85) * glint * reach * 0.8;
  col += vec3(0.5, 0.75, 0.9) * pow(1.0 - max(dot(nn, v), 0.0), 4.0) * max(nn.y, 0.0) * 0.22 * ao;
  return col;
}
`;

const treeVertex = /* glsl */ `
uniform float uTime;
uniform sampler2D uNoise;
attribute vec3 aColor;
attribute vec4 aCenter;
attribute vec4 aCrown;
attribute float aBlobR;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying vec4 vCenter;
varying vec4 vCrown;
varying float vN1;
varying float vBlobR;
void main() {
  vec3 p = position;
  vBlobR = aBlobR;
  // aCenter.w: how much this vertex sways (0 for wood).
  float ph = aCenter.x * 0.37 + aCenter.z * 0.23;
  float sway = aCenter.w;
  p.x += sin(uTime * 0.5 + ph) * 0.1 * sway;
  p.z += cos(uTime * 0.41 + ph * 1.3) * 0.08 * sway;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = aColor;
  vCenter = aCenter;
  vCrown = aCrown;
  vN1 = (texture2D(uNoise, w.xz * 0.045 + w.y * 0.03).r * 2.0 - 1.0) * 1.4;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const treeFragment = /* glsl */ `
${LIGHT}
${FOLIAGE}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying vec4 vCenter;
varying vec4 vCrown;
varying float vN1;
varying float vBlobR;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 col;
  if (vColor.r > 0.0) {
    // Smooth pale bark, mossy where it faces up, darker low in the forest.
    float reach = sunReach(vWorld);
    float moss = smoothstep(0.1, 0.7, n.y + tnoise(vWorld.xz * 1.3 + vWorld.y * 0.4).r * 0.6);
    float streak = tnoise(vec2(atan(n.x, n.z + 1e-4) * 2.0, vWorld.y * 0.35)).g;
    vec3 bark = vColor * (0.9 + 0.2 * streak);
    bark = mix(bark, vec3(0.16, 0.36, 0.1), moss * 0.7);
    // Mossy bands and lichen up the trunk.
    float band = smoothstep(0.35, 0.75, tnoise(vec2(atan(n.x, n.z + 1e-4) * 0.8, vWorld.y * 0.25) + 11.0).b);
    bark = mix(bark, vec3(0.2, 0.4, 0.12), band * 0.55);
    float sun = max(dot(n, uSunDir), 0.0) * reach;
    col = bark * (ambient(n) * 0.85 + SUN * sun * 0.6);
    col *= mix(0.55, 1.0, smoothstep(-20.0, -6.0, vWorld.y));
  } else {
    col = foliage(vWorld, n, vec4(vCenter.xyz, vBlobR), vCrown, vColor.g, vN1, vColor.b);
  }
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

const BARK = [0.33, 0.28, 0.22] as const;

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
    const k = 1 + amount * valueNoise3(x * 1.7 + seed, y * 1.7 - seed, z * 1.7 + seed * 0.5);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  m.computeVertexNormals();
  return m;
}

const leafy = (g: THREE.BufferGeometry, blob: THREE.Vector3, blobR: number, tone: number, sway: number, crown: THREE.Vector3, crownR: number, bloom = 0) =>
  fill(fill(fill(fill(g, 'aBlobR', [blobR]), 'aColor', [0, tone, bloom]), 'aCenter', [blob.x, blob.y, blob.z, sway]), 'aCrown', [crown.x, crown.y, crown.z, crownR]);
export const woody = (g: THREE.BufferGeometry, color: readonly number[] = BARK) => {
  g.deleteAttribute('uv');
  return fill(fill(fill(fill(g, 'aBlobR', [1]), 'aColor', color), 'aCenter', [0, 0, 0, 0]), 'aCrown', [0, 0, 0, 1]);
};

/**
 * Some crowns are in flower or flushed with new growth: 0 none, 0.2 pink, 0.4 flame orange,
 * 0.6 gold, 0.8 violet, 1 bronze new leaves.
 */
function bloomOf(t: Tree): number {
  if (t.under) return 0;
  const k = (t.seed * 0.6180339887) % 1;
  if (k < 0.04) return 0.2;
  if (k < 0.07) return 0.4;
  if (k < 0.1) return 0.6;
  if (k < 0.125) return 0.8;
  if (k < 0.2) return 1;
  return 0;
}

/** Distance from the deck, to spend detail where it's seen up close. */
const near = (t: Tree) => Math.hypot(t.x, t.z) < 24;

function crown(t: Tree, parts: THREE.BufferGeometry[]) {
  const centre = new THREE.Vector3(t.x, t.y, t.z);
  const detail = fromCentre(t) < 10 && !t.under ? 2 : 1;
  crownBlobs(t).forEach((b, i) => {
    const g = lumpy(new THREE.IcosahedronGeometry(b.r, detail), 0.16, t.seed * 7 + i).scale(1, 0.8, 1).translate(b.c.x, b.c.y, b.c.z);
    parts.push(leafy(g, b.c, b.r, t.tone, t.r > 6 ? 0.5 : 1, centre, t.r, bloomOf(t)));
  });
}

function trunk(t: Tree, parts: THREE.BufferGeometry[]) {
  const rand = makeRandom(t.seed * 17 + 3);
  const fork = new THREE.Vector3(t.x + rand.range(-0.4, 0.4), t.y - t.r * 0.4, t.z + rand.range(-0.4, 0.4));
  const base = new THREE.Vector3(t.x, FLOOR_Y - 0.5, t.z);
  const segs = near(t) ? 10 : 7;
  // A straight trunk with a slight kink, buttresses flaring at its foot.
  const knee = base.clone().lerp(fork, 0.55).add(new THREE.Vector3(rand.range(-0.5, 0.5), 0, rand.range(-0.5, 0.5)));
  parts.push(woody(limb(base, knee, t.trunk, t.trunk * 0.82, segs)));
  parts.push(woody(limb(knee, fork, t.trunk * 0.82, t.trunk * 0.62, segs)));
  if (near(t) && !t.under) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + rand.range(-0.3, 0.3);
      const fin = new THREE.BoxGeometry(t.trunk * 0.35, 3.2, t.trunk * 2.6);
      fin.translate(0, 1.6, t.trunk * 1.05);
      const pos = fin.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        // Taper the fin: full at the ground, into the trunk at its top.
        const y = pos.getY(i) / 3.2;
        pos.setZ(i, pos.getZ(i) * (1 - y * 0.75) + y * 0.1);
      }
      fin.computeVertexNormals();
      fin.rotateY(a).translate(t.x, FLOOR_Y - 0.2, t.z);
      parts.push(woody(fin));
    }
  }
  // Limbs reaching up and out into the crown.
  const limbs = t.under ? 2 : t.r > 6 ? 4 : 3;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rand.range(0, 1);
    const tip = new THREE.Vector3(t.x + Math.cos(a) * t.r * 0.45, t.y + rand.range(-0.1, 0.2) * t.r, t.z + Math.sin(a) * t.r * 0.45);
    parts.push(woody(limb(fork, tip, t.trunk * 0.5, t.trunk * 0.18, 6)));
  }
}

/** The trees in a mesh per sector round the deck (and one for those near it), so the ones out of view are culled. */
function buildTrees(): THREE.BufferGeometry[] {
  const SECTORS = 8;
  const groups: THREE.BufferGeometry[][] = Array.from({ length: SECTORS + 1 }, () => []);
  for (const t of TREES) {
    const group = near(t) ? SECTORS : Math.floor(((Math.atan2(t.x, t.z) / (Math.PI * 2) + 1) % 1) * SECTORS);
    crown(t, groups[group]);
    trunk(t, groups[group]);
  }
  return groups.filter((g) => g.length).map((g) => merge(g));
}

/** The trees' material: foliage, or bark where aColor.r > 0 (see woody()). */
export const treeMaterial = () => shaderMaterial({ uniforms: { ...fx }, vertexShader: treeVertex, fragmentShader: treeFragment });

export function Trees() {
  const geometries = useDisposable(buildTrees);
  const material = useDisposable(treeMaterial);
  return (
    <>
      {geometries.map((geometry, i) => <mesh key={i} geometry={geometry} material={material} />)}
    </>
  );
}

// ------------------------------------------------------------------ the floor and its river

export function floorHeight(x: number, z: number): number {
  const d = riverDistance(x, z);
  const bank = THREE.MathUtils.smoothstep(d, 1.5, 7);
  return FLOOR_Y + fbm3(x * 0.05, 0, z * 0.05, 3) * 2.2 * bank + (bank - 1) * 1.2;
}

const groundFragment = /* glsl */ `
${LIGHT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vNormal);
  vec2 p = vWorld.xz;
  float litter = tnoise(p * 0.9).r * 0.5 + tnoise(p * 2.7).g * 0.3 + tnoise(p * 0.2).b * 0.6;
  vec3 moss = vec3(0.1, 0.3, 0.08);
  vec3 soil = vec3(0.22, 0.18, 0.1);
  vec3 albedo = mix(soil, moss, smoothstep(-0.4, 0.4, litter));
  // Damp, darker banks by the river.
  albedo = mix(albedo, vec3(0.08, 0.16, 0.08), max(vUv.x, 0.0));
  if (vUv.x < -0.5) {
    // The meadow outside: mown green, sunlit.
    vec3 grass = mix(vec3(0.24, 0.52, 0.16), vec3(0.36, 0.62, 0.2), tnoise(p * 0.05).r * 0.5 + 0.5);
    vec3 lit = grass * (ambient(n) + SUN * max(dot(n, uSunDir), 0.0) * 0.7);
    float far = 1.0 - exp(-length(vWorld - cameraPosition) * 0.0022);
    gl_FragColor = vec4(mix(lit, vec3(0.72, 0.86, 0.95), far * 0.85), 1.0);
    return;
  }
  float reach = sunReach(vWorld);
  vec3 col = albedo * (ambient(n) * 0.9 + SUN * max(dot(n, uSunDir), 0.0) * reach * 0.6);
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

const groundVertex = /* glsl */ `
attribute float aBank;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vUv = vec2(aBank, 0.0);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** The floor inside the dome, a disc whose edge settles to FLOOR_Y to meet the meadow outside. */
function buildFloor(): THREE.BufferGeometry {
  const rings = 56;
  const segments = 120;
  const radius = 64;
  const positions: number[] = [];
  const bank: number[] = [];
  const index: number[] = [];
  positions.push(DOME.center.x, floorHeight(DOME.center.x, DOME.center.z), DOME.center.z);
  bank.push(0);
  for (let j = 1; j <= rings; j++) {
    const r = radius * Math.pow(j / rings, 0.8);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = DOME.center.x + Math.sin(a) * r;
      const z = DOME.center.z + Math.cos(a) * r;
      const edge = THREE.MathUtils.smoothstep(r, 56, 63);
      positions.push(x, THREE.MathUtils.lerp(floorHeight(x, z), FLOOR_Y, edge), z);
      bank.push((1 - THREE.MathUtils.smoothstep(riverDistance(x, z), 2, 6)) * (1 - edge));
    }
  }
  for (let i = 0; i < segments; i++) index.push(0, 1 + i, 1 + ((i + 1) % segments));
  for (let j = 1; j < rings; j++) {
    const a0 = 1 + (j - 1) * segments;
    const b0 = 1 + j * segments;
    for (let i = 0; i < segments; i++) {
      const i1 = (i + 1) % segments;
      index.push(a0 + i, b0 + i, a0 + i1, a0 + i1, b0 + i, b0 + i1);
    }
  }
  // The meadow outside the dome, out to the hills.
  const outer = new THREE.RingGeometry(radius - 0.5, 1000, segments, 4).rotateX(-Math.PI / 2).translate(DOME.center.x, FLOOR_Y - 0.03, DOME.center.z);
  const base = positions.length / 3;
  const op = outer.attributes.position;
  for (let i = 0; i < op.count; i++) {
    positions.push(op.getX(i), op.getY(i), op.getZ(i));
    bank.push(-1);
  }
  const oi = outer.index!;
  for (let i = 0; i < oi.count; i++) index.push(base + oi.getX(i));
  outer.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aBank', new THREE.Float32BufferAttribute(bank, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const riverFragment = /* glsl */ `
${LIGHT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  float flow = vUv.x * 0.18 - uTime * 0.5;
  vec4 a = tnoise(vec2(vUv.y * 1.2, flow));
  vec4 b = tnoise(vec2(vUv.y * 2.6 + 3.0, flow * 1.7 + 1.3));
  vec3 n = normalize(vec3((a.x + b.y * 0.5) * 0.16, 1.0, (a.y + b.x * 0.5) * 0.16));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  float reach = sunReach(vWorld);
  float edge = abs(vUv.y - 0.5) * 2.0;
  vec3 body = mix(vec3(0.02, 0.36, 0.38), vec3(0.18, 0.55, 0.42), edge);
  body *= 0.5 + 0.6 * reach;
  vec3 sky = vec3(0.65, 0.85, 0.9);
  vec3 col = mix(body, sky, fres * 0.6);
  col += SUN * pow(max(dot(n, normalize(uSunDir + v)), 0.0), 120.0) * 2.5 * reach;
  col += vec3(0.85, 0.95, 0.95) * smoothstep(0.35, 0.6, b.z) * smoothstep(0.55, 0.95, edge) * 0.4;
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

const riverVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = vec3(0.0, 1.0, 0.0);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

function buildRiver(): THREE.BufferGeometry {
  const steps = 160;
  const pts = RIVER.getSpacedPoints(steps);
  const position: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  let along = 0;
  const water = FLOOR_Y - 0.95;
  for (let i = 0; i <= steps; i++) {
    const p = pts[i];
    const q = pts[Math.min(i + 1, steps)];
    const o = pts[Math.max(i - 1, 0)];
    const tx = q.x - o.x;
    const tz = q.z - o.z;
    const tl = Math.hypot(tx, tz) || 1;
    if (i > 0) along += p.distanceTo(pts[i - 1]);
    const w = 3.2 + 0.9 * Math.sin(i * 0.19);
    for (const s of [-1, 1]) {
      position.push(p.x + (-tz / tl) * w * s, water, p.z + (tx / tl) * w * s);
      uv.push(along, s * 0.5 + 0.5);
    }
    if (i < steps) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export function ForestFloor() {
  const parts = useDisposable(() => ({ floor: buildFloor(), river: buildRiver() }));
  const materials = useDisposable(() => ({
    floor: shaderMaterial({ uniforms: { ...fx }, vertexShader: groundVertex, fragmentShader: groundFragment }),
    river: shaderMaterial({ uniforms: { ...fx }, vertexShader: riverVertex, fragmentShader: riverFragment, side: THREE.DoubleSide }),
  }));
  return (
    <>
      <mesh geometry={parts.floor} material={materials.floor} />
      <mesh geometry={parts.river} material={materials.river} />
    </>
  );
}
