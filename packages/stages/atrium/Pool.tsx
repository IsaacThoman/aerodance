import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { makeRandom } from '../shared/random.ts';
import { instanced } from './geometry.ts';
import { AXIS, POOL_R, TANK_R, WATER_Y } from './layout.ts';
import { AA, COMMON, WORLD_VERTEX } from './shading.ts';
import type { AtriumUniforms } from './shading.ts';

// The round reflecting pool at the column's foot, with a few koi gliding round in it. Rather than
// render the room twice, its reflection is traced against the few big shapes that matter: the
// aquarium column, the ring of balconies (or the glass wall), and the dome overhead.

/** The water's surface, shared by the pool and the koi seen through it. */
const WATER = /* glsl */ `
${COMMON}
${AA}

vec3 tankColor(float y) {
  float h = clamp((y - 1.0) / (TANK_TOP - 2.0), 0.0, 1.0);
  return mix(vec3(0.02, 0.4, 0.7), vec3(0.3, 0.9, 1.0), h) * 1.1;
}

// The balconies seen from the pool: white fascias, hanging green, shaded shop fronts.
vec3 tierColor(float y, float ang) {
  vec3 col = vec3(0.45, 0.55, 0.62);
  for (int i = 0; i < 3; i++) {
    float L = LEVELS[i];
    float fascia = smoothstep(L - 0.95, L - 0.8, y) * smoothstep(L + 0.85, L + 0.7, y);
    float hang = 1.0 + 1.6 * (sin(ang * 23.0 + L) * 0.5 + 0.5);
    float green = smoothstep(L - 0.8 - hang - 0.3, L - 0.8 - hang, y) * step(y, L - 0.8) + smoothstep(L + 0.6, L + 0.8, y) * step(y, L + 1.2);
    col = mix(col, vec3(0.1, 0.3, 0.18), clamp(green, 0.0, 1.0));
    col = mix(col, vec3(0.85, 0.88, 0.92), fascia);
  }
  return col;
}

vec3 reflection(vec3 w, vec3 R) {
  vec2 o = w.xz - AXIS.xz;
  vec2 d = R.xz;
  float a = max(dot(d, d), 1e-5);
  float b = 2.0 * dot(o, d);
  // The column.
  float c = dot(o, o) - TANK_R * TANK_R;
  float disc = b * b - 4.0 * a * c;
  if (disc > 0.0) {
    float t = (-b - sqrt(disc)) / (2.0 * a);
    float y = w.y + R.y * t;
    if (t > 0.0 && y < TANK_TOP) {
      vec2 hit = o + d * t;
      float edge = abs(dot(normalize(hit), normalize(vec2(-d.y, d.x))));
      return mix(tankColor(y), vec3(0.8, 1.0, 1.0), pow(edge, 6.0) * 0.6);
    }
  }
  // The ring of balconies round the void, from inside.
  c = dot(o, o) - VOID_R * VOID_R;
  disc = max(b * b - 4.0 * a * c, 0.0);
  float t = (-b + sqrt(disc)) / (2.0 * a);
  float y = w.y + R.y * t;
  vec2 hit = o + d * t;
  float ang = atan(hit.x, hit.y);
  float glass = smoothstep(GLASS_THETA.x, GLASS_THETA.x + 0.15, ang) * smoothstep(GLASS_THETA.y, GLASS_THETA.y - 0.15, ang);
  vec3 sky = mix(vec3(0.7, 0.88, 1.0), vec3(0.3, 0.62, 1.0), clamp(R.y * 1.4, 0.0, 1.0));
  vec3 ring = mix(tierColor(y, ang), mix(vec3(0.2, 0.45, 0.25), sky, smoothstep(1.5, 3.5, y)), glass);
  // The dome: sky between white ribs.
  float tr = (ROOF_Y + 3.0 - w.y) / max(R.y, 1e-3);
  vec2 q = w.xz + R.xz * tr;
  float rib = 1.0 - smoothstep(0.15, 0.5, domeRibDist(q));
  vec3 dome = mix(sky * 1.15, vec3(0.92, 0.95, 1.0), rib * 0.85);
  return mix(ring, dome, smoothstep(ROOF_Y - 1.5, ROOF_Y + 0.5, y));
}

// Caustics on what's under the water at xz.
float caustics(vec2 xz) {
  vec2 cp = xz * 1.1;
  float ca = snoise(cp + vec2(0.21, 0.13) * uTime) + 0.5 * snoise(cp * 2.0 + 3.0 - vec2(0.17, -0.23) * uTime);
  return pow(max(1.0 - abs(ca), 0.0), 4.0);
}

// What the surface at w shows from the camera: \`under\`, the water's floor or a fish below it,
// mixed with the room's reflection (at least \`mirror\` of it), and glints where ripples catch the sun.
vec3 throughWater(vec3 under, vec3 w, vec3 v, float mirror) {
  vec2 rel = w.xz - AXIS.xz;
  float r = length(rel);
  // Rings spreading from the column's foot and a slow breeze, faded out where they'd shimmer.
  float px = length(fwidth(w.xz));
  float detail = 1.0 - smoothstep(0.05, 0.22, px);
  vec2 g = normalize(rel) * cos(r * 3.6 - uTime * 1.5) * 0.05 * exp(-(r - TANK_R) * 0.3);
  g += vec2(0.8, 0.6) * cos(dot(w.xz, vec2(0.8, 0.6)) * 2.2 + uTime * 0.9) * 0.035;
  g += vec2(-0.5, 0.86) * cos(dot(w.xz, vec2(-0.5, 0.86)) * 3.1 - uTime * 0.7) * 0.03;
  g *= detail;
  // Cheap swell: two 2D noise fields drifting different ways rather than one evolving in 3D.
  g += vec2(snoise(w.xz * 0.7 + vec2(0.13, 0.07) * uTime), snoise(w.xz * 0.7 + 7.0 - vec2(0.09, -0.11) * uTime)) * 0.05;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 R = reflect(-v, n);
  vec3 refl = reflection(w, R);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 col = mix(under, refl * vec3(0.5, 0.72, 0.9), clamp(fres + mirror, 0.0, 0.75));
  float sun = sunLight(vec3(w.x, 0.0, w.z));
  col += SUN * pow(max(dot(R, normalize(uSunDir)), 0.0), 400.0) * sun * 1.5;
  return haze(col, w);
}
`;

