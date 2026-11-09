import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { FALL, FLOOR_Y, LOWER_FALL, POOL, SHELF } from './layout.ts';
import { LIGHT, WORLD_VERTEX, fbm3, fx, merge } from './shading.ts';

// The waterfall: a mossy cliff off the deck's -x side, a ribbon of water pouring off its lip
// into a clear pool in a rock basin beside the deck, the pool spilling over its north rim in a
// second fall down to the forest floor, and spray drifting up from both feet.

// ------------------------------------------------------------------ rock

interface Blob {
  c: readonly [number, number, number];
  r: readonly [number, number, number];
  seed: number;
}

const CLIFF: readonly Blob[] = [
  { c: [-22.6, 1, -3.4], r: [5.4, 15.5, 6.8], seed: 1 },
  { c: [-21, -1, -11.5], r: [6.2, 11.5, 5.6], seed: 2 },
  { c: [-20.6, -1, 5.2], r: [5.8, 12.5, 6.2], seed: 3 },
  { c: [-28, 3, -3], r: [7, 16, 11], seed: 4 },
  { c: [-16.8, -7, 10.4], r: [4.2, 8.5, 3.8], seed: 5 },
  { c: [-16.4, -7.5, -13.6], r: [4.8, 8.6, 4.4], seed: 6 },
  // The ledge the upper fall pours off.
  { c: [-18.9, 11.7, -3.4], r: [2.0, 1.3, 2.7], seed: 7 },
  // A boulder at the pool's south rim, and one by the lower fall.
  { c: [-12.6, -0.8, 5.3], r: [2.4, 1.5, 1.8], seed: 8 },
  { c: [-6.6, -0.9, -8.8], r: [1.6, 1.1, 1.5], seed: 9 },
];

