import * as THREE from 'three';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { shaderMaterial } from '../../../../../packages/stages/shared/glsl.ts';
import { makeRandom } from '../../../../../packages/stages/shared/random.ts';
import { W, commonGLSL } from './world.ts';

/*
 * Rain and snow falling round the camera: a box of streaks or flakes that moves with it, each one
 * wrapping round the box as it falls (so they never run out), as many showing as the weather says.
 */

/** The box round the camera (x, y, z), and how far everything in it has fallen and drifted (wrapped in the box): the driver sets them. */
export const RAIN_BOX = new THREE.Vector3(56, 40, 56);
export const SNOW_BOX = new THREE.Vector3(44, 30, 44);
export const FALL = { rain: new THREE.Vector3(), snow: new THREE.Vector3() };

function particles(count: number, seed: number) {
  const rand = makeRandom(seed);
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  g.setAttribute('uv', plane.attributes.uv);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) data.set([rand.next(), rand.next(), rand.next(), rand.next()], i * 4);
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(data, 4));
  g.instanceCount = count;
  return g;
}

// Where a particle is: its place in the box, carried by the fall, wrapped round the camera.
const wrapGLSL = /* glsl */ `
vec3 inBox(vec3 seed, vec3 box, vec3 fall) {
  vec3 p = seed * box + fall;
  return cameraPosition + mod(p - cameraPosition + box * 0.5, box) - box * 0.5;
}
`;

/** Streaks of rain, slanting in the wind, catching the light. */
export function Rain() {
  const geometry = useDisposable(() => particles(2200, 7));
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    // (Its quads are laid along the fall on screen, which turns them over: both sides.)
    side: THREE.DoubleSide,
    uniforms: { ...W, uBox: { value: RAIN_BOX }, uFall: { value: FALL.rain } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform vec3 uBox, uFall;
      uniform float uRain, uWind;
      uniform vec2 uWindDir;
      varying float vAlpha;
      varying vec2 vUv;
      ${wrapGLSL}
      void main() {
        vec3 vel = normalize(vec3(uWindDir.x * uWind * 0.32, -1.0, uWindDir.y * uWind * 0.32));
        vec3 p = inBox(aSeed.xyz, uBox, uFall);
        vec4 a = viewMatrix * vec4(p, 1.0);
        vec4 b = viewMatrix * vec4(p + vel * (0.9 + aSeed.w * 0.6), 1.0);
        vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
        float dist = -a.z;
        bool show = aSeed.w < uRain * 1.15 && ca.w > 0.5 && cb.w > 0.5;
        vec2 sa = ca.xy / ca.w, sb = cb.xy / cb.w;
        vec2 d = sb - sa;
        float len = length(d);
        d = len > 1e-5 ? d / len : vec2(0.0, -1.0);
        vec4 pos = mix(ca, cb, position.y);
        // About three pixels wide (of the 640x480 buffer) whatever the distance.
        pos.xy += vec2(-d.y, d.x) * position.x * vec2(0.01, 0.013) * pos.w;
        vAlpha = smoothstep(1.5, 4.0, dist) * (1.0 - smoothstep(18.0, 28.0, dist)) * (0.4 + 0.25 * aSeed.w);
        vUv = vec2(position.x + 0.5, position.y);
        gl_Position = show ? pos : vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec2 vUv;
      ${commonGLSL}
      void main() {
        float a = vAlpha * (1.0 - smoothstep(0.3, 1.0, abs(vUv.x * 2.0 - 1.0))) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
        vec3 col = (uAmbSky * 2.4 + uKeyColor * 0.5 + vec3(0.8, 0.85, 1.0) * uFlash * 2.0) + uLamps * vec3(0.12, 0.08, 0.04);
        gl_FragColor = vec4(col, a);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={20} />;
}

/** Snowflakes drifting down, tumbling in the wind. */
export function Snow() {
  const geometry = useDisposable(() => particles(1500, 9));
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { ...W, uBox: { value: SNOW_BOX }, uFall: { value: FALL.snow } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform vec3 uBox, uFall;
      uniform float uSnowFall, uTime;
      varying float vAlpha;
      varying vec2 vUv;
      ${wrapGLSL}
      void main() {
        vec3 p = inBox(aSeed.xyz, uBox, uFall);
        float s = aSeed.w * 50.0;
        p += vec3(sin(uTime * 0.9 + s) * 0.6, 0.0, cos(uTime * 0.7 + s * 1.3) * 0.6);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        mv.xy += (position.xy - vec2(0.0, 0.5)) * mix(0.09, 0.17, fract(s));
        vAlpha = smoothstep(1.0, 3.0, dist) * (1.0 - smoothstep(14.0, 22.0, dist)) * 0.85;
        vUv = uv;
        gl_Position = aSeed.w < uSnowFall * 1.2 && dist > 0.2 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec2 vUv;
      ${commonGLSL}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float a = exp(-dot(p, p) * 3.0) * vAlpha;
        vec3 col = vec3(0.95, 0.97, 1.0) * (uAmbSky * 1.4 + uKeyColor * 0.5 + flashLight(vec3(0.0, 1.0, 0.0))) + uLamps * vec3(0.1, 0.07, 0.03);
        gl_FragColor = vec4(col, a);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={21} />;
}