const poolFragment = /* glsl */ `
${WATER}
varying vec3 vWorld;

void main() {
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  // The pool floor: a dark one makes a better mirror. Deep teal, caustics where the sun reaches it.
  float sun = sunLight(vec3(w.x, 0.0, w.z));
  vec3 bottom = vec3(0.01, 0.16, 0.3) * (0.6 + 0.5 * sun) + vec3(0.3, 0.8, 0.95) * caustics(w.xz) * (0.05 + 0.25 * sun);
  gl_FragColor = vec4(throughWater(bottom, w, v, 0.25), 1.0);
}
`;

/**
 * A koi along +z, nose forward, one long, seen mostly from above: a body wider than it's deep, a
 * fan tail and two pectoral fins lying flat. aU: 0 at the nose to 1 at the tail's tip.
 */
function koiGeometry(): THREE.BufferGeometry {
  const RINGS = 12;
  const SEGS = 10;
  const NOSE = 0.5;
  const ROOT = -0.24;
  const width = (u: number) => 0.12 * Math.sin(Math.min(u / 0.3, 1) * Math.PI * 0.5) ** 0.5 * (1 - 0.72 * THREE.MathUtils.smoothstep(u, 0.3, 1));
  const positions: number[] = [];
  const us: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS;
    const w = width(u);
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2;
      positions.push(Math.cos(a) * w, Math.sin(a) * w * 0.7, NOSE - u * (NOSE - ROOT));
      us.push(u * 0.74);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j;
      indices.push(a, a + SEGS + 1, a + 1, a + 1, a + SEGS + 1, a + SEGS + 2);
    }
  }
  const vert = (x: number, z: number, u: number) => {
    positions.push(x, 0, z);
    us.push(u);
    return positions.length / 3 - 1;
  };
  // A fan tail, notched in the middle.
  const root = vert(0, ROOT + 0.02, 0.74);
  const fan = [-1, -0.5, 0, 0.5, 1].map((s) => vert(s * 0.16, ROOT - 0.24 + Math.abs(s) * 0.02 + (s === 0 ? 0.07 : 0), 1));
  for (let k = 0; k < fan.length - 1; k++) indices.push(root, fan[k], fan[k + 1]);
  // Pectoral fins behind the head.
  for (const side of [-1, 1]) {
    const a = vert(side * 0.08, 0.3, 0.3);
    const b = vert(side * 0.2, 0.18, 0.42);
    const c = vert(side * 0.07, 0.16, 0.42);
    indices.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/**
 * Each koi glides a lazy loop round the column (aPath: angle, angular speed, radius, radius
 * wobble) a little under the surface (aKoi: length, depth, variant), worked out in the shader
 * from the clock. It's drawn at the water's surface on its own line of sight: the pool writes its
 * depth, which would hide it, while the rim in front still does.
 */
const koiVertex = /* glsl */ `
${COMMON}
attribute float aU;
attribute vec4 aPath;
attribute vec3 aKoi;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying float vVariant;

vec3 koiAt(float t) {
  float theta = aPath.x + aPath.y * t + 0.4 * sin(t * 0.09 + aPath.x * 3.0);
  float r = aPath.z + aPath.w * sin(t * 0.07 + aPath.x * 5.0);
  return vec3(AXIS.x + sin(theta) * r, WATER_Y - aKoi.y, AXIS.z + cos(theta) * r);
}

void main() {
  vec3 d = koiAt(uTime + 0.2) - koiAt(uTime - 0.2);
  vec3 fwd = normalize(vec3(d.x, 0.0, d.z));
  vec3 side = vec3(fwd.z, 0.0, -fwd.x);
  float len = aKoi.x;
  vec3 p = position * len;
  // A slow wave down the body to the tail.
  p.x += sin(uTime * 3.4 + aPath.x * 9.0 - aU * 5.0) * aU * aU * 0.1 * len;
  vec3 w = koiAt(uTime) + side * p.x + vec3(0.0, p.y, 0.0) + fwd * p.z;
  vWorld = w;
  vNormal = side * normal.x + vec3(0.0, normal.y, 0.0) + fwd * normal.z;
  vLocal = position;
  vVariant = aKoi.z;
  vec3 eye = cameraPosition;
  vec3 drawn = w;
  if (eye.y > WATER_Y + 0.02) {
    // Its top a few millimetres nearer than its belly, so it still hides itself properly.
    float h = WATER_Y + 0.004 + (w.y - WATER_Y + 0.3) * 0.02;
    drawn = eye + (w - eye) * ((h - eye.y) / (w.y - eye.y));
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(drawn, 1.0);
}
`;

const koiFragment = /* glsl */ `
${WATER}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying float vVariant;

const vec3 WHITE = vec3(0.86, 0.84, 0.8);
const vec3 RED = vec3(0.85, 0.08, 0.02);
const vec3 ORANGE = vec3(1.0, 0.36, 0.04);
const vec3 GOLD = vec3(1.0, 0.62, 0.1);

void main() {
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  // Patterns laid out from above: kohaku (red on white), tancho (a red crown), orange, gold.
  vec2 pc = vec2(vLocal.z * 3.2, vLocal.x * 5.0) + vVariant * 13.7;
  float blot = snoise(pc) * 0.65 + snoise(pc * 2.3 + 5.0) * 0.3;
  vec3 base = WHITE;
  if (vVariant < 0.5) base = mix(WHITE, RED, smoothstep(0.02, 0.14, blot + 0.3 * smoothstep(0.15, 0.4, vLocal.z)));
  else if (vVariant < 1.5) base = mix(WHITE, RED, 1.0 - smoothstep(0.05, 0.07, length(vec2(vLocal.z - 0.33, vLocal.x * 1.2))));
  else if (vVariant < 2.5) base = ORANGE;
  else base = GOLD;
  // Translucent fins, paler at their edges.
  if (vLocal.z < -0.25 || abs(vLocal.x) > 0.075) base = mix(base, WHITE, 0.45);
  // Lit through the water: the sun (with the dome's and the column's shadows) and caustics.
  float sun = sunLight(vec3(w.x, 0.0, w.z));
  vec3 col = base * (0.35 + 0.65 * max(n.y, 0.0) * (0.45 + 0.55 * sun));
  col += vec3(0.4, 0.9, 1.0) * caustics(w.xz) * 0.2 * sun;
  // The water over it, the deeper the bluer. Just under the surface, they show through the
  // reflection a little more clearly than the pool's floor does.
  float depth = (WATER_Y - w.y) / max(v.y, 0.2);
  col = mix(col, vec3(0.01, 0.16, 0.3), 1.0 - exp(-depth * 2.0));
  vec3 s = w + v * ((WATER_Y - w.y) / max(v.y, 0.05));
  gl_FragColor = vec4(throughWater(col, s, v, 0.1), 1.0);
}
`;

// Room to swim between the column's collar and the pool's wall, for the longest koi.
const KOI_INNER = TANK_R + 1.0;
const KOI_OUTER = POOL_R - 0.6;
const KOI_COUNT = 9;

function useKoi() {
  return useDisposable(() => {
    const rand = makeRandom(1717);
    const path: number[] = [];
    const koi: number[] = [];
    for (let i = 0; i < KOI_COUNT; i++) {
      const radius = rand.range(KOI_INNER + 0.5, KOI_OUTER - 0.5);
      const wobble = Math.min(rand.range(0.3, 0.9), radius - KOI_INNER, KOI_OUTER - radius);
      // A lazy 0.15-0.3 m/s, some each way round.
      path.push(rand.range(0, Math.PI * 2), rand.sign() * rand.range(0.15, 0.3) / radius, radius, wobble);
      koi.push(rand.range(0.75, 1.0), rand.range(0.11, 0.15), i % 4);
    }
    return instanced(koiGeometry(), KOI_COUNT, { aPath: [4, new Float32Array(path)], aKoi: [3, new Float32Array(koi)] });
  });
}

export function Pool({ uniforms }: { uniforms: AtriumUniforms }) {
  const geometry = useDisposable(() => new THREE.CircleGeometry(POOL_R + 0.05, 96).rotateX(-Math.PI / 2).translate(AXIS.x, WATER_Y, AXIS.z));
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...uniforms }, vertexShader: WORLD_VERTEX, fragmentShader: poolFragment }), [uniforms]);
  const koi = useKoi();
  const koiMaterial = useDisposable(() => shaderMaterial({ uniforms: { ...uniforms }, side: THREE.DoubleSide, vertexShader: koiVertex, fragmentShader: koiFragment }), [uniforms]);
  return (
    <>
      <mesh geometry={geometry} material={material} renderOrder={-14} />
      {/* After the pool, over which they're drawn. */}
      <mesh geometry={koi} material={koiMaterial} frustumCulled={false} renderOrder={-13} />
    </>
  );
}
