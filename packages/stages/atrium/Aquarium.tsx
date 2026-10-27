import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { makeRandom } from '../shared/random.ts';
import { instanced, sweepArc } from './geometry.ts';
import { AXIS, LAYOUT_GLSL, TANK_R, TANK_TOP, WATER_Y } from './layout.ts';
import { COMMON, WORLD_VERTEX } from './shading.ts';
import type { AtriumUniforms } from './shading.ts';

// The aquarium column: a glass cylinder of sunlit water rising from the pool to the dome, with
// tropical fish circling inside and bubbles streaming up.

const BOTTOM = WATER_Y + 0.9;
const TOP = TANK_TOP - 1.3;

/**
 * Water seen through the column: drawn on its far wall, shaded by how much water the view
 * crosses (deep blue through the middle, bright aqua at the rims), lit from the top, with
 * caustics rippling over the far glass and swaying weed at the foot.
 */
const waterFragment = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 w = vWorld;
  vec3 dir = normalize(w - cameraPosition);
  // Where the view entered the column: the near root of the ray-cylinder test.
  vec2 o = cameraPosition.xz - AXIS.xz;
  vec2 d = dir.xz;
  float a = dot(d, d), b = 2.0 * dot(o, d), c = dot(o, o) - TANK_R * TANK_R;
  float disc = max(b * b - 4.0 * a * c, 0.0);
  float tNear = (-b - sqrt(disc)) / (2.0 * a);
  float thick = length(w - (cameraPosition + dir * tNear));
  float h = clamp((w.y - ${BOTTOM.toFixed(2)}) / ${(TOP - BOTTOM).toFixed(2)}, 0.0, 1.0);
  vec3 shallow = mix(vec3(0.0, 0.55, 0.8), vec3(0.35, 0.95, 1.0), h);
  vec3 deep = mix(vec3(0.0, 0.1, 0.38), vec3(0.0, 0.32, 0.7), h);
  vec3 col = mix(shallow, deep, 1.0 - exp(-thick * 0.75));
  // Caustics on the far glass, drifting down the column.
  float ang = atan(w.x - AXIS.x, w.z - AXIS.z) * TANK_R;
  vec2 p = vec2(ang, w.y) * 0.8;
  float ca = snoise(p + vec2(0.07, 0.24) * uTime) + 0.4 * snoise(p * 2.1 + 4.0 + vec2(-0.11, 0.31) * uTime);
  float caustic = pow(max(1.0 - abs(ca), 0.0), 6.0);
  col += vec3(0.6, 1.0, 1.0) * caustic * (0.12 + 0.3 * h);
  // Sun streaming down from the top of the column.
  col += vec3(0.6, 0.95, 1.0) * smoothstep(0.55, 1.0, h) * 0.5;
  // Weed and coral at the foot.
  // Pale sand and rounded stones at the foot.
  float fy = w.y - ${BOTTOM.toFixed(2)};
  float stones = 0.35 + 0.25 * sin(ang * 3.1 + 1.0) + 0.15 * sin(ang * 7.3);
  float bed = smoothstep(0.06, 0.0, fy - stones);
  vec3 stone = mix(vec3(0.05, 0.25, 0.3), vec3(0.3, 0.55, 0.5), smoothstep(-0.35, 0.0, fy - stones));
  col = mix(col, stone * (0.8 + 0.6 * caustic), bed);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** The near glass: barely tinted, bright at the rims, with two soft vertical highlights. */
