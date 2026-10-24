import { useMemo } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { instanced } from './geometry.ts';
import { AXIS, DOME_R, DOME_RISE, GLASS_R, GLASS_THETA, ROOF_Y, SUN_DIR, TANK_R, polar } from './layout.ts';
import { atriumUniforms } from './shading.ts';

// Sunlight made visible: soft beams slanting down through the dome, dust motes drifting and
// twinkling in them, and the glow of the sun just off the top right of the frame.

/** Beams: where each leaves the dome (x, z from the axis), its width and its strength. */
const BEAMS: readonly (readonly [x: number, z: number, width: number, strength: number])[] = [
  [4.5, -6, 1.8, 1.0],
  [7.5, -2.5, 1.2, 0.8],
  [1.5, -9, 1.3, 0.75],
  [10.5, -7, 2.4, 0.85],
  [6.0, -11, 1.6, 0.6],
  [12.0, 0, 1.5, 0.7],
  [-1.5, -4, 1.0, 0.5],
  [9.0, 4, 1.8, 0.55],
];
const BEAM_TOP = ROOF_Y + 3;
const BEAM_LEN = 34;

const BEAM_GLSL = /* glsl */ `
uniform vec4 uBeams[${BEAMS.length}];
// How deep in the beams a point is: project it up the sunlight to the dome and measure.
float beamField(vec3 p, vec3 s, float t) {
  float k = (${BEAM_TOP.toFixed(2)} - p.y) / s.y;
  vec2 q = p.xz + s.xz * k;
  float sum = 0.0;
  for (int i = 0; i < ${BEAMS.length}; i++) {
    vec4 b = uBeams[i];
    vec2 c = b.xy + vec2(sin(t * 0.07 + float(i) * 1.7), cos(t * 0.05 + float(i))) * 0.6;
    float d = length(q - c) / b.z;
    sum += exp(-d * d * 2.0) * b.w;
  }
  return sum;
}
`;

const shaftVertex = /* glsl */ `
attribute vec4 aBeam;
attribute float aIndex;
uniform float uTime;
uniform vec3 uSunDir;
varying vec2 vUv;
varying float vFade;
varying float vIndex;
void main() {
  vec3 dir = -normalize(uSunDir);
  float t = uTime;
  vec2 drift = vec2(sin(t * 0.07 + aIndex * 1.7), cos(t * 0.05 + aIndex)) * 0.6;
  vec3 top = vec3(aBeam.x + drift.x, ${BEAM_TOP.toFixed(2)}, aBeam.y + drift.y);
  float along = 0.5 - position.y;
  vec3 mid = top + dir * ${BEAM_LEN.toFixed(1)} * 0.5;
  vec3 side = normalize(cross(dir, normalize(cameraPosition - mid)));
  float w = aBeam.z * (1.0 + along * 0.35);
  vec3 wp = top + dir * along * ${BEAM_LEN.toFixed(1)} + side * position.x * w;
  vUv = vec2(position.x + 0.5, along);
  vIndex = aIndex;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  // Below the floor, fade; near the camera, fade so no beam fills the view.
  vFade = aBeam.w * smoothstep(3.0, 12.0, wp.y) * smoothstep(4.0, 10.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const shaftFragment = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying float vFade;
varying float vIndex;
void main() {
  float across = sin(3.14159 * vUv.x);
  across *= across;
  float along = smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
  float breathe = 0.6 + 0.4 * sin(uTime * (0.16 + vIndex * 0.023) + vIndex * 2.3);
  float streak = 0.75 + 0.25 * sin(vUv.x * 7.0 + uTime * 0.25 + vIndex * 5.0);
  float a = across * along * breathe * streak * vFade * uIntensity;
  gl_FragColor = vec4(vec3(1.0, 0.96, 0.84) * a, 1.0);
}
`;

const moteVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uSunDir;
uniform float uScale;
varying float vGlow;
${BEAM_GLSL}
void main() {
  // Each mote drifts on its own slow loop round its home, rising and falling.
  float t = uTime * (0.6 + aSeed.w * 0.5);
  vec3 p = position + vec3(sin(t * 0.21 + aSeed.x * 6.0) * 0.9, sin(t * 0.13 + aSeed.y * 6.0) * 1.2, cos(t * 0.17 + aSeed.z * 6.0) * 0.9);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float inBeam = beamField(p, normalize(uSunDir), uTime);
  float twinkle = 0.5 + 0.5 * sin(uTime * (1.1 + aSeed.x * 2.0) + aSeed.y * 30.0);
  vGlow = (0.12 + inBeam * 1.6) * (0.4 + 0.6 * twinkle) * smoothstep(3.0, 7.0, -mv.z);
  gl_PointSize = clamp((0.05 + 0.05 * aSeed.z) * uScale / -mv.z, 1.6, 7.0);
}
`;

const moteFragment = /* glsl */ `
varying float vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 14.0) * vGlow;
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.88) * a, 1.0);
}
`;

const beamUniform = () => ({ value: BEAMS.map(([x, z, w, s]) => new THREE.Vector4(AXIS.x + x, AXIS.z + z, w, s)) });

export function Shafts({ intensity = 0.75 }: { intensity?: number }) {
  const geometry = useDisposable(() => {
    const data = new Float32Array(BEAMS.length * 4);
    const index = new Float32Array(BEAMS.length);
    BEAMS.forEach(([x, z, w, s], i) => {
      data.set([AXIS.x + x, AXIS.z + z, w, s], i * 4);
      index[i] = i;
    });
    return instanced(new THREE.PlaneGeometry(1, 1, 1, 8), BEAMS.length, { aBeam: [4, data], aIndex: [1, index] });
  });
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...atriumUniforms, uIntensity: { value: intensity } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: shaftVertex,
      fragmentShader: shaftFragment,
    }),
  );
  material.uniforms.uIntensity.value = intensity;
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={20} />;
}

export function Motes({ count = 420 }: { count?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(606);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      pos.set([AXIS.x + rand.range(-9, 11), rand.range(1, 20), AXIS.z + rand.range(-9, 9)], i * 3);
      seed.set([rand.next(), rand.next(), rand.next(), rand.next()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...atriumUniforms, uBeams: beamUniform(), uScale: { value: 480 / (2 * Math.tan(THREE.MathUtils.degToRad(28))) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: moteVertex,
      fragmentShader: moteFragment,
    }),
  );
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={21} />;
}

/**
 * The sun just out of the top right of the frame: a warm glow spilling into the corner, a few
 * soft rays turning slowly, and faint bokeh drifting near it. Drawn in screen space, last.
 */
const glowVertex = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const glowFragment = /* glsl */ `
uniform vec2 uSun;
uniform float uAspect;
uniform float uTime;
varying vec2 vNdc;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  vec2 d = (vNdc - uSun) * vec2(uAspect, 1.0);
  float r = length(d);
  float a = atan(d.y, d.x);
  vec3 col = vec3(1.0, 0.93, 0.78) * (exp(-r * 2.2) * 0.16 + exp(-r * 5.0) * 0.25);
  float rays = pow(max(sin(a * 7.0 + uTime * 0.03) * 0.5 + 0.5, 0.0), 6.0) + pow(max(sin(a * 11.0 - uTime * 0.02 + 1.3) * 0.5 + 0.5, 0.0), 8.0) * 0.6;
  col += vec3(1.0, 0.95, 0.85) * rays * exp(-r * 1.3) * 0.12;
  // Bokeh: soft hexagon-free discs drifting about the sun.
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = uSun * vec2(uAspect, 1.0) + vec2(-0.25 - 0.32 * hash11(fi + 1.0), -0.15 - 0.4 * hash11(fi + 7.0));
    c += vec2(sin(uTime * 0.05 + fi * 2.0), cos(uTime * 0.04 + fi * 3.0)) * 0.05;
    float rad = 0.04 + 0.05 * hash11(fi + 3.0);
    float disc = smoothstep(rad, rad * 0.8, length(vNdc * vec2(uAspect, 1.0) - c));
    vec3 tint = mix(vec3(0.6, 1.0, 0.9), vec3(1.0, 0.9, 0.7), hash11(fi + 5.0));
    col += tint * disc * 0.05;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function SunGlow() {
  const geometry = useDisposable(() => new THREE.PlaneGeometry(2, 2));
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { uSun: { value: new THREE.Vector2(1.2, 1.2) }, uAspect: { value: 16 / 9 }, uTime: atriumUniforms.uTime },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
    }),
  );
  const sun = useMemo(() => new THREE.Vector3(), []);
  useBackdropFrame(({ camera }) => {
    sun.copy(SUN_DIR).multiplyScalar(1000).add(camera.position).project(camera);
    material.uniforms.uSun.value.set(sun.x, sun.y);
    if (camera instanceof THREE.PerspectiveCamera) material.uniforms.uAspect.value = camera.aspect;
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={100} />;
}

const glintVertex = /* glsl */ `
attribute vec4 aGlint;
uniform float uTime;
uniform float uScale;
varying float vFlash;
void main() {
  // aGlint: size, rate, phase, strength. Each glint flashes briefly now and then.
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float wave = sin(uTime * aGlint.y + aGlint.z);
  vFlash = pow(max(wave, 0.0), 10.0) * aGlint.w;
  gl_PointSize = clamp(aGlint.x * uScale / -mv.z * (0.5 + 0.5 * vFlash), 2.0, 32.0);
}
`;

const glintFragment = /* glsl */ `
varying float vFlash;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * 2.0;
  float core = exp(-dot(p, p) * 10.0);
  float arms = exp(-abs(p.x) * 9.0) * exp(-p.y * p.y * 90.0) + exp(-abs(p.y) * 9.0) * exp(-p.x * p.x * 90.0);
  float a = (core * 0.8 + arms * 0.6) * vFlash;
  gl_FragColor = vec4(vec3(1.0, 0.98, 0.92) * a * 2.2, 1.0);
}
`;

/** Star glints flashing on the dome's rib crossings, the glass wall's mullions and the column. */
export function Glints() {
  const geometry = useDisposable(() => {
    const rand = makeRandom(313);
    const pos: number[] = [];
    const data: number[] = [];
    const add = (p: THREE.Vector3, size: number) => {
      pos.push(p.x, p.y, p.z);
      data.push(size, rand.range(0.25, 0.6), rand.range(0, Math.PI * 2), rand.range(0.6, 1));
    };
    // Rib crossings over the back half of the dome, where the camera looks.
    for (let i = 0; i < 30; i++) {
      const ring = rand.int(3, 5) * 3.4;
      const theta = (Math.round(rand.range(2.0, 4.3) / ((Math.PI * 2) / 24)) * Math.PI * 2) / 24;
      add(polar(ring, theta, ROOF_Y + DOME_RISE * (1 - (ring / DOME_R) ** 2) - 0.1), rand.range(0.9, 1.4));
    }
    for (let i = 0; i < 10; i++) add(polar(GLASS_R - 0.1, rand.range(GLASS_THETA[0] + 0.4, GLASS_THETA[1]), Math.round(rand.range(1, 3.9)) * 4.8), rand.range(0.6, 0.9));
    for (let i = 0; i < 8; i++) {
      const p = polar(TANK_R + 0.02, Math.PI * 0.18 + rand.range(-0.15, 0.15), rand.range(2, 16));
      add(p, rand.range(0.35, 0.55));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aGlint', new THREE.Float32BufferAttribute(data, 4));
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { uTime: atriumUniforms.uTime, uScale: { value: 480 / (2 * Math.tan(THREE.MathUtils.degToRad(28))) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: glintVertex,
      fragmentShader: glintFragment,
    }),
  );
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={22} />;
}
