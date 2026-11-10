import { useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { hash, shaderMaterial, simplex } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import type { SharedUniforms } from './shaders.ts';

const color = (hex: string, scale = 1) => new THREE.Color(hex).multiplyScalar(scale);

/**
 * The open water all round, by view direction: bright aqua towards the surface far above, deep
 * indigo below; shimmering rays fanning down from the sun, the rippling underside of the
 * surface at the very top, and faint drifting glows in the deep. Follows the camera.
 */
export function Water({ shared }: { shared: SharedUniforms }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() => {
    // A frame round the sun direction, for the rays' angle about it.
    const sun = shared.uSun.value;
    const across = new THREE.Vector3(0, 0, 1).cross(sun).normalize();
    const up = sun.clone().cross(across);
    return shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: shared.uTime,
        uSun: shared.uSun,
        uSunX: { value: across },
        uSunY: { value: up },
        uSurface: { value: color('#b2f2ff') },
        uHigh: { value: color('#2ab2e0') },
        uMid: { value: color('#1a86cf') },
        uLow: { value: color('#1d45a6') },
        uDeep: { value: color('#1d1563') },
        uRay: { value: color('#bff8ff', 0.34) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSun;
        uniform vec3 uSunX;
        uniform vec3 uSunY;
        uniform vec3 uSurface;
        uniform vec3 uHigh;
        uniform vec3 uMid;
        uniform vec3 uLow;
        uniform vec3 uDeep;
        uniform vec3 uRay;
        varying vec3 vDir;
        ${hash}
        ${simplex}
        void main() {
          vec3 d = normalize(vDir);
          float e = d.y;
          vec3 c = mix(uDeep, uLow, smoothstep(-0.4, -0.12, e));
          c = mix(c, uMid, smoothstep(-0.12, 0.2, e));
          c = mix(c, uHigh, smoothstep(0.26, 0.52, e));
          c = mix(c, uSurface, smoothstep(0.4, 0.9, e));

          // The sun's glow through the water, high above the frame.
          float sd = max(dot(d, uSun), 0.0);
          c += uSurface * (pow(sd, 8.0) * 0.22 + pow(sd, 40.0) * 0.5);

          // Rays fanning down from it: noise round the angle about the sun, shifting slowly.
          vec2 q = vec2(dot(d, uSunX), dot(d, uSunY));
          vec2 ring = q / max(length(q), 1e-4);
          float r1 = snoise(vec3(ring * 9.0, uTime * 0.045));
          float r2 = snoise(vec3(ring * 23.0 + 7.0, uTime * 0.07 + 3.0));
          float rays = smoothstep(-0.1, 0.85, r1 * 0.65 + r2 * 0.35);
          rays *= 0.75 + 0.25 * sin(uTime * 0.3 + r1 * 4.0);
          c += uRay * rays * smoothstep(0.38, 0.95, sd);

          // The surface's rippling underside, near the top of the frame.
          float surf = smoothstep(0.3, 0.62, e);
          if (surf > 0.0) {
            vec2 sp = d.xz / e * 1.6;
            float w1 = max(1.0 - abs(snoise(vec3(sp, uTime * 0.12))), 0.0);
            float w2 = max(1.0 - abs(snoise(vec3(sp * 1.9 + 4.0, uTime * 0.17 + 9.0))), 0.0);
            float web = pow(w1, 5.0) * 0.6 + pow(w2, 5.0) * 0.35;
            c += uSurface * web * surf * 0.28;
          }

          // Faint violet and teal glows drifting in the deep.
          float deep = smoothstep(0.08, -0.4, e);
          if (deep > 0.0) {
            float n1 = snoise(vec3(d.x * 0.9, d.y * 1.4, uTime * 0.015));
            float n2 = snoise(vec3(d.x * 1.3 + 5.0, d.y * 1.8, uTime * 0.02 + 4.0));
            vec3 glow = mix(vec3(0.3, 0.12, 0.6), vec3(0.05, 0.36, 0.6), smoothstep(-0.5, 0.5, n2));
            c += glow * (0.35 + 0.65 * smoothstep(-0.6, 0.9, n1)) * deep * 0.12;
          }

          // A breath of dither keeps the smooth gradient from banding.
          c += (hash12(gl_FragCoord.xy) - 0.5) * 0.6 / 255.0;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
  });
  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[400, 48, 24]} />
    </mesh>
  );
}