const glassFragment = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float facing = max(dot(n, v), 0.0);
  float rim = pow(1.0 - facing, 3.0);
  // Highlights fixed to the view, like a lit glass tube: across the column, -1 left to 1 right.
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), v));
  float x = dot(n, side);
  float streak = exp(-pow((x - 0.5) * 5.5, 2.0)) * 0.7 + exp(-pow((x + 0.66) * 9.0, 2.0)) * 0.35;
  vec3 col = vec3(0.6, 0.95, 1.0) * rim * 0.8 + vec3(1.0) * streak;
  float alpha = clamp(0.06 + rim * 0.5 + streak * 0.5, 0.0, 1.0);
  gl_FragColor = vec4(haze(col, vWorld) * alpha, alpha);
}
`;

/** A small fish along +z, nose forward. aU: 0 at the nose to 1 at the tail tip. */
function fishGeometry(): THREE.BufferGeometry {
  const rings = 9;
  const segs = 8;
  const positions: number[] = [];
  const us: number[] = [];
  const indices: number[] = [];
  const profile = (u: number) => (u < 0.3 ? Math.sqrt(Math.max(0, 1 - ((0.3 - u) / 0.3) ** 2)) : 1 - 0.82 * THREE.MathUtils.smoothstep(u, 0.3, 1));
  for (let i = 0; i <= rings; i++) {
    const u = i / rings;
    const p = profile(u);
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      positions.push(Math.cos(a) * 0.07 * p, Math.sin(a) * 0.2 * p, 0.5 - u * 0.8);
      us.push(u * 0.8);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      indices.push(a, a + segs + 1, a + 1, a + 1, a + segs + 1, a + segs + 2);
    }
  }
  const vert = (y: number, z: number, u: number) => {
    positions.push(0, y, z);
    us.push(u);
    return positions.length / 3 - 1;
  };
  // Forked tail.
  const t0 = vert(0.04, -0.28, 0.8);
  const t1 = vert(-0.04, -0.28, 0.8);
  const t2 = vert(0.2, -0.5, 1);
  const t3 = vert(0, -0.4, 0.92);
  const t4 = vert(-0.2, -0.5, 1);
  indices.push(t0, t2, t3, t0, t3, t1, t1, t3, t4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Body, accent and pattern (0 plain, 1 bands, 2 stripe).
const SPECIES = [
  { body: '#ffc61a', accent: '#fff4a8', pattern: 0, size: 1.0, weight: 3 },
  { body: '#2a63ff', accent: '#ffd21a', pattern: 2, size: 1.1, weight: 3 },
  { body: '#ff6a12', accent: '#ffffff', pattern: 1, size: 0.75, weight: 3 },
  { body: '#1ad8ff', accent: '#ff4fbf', pattern: 2, size: 0.6, weight: 4 },
  { body: '#f2f8ff', accent: '#ffb020', pattern: 1, size: 1.15, weight: 2 },
] as const;

const fishVertex = /* glsl */ `
attribute float aU;
attribute vec4 aSwim;
attribute vec4 aLook;
attribute vec3 aBody;
attribute vec3 aAccent;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vBody;
varying vec3 vAccent;
varying float vU;
varying float vPattern;
varying float vSide;
void main() {
  // aSwim: orbit radius, height, angular speed (signed), phase. aLook: size, pattern, axis x, axis z.
  float theta = aSwim.w + uTime * aSwim.z;
  float y = aSwim.y + sin(uTime * 0.3 + aSwim.w * 3.0) * 0.6;
  vec3 radial = vec3(sin(theta), 0.0, cos(theta));
  vec3 fwd = vec3(cos(theta), 0.0, -sin(theta)) * sign(aSwim.z);
  vec3 p = position * aLook.x;
  // Swim: the tail beats harder than the head.
  float beat = sin(uTime * 9.0 * abs(aSwim.z) / 0.35 + aSwim.w * 7.0 - aU * 4.0);
  p.x += beat * aU * aU * 0.12 * aLook.x;
  vec3 side = cross(vec3(0.0, 1.0, 0.0), fwd);
  vec3 w = vec3(aLook.z, 0.0, aLook.w) + radial * aSwim.x + vec3(0.0, y, 0.0) + side * p.x + vec3(0.0, p.y, 0.0) + fwd * p.z;
  vNormal = normalize(side * normal.x + vec3(0.0, normal.y, 0.0) + fwd * normal.z);
  vWorld = w;
  vBody = aBody;
  vAccent = aAccent;
  vU = aU;
  vPattern = aLook.y;
  vSide = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const fishFragment = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vBody;
varying vec3 vAccent;
varying float vU;
varying float vPattern;
varying float vSide;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 col = vBody;
  if (vPattern > 1.5) col = mix(col, vAccent, smoothstep(0.02, 0.0, abs(vSide - 0.03)) + step(0.82, vU));
  else if (vPattern > 0.5) col = mix(col, vAccent, step(0.7, sin(vU * 22.0)));
  col *= 0.75 + 0.35 * smoothstep(-0.15, 0.15, vSide);
  // Lit from the water above, glossy, sunk a little into the water's colour.
  float light = 0.55 + 0.6 * max(n.y, 0.0) + 0.25 * max(dot(n, v), 0.0);
  col *= light;
  col += vec3(0.9, 1.0, 1.0) * pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.35;
  col += vec3(1.0) * pow(max(dot(reflect(-v, n), normalize(vec3(0.3, 1.0, 0.4))), 0.0), 24.0) * 0.8;
  col = mix(col, vec3(0.1, 0.6, 0.8), 0.22);
  gl_FragColor = vec4(col, 1.0);
}
`;

function useFish(count: number) {
  return useDisposable(() => {
    const rand = makeRandom(4242);
    const swim = new Float32Array(count * 4);
    const look = new Float32Array(count * 4);
    const body = new Float32Array(count * 3);
    const accent = new Float32Array(count * 3);
    const total = SPECIES.reduce((s, sp) => s + sp.weight, 0);
    const color = new THREE.Color();
    for (let i = 0; i < count; ) {
      let pick = rand.next() * total;
      const sp = SPECIES.find((s) => (pick -= s.weight) < 0) ?? SPECIES[0];
      // Small schools share a species, a direction and roughly a height.
      const n = Math.min(count - i, sp.size < 0.8 ? rand.int(3, 6) : rand.int(1, 2));
      const dir = rand.sign();
      const height = rand.range(BOTTOM + 1, TOP - 4);
      const speed = rand.range(0.18, 0.32) * dir;
      const phase = rand.range(0, Math.PI * 2);
      for (let j = 0; j < n; j++, i++) {
        swim.set([rand.range(0.45, TANK_R - 0.3), height + rand.range(-0.5, 0.5), speed * rand.range(0.95, 1.05), phase + rand.range(-0.3, 0.3)], i * 4);
        look.set([1.45 * sp.size * rand.range(0.85, 1.1), sp.pattern, AXIS.x, AXIS.z], i * 4);
        color.set(sp.body).toArray(body, i * 3);
        color.set(sp.accent).toArray(accent, i * 3);
      }
    }
    return instanced(fishGeometry(), count, { aSwim: [4, swim], aLook: [4, look], aBody: [3, body], aAccent: [3, accent] });
  });
}

const bubbleVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
varying float vFade;
${LAYOUT_GLSL}
const float BOTTOM = ${BOTTOM.toFixed(2)};
const float SPAN = ${(TOP - BOTTOM - 0.5).toFixed(2)};
void main() {
  // aSeed: angle, radius, speed, phase. Rising, wobbling, wrapping at the top (out of sight).
  float rise = fract(aSeed.w + uTime * aSeed.z / SPAN);
  float y = BOTTOM + rise * SPAN;
  float ang = aSeed.x + sin(uTime * 1.7 + aSeed.w * 30.0) * 0.12;
  float r = aSeed.y + sin(uTime * 2.3 + aSeed.w * 17.0) * 0.06;
  vec3 w = AXIS + position + vec3(sin(ang) * r, y, cos(ang) * r);
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (0.07 + 0.08 * fract(aSeed.w * 13.7)) * (0.7 + 0.6 * rise);
  gl_PointSize = max(size * uScale / -mv.z, 1.5);
  vFade = smoothstep(0.0, 0.04, rise) * smoothstep(1.0, 0.9, rise);
}
`;