/** Boulders round the pool's rim, leaving the deck's side and the lower fall's notch open. */
function rimBoulders(): Blob[] {
  const rand = makeRandom(612);
  const out: Blob[] = [];
  const notch = Math.atan2(LOWER_FALL.x - POOL.x, LOWER_FALL.z - POOL.z);
  for (let i = 0; i < 22; i++) {
    const t = (i / 22) * Math.PI * 2 + rand.range(-0.08, 0.08);
    const k = SHELF.rim + rand.range(0.02, 0.1);
    const x = POOL.x + Math.sin(t) * POOL.rx * SHELF.scale * k;
    const z = POOL.z + Math.cos(t) * POOL.rz * SHELF.scale * k;
    if (x > -6.6) continue;
    const dn = Math.abs(((t - notch + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (dn < 0.32) continue;
    const r = rand.range(0.55, 1.25);
    out.push({ c: [x, -0.35 + r * 0.1, z], r: [r * rand.range(1, 1.5), r * 0.6, r * rand.range(0.9, 1.3)], seed: 20 + i });
  }
  return out;
}

function blob({ c, r, seed }: Blob): THREE.BufferGeometry {
  const detail = THREE.MathUtils.clamp(Math.round(Math.max(...r) * 0.9), 4, 13);
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  ico.dispose();
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const x = c[0] + v.x * r[0];
    const y = c[1] + v.y * r[1];
    const z = c[2] + v.z * r[2];
    // Rough rock with ledges stepping across it.
    const n = fbm3(x * 0.16 + seed, y * 0.16, z * 0.16, 4);
    const ledge = 0.05 * THREE.MathUtils.smoothstep((y * 0.32 + n) % 1, 0.3, 0.6);
    const k = 1 + 0.2 * n + ledge;
    p.setXYZ(i, c[0] + v.x * r[0] * k, c[1] + v.y * r[1] * k, c[2] + v.z * r[2] * k);
  }
  g.computeVertexNormals();
  return g;
}

/** The pool's rock shelf: a column of rock up from the floor, its top dished into the basin. */
function shelf(): THREE.BufferGeometry {
  const rx = POOL.rx * SHELF.scale;
  const rz = POOL.rz * SHELF.scale;
  const profile: readonly (readonly [number, number])[] = [
    [0.96, FLOOR_Y - 1], [1.04, -17], [0.96, -10], [1.03, -5], [1.0, -1.6], [0.96, -0.6], [0.91, -0.3],
    [SHELF.rim, -0.22], [SHELF.rim - 0.04, -0.75], [0.72, -1.4], [0.5, -1.9], [0.0, -2.1],
  ];
  const segments = 120;
  const notch = Math.atan2(LOWER_FALL.x - POOL.x, LOWER_FALL.z - POOL.z);
  const notchHalf = (LOWER_FALL.width / 2 + 0.25) / ((rx + rz) * 0.5 * SHELF.rim);
  const positions: number[] = [];
  const index: number[] = [];
  const n = profile.length;
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    let dn = Math.abs(((t - notch + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    dn = 1 - THREE.MathUtils.smoothstep(dn, notchHalf * 0.75, notchHalf * 1.25);
    for (let j = 0; j < n; j++) {
      const [k, y0] = profile[j];
      let x = POOL.x + Math.sin(t) * rx * k;
      let z = POOL.z + Math.cos(t) * rz * k;
      let y = y0;
      if (k > SHELF.rim - 0.05 && y0 > -1) y = THREE.MathUtils.lerp(y0, Math.min(y0, POOL.y - 0.1), dn);
      if (k > SHELF.rim - 0.01) {
        // Rough outside the rim; the basin inside stays smooth (the water hides it).
        const out = (y0 < -1 ? 0.9 : 0.3) * fbm3(x * 0.25, y * 0.25, z * 0.25, 4);
        x += Math.sin(t) * out;
        z += Math.cos(t) * out;
        y += y0 > -1 ? out * 0.12 : 0;
      }
      positions.push(x, y, z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = a + n;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const rockFragment = /* glsl */ `
${LIGHT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec3 bw = abs(n);
  bw /= bw.x + bw.y + bw.z;
  float grain = tnoise(w.zy * 0.8).r * bw.x + tnoise(w.xz * 0.8).g * bw.y + tnoise(w.xy * 0.8).b * bw.z;
  float fine = tnoise(w.zy * 2.6 + 3.0).g * bw.x + tnoise(w.xz * 2.6).b * bw.y + tnoise(w.xy * 2.6 + 1.0).r * bw.z;
  float big = tnoise(w.xz * 0.11 + w.y * 0.07).a;
  vec3 stone = mix(vec3(0.24, 0.27, 0.27), vec3(0.6, 0.6, 0.54), smoothstep(-0.6, 0.6, grain + fine * 0.4));
  // Bedding planes across the cliff, wavering, and dark cracks down it.
  float bed = fract(w.y * 0.42 + big * 0.6 + grain * 0.15);
  stone *= 0.78 + 0.3 * smoothstep(0.0, 0.25, bed) * smoothstep(1.0, 0.7, bed);
  float crack = 1.0 - smoothstep(0.0, 0.06, abs(tnoise(vec2((w.x + w.z) * 0.35, w.y * 0.12) + 7.0).g));
  stone *= 1.0 - crack * 0.55 * (1.0 - bw.y);
  float streak = tnoise(vec2((w.x + w.z) * 0.9, w.y * 0.05)).r;
  stone *= 0.78 + 0.28 * streak;
  // Moss on every ledge and top, in patches down the faces, cushioned and bright where it's lit.
  float mossy = smoothstep(0.05, 0.5, n.y + big * 0.5 + grain * 0.3);
  mossy = max(mossy, smoothstep(0.2, 0.7, big + fine * 0.35) * 0.85);
  mossy *= 0.75 + 0.25 * smoothstep(-0.4, 0.4, fine);
  vec3 moss = mix(vec3(0.05, 0.24, 0.05), vec3(0.36, 0.64, 0.1), smoothstep(-0.5, 0.7, fine + grain * 0.5));
  vec3 albedo = mix(stone, moss, mossy);
  // Wet behind and beside the falls: darker, glossy.
  float wet = (1.0 - smoothstep(${(FALL.width * 0.6).toFixed(2)}, ${(FALL.width * 1.4).toFixed(2)}, abs(w.z - ${FALL.z.toFixed(2)}))) * step(w.x, ${(FALL.x + 1.5).toFixed(2)}) * step(-1.5, w.y);
  wet = max(wet, (1.0 - smoothstep(${(LOWER_FALL.width * 0.6).toFixed(2)}, ${(LOWER_FALL.width * 1.6).toFixed(2)}, length(w.xz - vec2(${LOWER_FALL.x.toFixed(2)}, ${(LOWER_FALL.z - 1.5).toFixed(2)})))) * step(w.y, 0.0));
  albedo *= 1.0 - wet * 0.35;
  float reach = sunReach(w);
  vec3 col = albedo * (ambient(n) * 0.9 + SUN * max(dot(n, uSunDir), 0.0) * reach * 0.75);
  float spec = pow(max(dot(n, normalize(uSunDir + v)), 0.0), 36.0);
  col += SUN * spec * (0.05 + wet * 0.6) * reach;
  col += vec3(0.6, 0.8, 0.9) * pow(1.0 - max(dot(n, v), 0.0), 4.0) * wet * 0.3;
  // Darker low down in the forest.
  col *= mix(0.6, 1.0, smoothstep(-20.0, -5.0, w.y));
  gl_FragColor = vec4(haze(col, w), 1.0);
}
`;

export function Rocks() {
  const geometry = useDisposable(() => merge([shelf(), ...CLIFF.map(blob), ...rimBoulders().map(blob)]));
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...fx }, vertexShader: WORLD_VERTEX, fragmentShader: rockFragment }));
  return <mesh geometry={geometry} material={material} receiveShadow />;
}

// ------------------------------------------------------------------ the pool

const POOL_R = SHELF.scale * SHELF.rim + 0.03;

const poolFragment = /* glsl */ `
${LIGHT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
const vec2 C = vec2(${POOL.x.toFixed(2)}, ${POOL.z.toFixed(2)});
const vec2 RAD = vec2(${(POOL.rx * POOL_R).toFixed(3)}, ${(POOL.rz * POOL_R).toFixed(3)});
const vec2 FOOT = vec2(${(FALL.x + FALL.reach).toFixed(2)}, ${FALL.z.toFixed(2)});
void main() {
  vec2 p = vWorld.xz;
  float e = length((p - C) / RAD);
  float depth = clamp(1.0 - e * e, 0.0, 1.0);
  float t = uTime;
  // Ripples, and rings spreading from where the fall lands.
  vec4 a = tnoise(p * 0.6 + vec2(t * 0.11, t * 0.07));
  vec4 b = tnoise(p * 1.4 - vec2(t * 0.09, -t * 0.13));
  vec2 slope = (a.xy * 0.6 + b.zw * 0.4) * 0.12;
  vec2 d = p - FOOT;
  float r = length(d);
  float k = exp(-r * 0.55);
  float ring = sin(r * 5.0 - t * 4.0);
  slope += d / max(r, 1e-3) * ring * k * 0.22;
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  // Clear water: the pale stone bed and its caustics through the shallows, deep aqua in the middle.
  vec2 q = p + n.xz * 0.6;
  float c1 = tnoise(q * 0.9 + vec2(t * 0.12, -t * 0.08)).r;
  float c2 = tnoise(q * 1.25 - vec2(t * 0.1, t * 0.13)).g;
  float caustic = pow(1.0 - abs(c1 - c2), 8.0);
  vec3 bed = mix(vec3(0.62, 0.72, 0.6), vec3(0.4, 0.6, 0.44), tnoise(q * 0.4).b * 0.5 + 0.5);
  vec3 shallow = bed * vec3(0.55, 0.92, 0.86) + vec3(1.0, 0.95, 0.8) * caustic * 0.55;
  vec3 deep = vec3(0.0, 0.34, 0.42);
  vec3 body = mix(shallow, deep, smoothstep(0.05, 0.75, depth));
  body *= ambient(vec3(0.0, 1.0, 0.0)) * 0.9 + SUN * 0.45;
  vec3 r3 = reflect(-v, n);
  vec3 sky = mix(vec3(0.42, 0.66, 0.5), vec3(0.85, 0.96, 1.0), smoothstep(0.0, 0.5, r3.y));
  vec3 col = mix(body, sky, clamp(fres * 0.8, 0.0, 1.0));
  // Sun glints dancing on the ripples.
  float glint = pow(max(dot(n, normalize(uSunDir + v)), 0.0), 300.0);
  col += SUN * glint * 5.0;
  float tw = tnoise(p * 1.8 + vec2(t * 0.31, -t * 0.23)).r * tnoise(p * 2.3 - vec2(t * 0.2, t * 0.27)).g;
  col += vec3(1.0, 0.98, 0.9) * smoothstep(0.3, 0.5, tw) * 1.2;
  // White water where the fall lands, and a pale lip at the rim.
  float foam = k * (0.6 + 0.4 * ring) * smoothstep(-0.3, 0.5, tnoise(p * 1.2 + t * vec2(0.5, -0.3)).r + k);
  col = mix(col, vec3(0.95, 1.0, 1.0) * 1.15, clamp(foam, 0.0, 1.0) * 0.85);
  col = mix(col, vec3(0.86, 0.96, 0.94), smoothstep(0.86, 0.99, e) * 0.35);
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

export function Pool() {
  const geometry = useDisposable(() => new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2).scale(POOL.rx * POOL_R, 1, POOL.rz * POOL_R).translate(POOL.x, POOL.y, POOL.z));
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...fx }, vertexShader: WORLD_VERTEX, fragmentShader: poolFragment }));
  return <mesh geometry={geometry} material={material} />;
}

// ------------------------------------------------------------------ the falls

interface Sheet {
  lip: THREE.Vector3;
  /** Outwards, level. */
  dir: THREE.Vector2;
  width: number;
  drop: number;
  reach: number;
}

const SHEETS: readonly Sheet[] = [
  { lip: new THREE.Vector3(FALL.x, FALL.y, FALL.z), dir: new THREE.Vector2(1, 0), width: FALL.width * 0.8, drop: FALL.y - POOL.y + 0.1, reach: FALL.reach },
  {
    lip: new THREE.Vector3(LOWER_FALL.x, LOWER_FALL.y + 0.02, LOWER_FALL.z),
    dir: new THREE.Vector2(LOWER_FALL.x - POOL.x, LOWER_FALL.z - POOL.z).normalize(),
    width: LOWER_FALL.width,
    drop: LOWER_FALL.y - FLOOR_Y + 1,
    reach: LOWER_FALL.reach,
  },
];

function buildSheets(): THREE.BufferGeometry {
  const NU = 8;
  const NV = 34;
  const pos: number[] = [];
  const uv: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  let base = 0;
  SHEETS.forEach((s, k) => {
    const side = new THREE.Vector3(-s.dir.y, 0, s.dir.x);
    const out = new THREE.Vector3(s.dir.x, 0, s.dir.y);
    for (let j = 0; j <= NV + 1; j++) {
      // Row 0 lies back on the lip; the fall starts at row 1.
      const v = j === 0 ? 0 : (j - 1) / NV;
      for (let i = 0; i <= NU; i++) {
        const u = i / NU;
        const c = u * 2 - 1;
        const w = s.width * (1 + 0.35 * v) * 0.5;
        const p = s.lip.clone();
        if (j === 0) {
          p.addScaledVector(out, -1.6);
          p.y += 0.05;
        } else {
          // An arc: out fast over the lip, then falling ever steeper.
          p.addScaledVector(out, s.reach * Math.sqrt(v) + 0.15 * v);
          p.y -= s.drop * v * v * 0.35 + s.drop * v * 0.65;
        }
        p.addScaledVector(side, c * w);
        p.addScaledVector(out, -c * c * s.width * 0.12);
        pos.push(p.x, p.y, p.z);
        uv.push(u, j === 0 ? -0.05 : v);
        info.push(k * 17.3, s.width, s.drop, 0);
      }
    }
    for (let j = 0; j <= NV; j++) {
      for (let i = 0; i < NU; i++) {
        const a = base + j * (NU + 1) + i;
        idx.push(a, a + NU + 1, a + 1, a + 1, a + NU + 1, a + NU + 2);
      }
    }
    base += (NV + 2) * (NU + 1);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFall', new THREE.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const sheetVertex = /* glsl */ `
attribute vec4 aFall;
varying vec2 vUv;
varying vec4 vFall;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vFall = aFall;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const sheetFragment = /* glsl */ `
${LIGHT}
varying vec2 vUv;
varying vec4 vFall;
varying vec3 vWorld;
void main() {
  float seed = vFall.x;
  float width = vFall.y;
  float drop = vFall.z;
  float u = vUv.x;
  float v = max(vUv.y, 0.0);
  // Streaks pour down, faster as the water falls: fine threads over broader ropes.
  float fallen = (v * 0.65 + v * v * 0.35) * drop;
  float speed = uTime * 6.0;
  float s1 = tnoise(vec2(u * width * 2.6 + seed, (fallen - speed) * 0.08)).r;
  float s2 = tnoise(vec2(u * width * 6.0 + seed * 2.0, (fallen - speed * 1.3) * 0.15 + 3.0)).g;
  float streak = s1 * 0.55 + s2 * 0.45;
  // Over the lip it's a smooth glassy curl; then it breaks into white ropes.
  float glassy = 1.0 - smoothstep(0.02, 0.12, v);
  float ropes = smoothstep(-0.3, 0.35, tnoise(vec2(u * width * 1.1 + seed * 3.0, v * 0.5 + seed)).b + 0.2);
  float edge = smoothstep(0.0, 0.16, u) * smoothstep(1.0, 0.84, u);
  float body = edge * mix(mix(0.45, 1.0, ropes), 1.0, glassy);
  body *= smoothstep(-0.06, 0.02, vUv.y);
  body *= 1.0 - smoothstep(0.88, 1.0, v);
  float alpha = body * mix(0.22 + 0.78 * smoothstep(-0.35, 0.45, streak), 0.7, glassy);
  vec3 water = mix(vec3(0.6, 0.88, 0.9), vec3(1.0), smoothstep(-0.25, 0.5, streak) * (1.0 - glassy));
  vec3 view = normalize(cameraPosition - vWorld);
  float lit = clamp(dot(view, uSunDir) * 0.3 + 0.85, 0.0, 1.2);
  vec3 col = water * (SUN * 0.6 * lit + SKY_LIGHT * 1.0);
  col += vec3(1.0, 0.98, 0.92) * smoothstep(0.5, 0.8, streak) * 0.9 * (1.0 - glassy);
  // The glassy curl catches the light along its crest.
  col += vec3(0.85, 1.0, 1.0) * glassy * smoothstep(0.3, 0.7, s2 * 0.5 + 0.5) * 0.7;
  col = haze(col, vWorld);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export function Waterfalls() {
  const geometry = useDisposable(buildSheets);
  const material = useDisposable(() => shaderMaterial({
    uniforms: { ...fx },
    vertexShader: sheetVertex,
    fragmentShader: sheetFragment,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
  }));
  return <mesh geometry={geometry} material={material} renderOrder={20} />;
}

// ------------------------------------------------------------------ spray and mist

const mistVertex = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aParams;
uniform float uTime;
varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying vec3 vWorld;
varying float vAlpha;
void main() {
  // aParams: size, rise, phase, rate (negative rate: a slow, still bank of mist).
  float rate = abs(aParams.w);
  float age = fract(uTime * rate + aParams.z);
  vec3 c = aCenter;
  float bank = step(aParams.w, 0.0);
  c.y += age * aParams.y;
  c.x += sin(age * 3.0 + aParams.z * 20.0) * 0.8 + bank * sin(uTime * 0.03 + aParams.z * 9.0) * 4.0;
  c.z += bank * cos(uTime * 0.025 + aParams.z * 7.0) * 4.0;
  float s = aParams.x * (0.6 + age * 0.8 * (1.0 - bank));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 w = c + (right * position.x * (1.0 + bank * 1.2) + up * position.y * 0.85) * s;
  vUv = uv;
  vAge = mix(age, 0.5, bank);
  vSeed = aParams.z;
  vWorld = w;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  // Fade out close up, so no puff fills the view.
  vAlpha = smoothstep(1.5, 6.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const mistFragment = /* glsl */ `
${LIGHT}
varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying vec3 vWorld;
varying float vAlpha;
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  float billow = tnoise(vUv * 1.4 + vSeed * 13.0 + vec2(0.0, -uTime * 0.04)).r;
  float a = smoothstep(1.0, 0.15, r) * smoothstep(-0.6, 0.4, billow + 0.25 - r * 0.6);
  a *= smoothstep(0.0, 0.2, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge)) * 0.6 * vAlpha;
  // Banks resting in the forest are thinner, and shaded green below the canopy.
  float low = smoothstep(-4.0, -12.0, vWorld.y);
  a *= 1.0 - low * 0.45;
  vec3 view = normalize(vWorld - cameraPosition);
  float toSun = pow(max(dot(view, uSunDir), 0.0), 4.0);
  vec3 col = vec3(0.9, 0.97, 0.96) * (SKY_LIGHT * 0.95 + SUN * (0.32 + 0.4 * vUv.y)) + HAZE_SUN * toSun * 0.6;
  col = mix(col, vec3(0.42, 0.62, 0.52), low * 0.6);
  gl_FragColor = vec4(col * a, a);
}
`;

export function Mist() {
  const geometry = useDisposable(() => {
    const rand = makeRandom(57);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const centres: number[] = [];
    const params: number[] = [];
    const spray = (x: number, y: number, z: number, n: number, spread: number, size: number) => {
      for (let i = 0; i < n; i++) {
        centres.push(x + rand.range(-1, 1) * spread, y + rand.range(-0.4, 0.6), z + rand.range(-1, 1) * spread);
        params.push(size * rand.range(0.7, 1.3), rand.range(1.5, 4), rand.next(), rand.range(0.06, 0.12));
      }
    };
    spray(FALL.x + FALL.reach + 0.3, POOL.y, FALL.z, 14, 1.6, 3.2);
    spray(LOWER_FALL.x, FLOOR_Y + 0.5, LOWER_FALL.z - 4, 16, 2.6, 6);
    // Banks of mist resting low over the forest, drifting.
    for (let i = 0; i < 22; i++) {
      const a = rand.range(0, Math.PI * 2);
      const r = rand.range(24, 54);
      centres.push(Math.sin(a) * r, rand.range(-13, -7), Math.cos(a) * r);
      params.push(rand.range(12, 20), 0, rand.next(), -1);
    }
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(centres), 3));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(new Float32Array(params), 4));
    g.instanceCount = centres.length / 3;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    uniforms: { ...fx },
    vertexShader: mistVertex,
    fragmentShader: mistFragment,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={25} />;
}
