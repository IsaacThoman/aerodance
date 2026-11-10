import { useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { useArenaFrame } from '../shared/frame.ts';
import { DOME, SUN_DIR } from './layout.ts';
import { LIGHT, fx, instanced, merge } from './shading.ts';

// Light and life: sunbeams slanting down through the dome's cushions into the humid air, motes
// of pollen glittering in them, blue morphos and yellow swallowtails fluttering round the deck
// and the pool, and two hummingbirds working the orchids.

// ------------------------------------------------------------------ sunbeams

/** Where each beam comes down to: x, y, z, width, strength. */
const BEAMS: readonly (readonly [number, number, number, number, number])[] = [
  [-10.5, -0.5, -2, 2.2, 1.0],
  [2, -1, -11, 1.8, 0.9],
  [-1.5, 0, 1.2, 1.3, 0.45],
  [-6, -6, -16, 2.8, 0.9],
  [8, -7, -18, 3.4, 0.85],
  [-16, -4, -14, 2.8, 0.8],
  [16, -8, -8, 3.4, 0.75],
  [-20, -2, 6, 3, 0.75],
  [3, -8, 16, 3, 0.7],
  [14, -8, 14, 3.4, 0.7],
  [-12, -8, 18, 3.8, 0.65],
  [24, -8, -24, 4.4, 0.7],
  [-4, -8, -30, 4.4, 0.7],
  [28, -8, 4, 4, 0.6],
  [-28, -6, -8, 4, 0.6],
  [-24, -6, -30, 4.2, 0.55],
];

/** Back up the sunlight from (x, y, z) to where it came through the dome. */
function domeEntry(x: number, y: number, z: number): THREE.Vector3 {
  const p = new THREE.Vector3(x, y, z).sub(DOME.center);
  const d = SUN_DIR;
  // |p + t d| = R: t = -p.d + sqrt((p.d)^2 - (p.p - R^2)).
  const b = p.dot(d);
  const t = -b + Math.sqrt(Math.max(0, b * b - (p.lengthSq() - DOME.radius * DOME.radius)));
  return new THREE.Vector3(x, y, z).addScaledVector(d, t);
}

const shaftVertex = /* glsl */ `
attribute vec3 aTop;
attribute vec4 aBeam;
uniform float uTime;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
void main() {
  // aBeam: length, width, strength, seed.
  vec3 dir = -normalize(uSunDirV);
  float along = 0.5 - position.y;
  vec3 mid = aTop + dir * aBeam.x * 0.5;
  vec3 toCam = cameraPosition - mid;
  vec3 side = normalize(cross(dir, toCam) + vec3(1e-4, 0.0, 1e-4));
  float w = aBeam.y * (1.0 + along * 0.4);
  vec3 wp = aTop + dir * along * aBeam.x + side * position.x * w;
  vUv = vec2(position.x + 0.5, along);
  vSeed = aBeam.w;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  // Fade close up, so no beam fills the view, and edge-on.
  vec3 view = normalize(wp - cameraPosition);
  vFade = aBeam.z * smoothstep(2.5, 9.0, -mv.z) * (1.0 - pow(abs(dot(view, dir)), 6.0) * 0.6);
  gl_Position = projectionMatrix * mv;
}
`;

const shaftFragment = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying float vFade;
varying float vSeed;
void main() {
  float across = sin(3.14159 * vUv.x);
  across = across * across * (0.6 + 0.4 * across * across);
  float along = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
  float breathe = 0.65 + 0.35 * sin(uTime * (0.13 + vSeed * 0.05) + vSeed * 17.0);
  float streak = 0.7 + 0.3 * sin(vUv.x * 9.0 + uTime * 0.2 + vSeed * 31.0);
  float a = across * along * breathe * streak * vFade * uIntensity;
  gl_FragColor = vec4(vec3(1.0, 0.8, 0.48) * a, 1.0);
}
`;

export function Shafts({ intensity = 0.6 }: { intensity?: number }) {
  const geometry = useDisposable(() => {
    const tops = new Float32Array(BEAMS.length * 3);
    const data = new Float32Array(BEAMS.length * 4);
    BEAMS.forEach(([x, y, z, w, s], i) => {
      const top = domeEntry(x, y, z);
      tops.set(top.toArray(), i * 3);
      data.set([top.distanceTo(new THREE.Vector3(x, y, z)) + 6, w, s, i * 0.37 + 0.1], i * 4);
    });
    const g = instanced(new THREE.PlaneGeometry(1, 1, 1, 10), BEAMS.length, { aTop: [3, tops], aBeam: [4, data] });
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    uniforms: { uTime: fx.uTime, uSunDirV: fx.uSunDir, uIntensity: { value: intensity } },
    vertexShader: `uniform vec3 uSunDirV;\n${shaftVertex}`,
    fragmentShader: shaftFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));
  material.uniforms.uIntensity.value = intensity;
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={40} />;
}

// ------------------------------------------------------------------ motes

const moteVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
varying float vGlow;
void main() {
  float t = uTime * (0.5 + aSeed.w * 0.5);
  vec3 p = position + vec3(sin(t * 0.21 + aSeed.x * 6.0) * 1.1, sin(t * 0.13 + aSeed.y * 6.0) * 0.8, cos(t * 0.17 + aSeed.z * 6.0) * 1.1);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.5 + 0.5 * sin(uTime * (1.3 + aSeed.x * 2.0) + aSeed.y * 30.0);
  vGlow = (0.35 + 0.65 * twinkle) * smoothstep(0.8, 2.5, -mv.z) * (1.0 - smoothstep(18.0, 30.0, -mv.z));
  gl_PointSize = clamp((0.035 + 0.03 * aSeed.z) * uScale / -mv.z, 1.5, 6.0);
}
`;

const moteFragment = /* glsl */ `
varying float vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 16.0) * vGlow;
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.75) * a * 1.4, 1.0);
}
`;

export function Motes({ count = 520 }: { count?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(77);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = rand.range(0, Math.PI * 2);
      const r = Math.sqrt(rand.next()) * 20;
      pos.set([Math.sin(a) * r - 3, rand.range(-3, 7), Math.cos(a) * r], i * 3);
      seed.set([rand.next(), rand.next(), rand.next(), rand.next()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    return g;
  }, [count]);
  const material = useDisposable(() => shaderMaterial({
    // The 640x480 buffer's height over the view's height a metre away (50 degree fov).
    uniforms: { uTime: fx.uTime, uScale: { value: 480 / (2 * Math.tan(THREE.MathUtils.degToRad(25))) } },
    vertexShader: moteVertex,
    fragmentShader: moteFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={41} />;
}

// ------------------------------------------------------------------ butterflies

const butterflyVertex = /* glsl */ `
attribute vec4 aPath;
attribute vec4 aPath2;
uniform float uTime;
varying vec2 vUv;
varying float vKind;
varying vec3 vWorld;
varying vec3 vNormal;
vec3 pathAt(float t) {
  // A wandering loop round its home: centre aPath.xyz, radius aPath.w, its own rhythm.
  float s = aPath2.x;
  return aPath.xyz + vec3(
    sin(t * 0.31 * s + aPath2.y) * aPath.w + sin(t * 0.83 * s + aPath2.y * 2.0) * aPath.w * 0.3,
    sin(t * 0.57 * s + aPath2.y * 3.0) * 0.45 + sin(t * 1.9 * s) * 0.12,
    cos(t * 0.37 * s + aPath2.y) * aPath.w * 0.8 + cos(t * 0.71 * s + aPath2.y * 1.7) * aPath.w * 0.3
  );
}
void main() {
  float t = uTime;
  vec3 p = pathAt(t);
  vec3 ahead = pathAt(t + 0.15) - p;
  vec3 f = normalize(vec3(ahead.x, ahead.y * 0.4, ahead.z) + vec3(1e-4, 0.0, 0.0));
  vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f) + vec3(1e-4, 0.0, 1e-4));
  vec3 u = cross(f, r);
  // Wings: x across (-1..1, the body at 0), y along; they flap round the body's axis.
  float side = sign(position.x);
  float flap = sin(t * (14.0 + aPath2.z * 6.0) + aPath2.y * 10.0) * 0.75 + 0.35;
  float ang = flap * side;
  float sd = side == 0.0 ? 1.0 : side;
  vec3 wingDir = r * cos(ang) * sd + u * sin(abs(ang));
  vec3 wing = wingDir * abs(position.x);
  float size = aPath2.w;
  vec3 w = p + (wing + f * position.y) * size;
  vUv = vec2(position.x, position.y);
  vKind = aPath2.z;
  vWorld = w;
  vNormal = normalize(cross(f, wingDir));
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const butterflyFragment = /* glsl */ `
${LIGHT}
varying vec2 vUv;
varying float vKind;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  float x = abs(vUv.x);
  float y = vUv.y;
  // Forewing ahead, hindwing behind, a notch between.
  float fore = length(vec2((x - 0.5) / 0.55, (y - 0.15) / 0.45));
  float hind = length(vec2((x - 0.38) / 0.4, (y + 0.32) / 0.38));
  float body = step(x, 0.05) * step(abs(y), 0.42);
  if (min(fore, hind) > 1.0 && body < 0.5) discard;
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  vec3 col;
  float edge = smoothstep(0.7, 0.95, min(fore, hind));
  if (vKind < 0.5) {
    // Blue morpho: iridescent, cobalt to electric cyan with the angle, a black border.
    float irid = pow(1.0 - abs(dot(n, v)), 1.5);
    vec3 blue = mix(vec3(0.05, 0.35, 1.0), vec3(0.2, 0.95, 1.0), irid);
    col = mix(blue * 1.6, vec3(0.02, 0.03, 0.06), edge);
  } else {
    // Swallowtail: sunny yellow with black veins and border.
    float veins = smoothstep(0.85, 0.95, sin(atan(y, x + 1e-3) * 14.0));
    col = mix(vec3(1.0, 0.82, 0.12), vec3(0.03), max(edge, veins * 0.8));
    col = mix(col, vec3(1.0, 0.4, 0.1), smoothstep(0.6, 0.2, hind) * 0.4);
  }
  if (body > 0.5) col = vec3(0.04, 0.04, 0.05);
  col *= ambient(n) + SUN * (max(dot(n, uSunDir), 0.0) * 0.6 + 0.3);
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

/** Where the butterflies flit: centre, how far they roam. */
const FLIGHTS: readonly (readonly [number, number, number, number])[] = [
  [-4.2, 1.4, -5.6, 1.6], [3.8, 1.5, -5.8, 1.5], [-4.0, 1.4, 5.8, 1.4], [3.8, 1.3, 6.0, 1.3],
  [-7.5, 0.9, 3.5, 2.2], [-12, 0.8, -6, 2.6], [-9.5, 1.2, -1, 3.0], [-6.5, 1.0, -7.2, 1.8],
  [6.5, 1.2, 0, 2.4], [0, 2.4, 9.5, 2.5], [5, 1.6, 15.5, 3], [-2, 2.2, -9.5, 2.6],
  [-15, 3, 2.5, 2.4], [22.5, 2.2, 23, 3.2], [-1.5, 2.6, -1.5, 3.5], [-18.5, 9.5, -1, 2.4],
];

export function Butterflies() {
  const geometry = useDisposable(() => {
    const rand = makeRandom(303);
    const n = FLIGHTS.length * 2;
    const path = new Float32Array(n * 4);
    const path2 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const [x, y, z, r] = FLIGHTS[i % FLIGHTS.length];
      path.set([x + rand.range(-0.5, 0.5), y + rand.range(-0.3, 0.3), z + rand.range(-0.5, 0.5), r * rand.range(0.7, 1.1)], i * 4);
      // speed, phase, kind (0 morpho, 1 swallowtail), size
      const morpho = rand.chance(0.55);
      path2.set([rand.range(0.7, 1.2), rand.range(0, 30), morpho ? 0 : 1, morpho ? rand.range(0.07, 0.085) : rand.range(0.05, 0.065)], i * 4);
    }
    // Two wing quads (x -1..0 and 0..1), y along the body -0.5..0.5.
    const wings = new THREE.PlaneGeometry(2, 1, 2, 1);
    const g = instanced(wings, n, { aPath: [4, path], aPath2: [4, path2] });
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  });
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...fx }, vertexShader: butterflyVertex, fragmentShader: butterflyFragment, side: THREE.DoubleSide }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// ------------------------------------------------------------------ hummingbirds

/** Flowers each bird visits in turn: x, y, z (where its beak goes). */
const VISITS: readonly (readonly (readonly [number, number, number])[])[] = [
  [[-3.6, 1.02, -5.85], [-6.6, 0.25, -6.1], [-8.4, 0.25, 4.05], [-3.6, 1.02, 5.85], [-4.3, 1.4, -6.6]],
  [[3.6, 1.02, -5.85], [3.6, 1.02, 5.85], [3.6, 0.85, 6.0], [3.3, 1.2, -6.8]],
];
const HOVER = 2.6;
const DART = 0.9;

function Hummingbird({ visits, offset, body, throat }: { visits: readonly (readonly [number, number, number])[]; offset: number; body: string; throat: string }) {
  const group = useRef<THREE.Group>(null);
  const wings = useRef<THREE.Group[]>([]);
  const parts = useDisposable(() => {
    const paint = (g: THREE.BufferGeometry, color: string) => {
      const c = new THREE.Color(color);
      const n = g.attributes.position.count;
      const data = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) data.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(data, 3));
      return g;
    };
    return {
      bird: merge([
        paint(new THREE.SphereGeometry(0.035, 12, 8).scale(1, 0.9, 2.1), body),
        paint(new THREE.SphereGeometry(0.024, 10, 8).translate(0, 0.02, 0.06), body),
        paint(new THREE.SphereGeometry(0.021, 10, 8).translate(0, 0.006, 0.066), throat),
        paint(new THREE.ConeGeometry(0.004, 0.07, 6).rotateX(Math.PI / 2).translate(0, 0.018, 0.115), '#151a18'),
        paint(new THREE.ConeGeometry(0.02, 0.07, 4).scale(1.4, 0.3, 1).rotateX(-Math.PI / 2 - 0.3).translate(0, -0.01, -0.1), body),
      ]),
      wing: new THREE.PlaneGeometry(0.11, 0.03).translate(0.055, 0, 0),
      plumage: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.3, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.6 }),
      blur: new THREE.MeshBasicMaterial({ color: '#d8f0e6', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
    };
  }, [body, throat]);
  const at = useRef(new THREE.Vector3());
  const next = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  useArenaFrame((_state, _delta, time) => {
    const g = group.current;
    if (!g) return;
    const cycle = HOVER + DART;
    const t = time + offset;
    const k = Math.floor(t / cycle);
    const f = t - k * cycle;
    const a = visits[k % visits.length];
    const b = visits[(k + 1) % visits.length];
    // Hover at a flower, backed off a little and bobbing, then dart to the next.
    const hoverAt = (p: readonly [number, number, number], out: THREE.Vector3) => out.set(p[0] + 0.1, p[1] + 0.02, p[2] + 0.1);
    hoverAt(a, at.current);
    hoverAt(b, next.current);
    if (f < HOVER) {
      g.position.copy(at.current);
      g.position.y += Math.sin(t * 5.3) * 0.015;
      g.position.x += Math.sin(t * 2.1) * 0.02;
      look.current.set(a[0], a[1], a[2]);
    } else {
      const s = (f - HOVER) / DART;
      const e = s * s * (3 - 2 * s);
      g.position.lerpVectors(at.current, next.current, e);
      g.position.y += Math.sin(e * Math.PI) * 0.6;
      look.current.copy(next.current).sub(at.current).add(g.position);
    }
    g.lookAt(look.current);
    const beat = Math.sin(time * 70) * 0.9;
    wings.current.forEach((w, i) => { if (w) w.rotation.z = (i === 0 ? 1 : -1) * beat; });
  });
  return (
    <group ref={group}>
      <mesh geometry={parts.bird} material={parts.plumage} />
      {[0, 1].map((i) => (
        <group key={i} ref={(el) => { if (el) wings.current[i] = el; }} position={[0, 0.02, 0.01]} scale={[i === 0 ? 1 : -1, 1, 1]}>
          <mesh geometry={parts.wing} material={parts.blur} />
        </group>
      ))}
    </group>
  );
}

export function Hummingbirds() {
  return (
    <>
      <Hummingbird visits={VISITS[0]} offset={0} body="#12b07a" throat="#ff2e7a" />
      <Hummingbird visits={VISITS[1]} offset={1.7} body="#1fa3c9" throat="#a43cff" />
    </>
  );
}


// ------------------------------------------------------------------ birds

const birdVertex = /* glsl */ `
attribute vec4 aLoop;
attribute vec4 aLoop2;
uniform float uTime;
varying vec2 vUv;
varying float vKind;
varying vec3 vWorld;
varying vec3 vNormal;
vec3 loopAt(float th) {
  // A slow loop round aLoop.xyz (radius aLoop.w), rising and falling, a little squashed.
  return aLoop.xyz + vec3(sin(th) * aLoop.w, sin(th * 2.0 + aLoop2.y) * 2.0, cos(th) * aLoop.w * 0.8);
}
void main() {
  float th = uTime * aLoop2.x + aLoop2.y;
  vec3 p = loopAt(th);
  vec3 f = normalize(loopAt(th + 0.02) - p + vec3(1e-5, 0.0, 0.0));
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 1e-4));
  // Bank into the turn.
  float bank = 0.35 * sign(aLoop2.x);
  vec3 u = cross(r, f);
  vec3 r2 = r * cos(bank) + u * sin(bank);
  vec3 u2 = cross(r2, f);
  // position.x across the span (-1..1), position.y along the body; the wings flap in bursts and glide.
  float burst = smoothstep(0.2, 0.6, sin(uTime * 0.5 + aLoop2.y * 7.0));
  float flap = sin(uTime * 5.0 + aLoop2.y * 11.0) * 0.55 * burst + 0.12;
  float span = abs(position.x);
  float wing = step(0.12, span);
  float ang = flap * wing * (span - 0.12);
  vec3 local = r2 * position.x * cos(ang) + u2 * (span * sin(ang) * 1.6 - span * span * 0.08) + f * (position.y - span * span * 0.15);
  float size = aLoop2.w;
  vec3 w = p + local * size;
  vUv = vec2(position.x, position.y);
  vKind = aLoop2.z;
  vWorld = w;
  vNormal = u2;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const birdFragment = /* glsl */ `
${LIGHT}
varying vec2 vUv;
varying float vKind;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  float x = abs(vUv.x);
  float y = vUv.y;
  // A long-winged silhouette: body down the middle, wings tapering to the tips, a tail behind.
  float body = step(x, 0.1) * step(-0.75, y) * step(y, 0.55);
  float chord = mix(0.3, 0.06, smoothstep(0.1, 1.0, x));
  float wing = step(x, 1.0) * step(abs(y + 0.05 - x * 0.18), chord);
  float tail = step(x, 0.06 + (-0.45 - y) * 0.25) * step(-1.0, y) * step(y, -0.45) * step(0.5, vKind);
  if (body + wing + tail < 0.5) discard;
  vec3 col;
  if (vKind < 0.5) {
    col = vec3(0.96, 0.97, 0.95);
  } else {
    // Scarlet macaw: red body, a yellow band, blue flight feathers.
    col = mix(vec3(0.9, 0.08, 0.06), vec3(1.0, 0.8, 0.1), smoothstep(0.25, 0.4, x));
    col = mix(col, vec3(0.1, 0.35, 0.95), smoothstep(0.45, 0.6, x));
    if (tail > 0.5) col = mix(vec3(0.9, 0.08, 0.06), vec3(0.1, 0.35, 0.95), smoothstep(-0.6, -0.9, y));
  }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  col *= ambient(n) * 1.1 + SUN * (max(dot(n, uSunDir), 0.0) * 0.6 + 0.25);
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

/** Big birds circling under the dome: centre, radius, speed (radians a second; the sign turns), kind (0 egret, 1 macaw), size. */
const LOOPS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [-4, 8, -14, 15, 0.09, 0, 0.85],
  [-4, 8.8, -14, 15, 0.09, 1, 0.75],
  [12, 13, 6, 20, -0.07, 0, 0.9],
  [-14, 6, 10, 11, 0.11, 1, 0.72],
  [6, 17, -6, 26, 0.05, 0, 0.95],
  [-16, 11, -20, 13, -0.1, 1, 0.75],
];

export function Birds() {
  const geometry = useDisposable(() => {
    const loop = new Float32Array(LOOPS.length * 4);
    const loop2 = new Float32Array(LOOPS.length * 4);
    LOOPS.forEach(([x, y, z, r, speed, kind, size], i) => {
      loop.set([x, y, z, r], i * 4);
      loop2.set([speed, i * 1.7 + (kind > 0 && i === 1 ? 0.12 : 0), kind, size], i * 4);
    });
    // Across the span x -1..1 (body in the middle columns), along the body y -1..0.6.
    const shape = new THREE.PlaneGeometry(2, 1.6, 8, 1).translate(0, -0.2, 0);
    const g = instanced(shape, LOOPS.length, { aLoop: [4, loop], aLoop2: [4, loop2] });
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  });
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...fx }, vertexShader: birdVertex, fragmentShader: birdFragment, side: THREE.DoubleSide }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