const bubbleFragment = /* glsl */ `
varying float vFade;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float ring = smoothstep(1.0, 0.8, r) * (0.25 + 0.75 * smoothstep(0.4, 0.95, r));
  float hl = smoothstep(0.38, 0.05, length(d - vec2(-0.17, -0.17)));
  float a = (ring * 0.7 + hl) * vFade;
  gl_FragColor = vec4(vec3(0.85, 1.0, 1.0) * a, a);
}
`;

export function Aquarium({ uniforms }: { uniforms: AtriumUniforms }) {
  const tube = useDisposable(() => sweepArc([[TANK_R, BOTTOM - 0.1], [TANK_R, TOP + 0.1]], 0, Math.PI * 2, 48));
  const fish = useFish(46);
  const bubbles = useDisposable(() => {
    const rand = makeRandom(77);
    const seeds: number[] = [];
    // A few streams from the floor of the tank plus loose bubbles.
    for (let s = 0; s < 5; s++) {
      const ang = rand.range(0, Math.PI * 2);
      const r = rand.range(0.3, TANK_R - 0.3);
      const speed = rand.range(1.0, 1.4);
      for (let b = 0; b < 26; b++) seeds.push(ang + rand.range(-0.05, 0.05), r, speed * rand.range(0.9, 1.1), rand.next());
    }
    for (let b = 0; b < 50; b++) seeds.push(rand.range(0, Math.PI * 2), rand.range(0.2, TANK_R - 0.15), rand.range(0.6, 1.2), rand.next());
    const g = new THREE.BufferGeometry();
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((seeds.length / 4) * 3), 3));
    return g;
  });
  const mats = useDisposable(() => ({
    water: shaderMaterial({ uniforms: { ...uniforms }, side: THREE.BackSide, vertexShader: WORLD_VERTEX, fragmentShader: waterFragment }),
    glass: shaderMaterial({
      uniforms: { ...uniforms },
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      vertexShader: WORLD_VERTEX,
      fragmentShader: glassFragment,
    }),
    fish: shaderMaterial({ uniforms: { ...uniforms }, side: THREE.DoubleSide, vertexShader: fishVertex, fragmentShader: fishFragment }),
    bubble: shaderMaterial({
      uniforms: { uTime: uniforms.uTime, uScale: uniforms.uPointScale },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: bubbleVertex,
      fragmentShader: bubbleFragment,
    }),
  }), [uniforms]);
  return (
    <group>
      {/* The fish before the water behind them; both early among the opaque, in front of the room. */}
      <mesh geometry={fish} material={mats.fish} frustumCulled={false} renderOrder={-16} />
      <mesh geometry={tube} material={mats.water} renderOrder={-15} />
      <points geometry={bubbles} material={mats.bubble} frustumCulled={false} renderOrder={6} />
      <mesh geometry={tube} material={mats.glass} renderOrder={7} />
    </group>
  );
}
