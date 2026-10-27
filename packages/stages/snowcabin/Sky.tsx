import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { nightSky, noiseTexture, palette, polar } from '../polar/world.ts';

/** Where the moon hangs: low on the left, off to the side of the dancers. */
export const MOON = new THREE.Vector3(-0.93, 0.25, 0.2).normalize();

/** The kit's night sky (polar/world.ts nightSky), with a moon and its soft halo hanging low on the left. */
export function SnowSky() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise, uMoon: { value: MOON } },
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
        uniform vec3 uMoon;
        varying vec3 vDir;
        ${hash}
        ${noiseTexture}
        ${palette}
        ${nightSky}
        vec3 moon(vec3 d, float pixel) {
          float a = acos(clamp(dot(d, uMoon), -1.0, 1.0));
          const float R = 0.028;
          float disc = 1.0 - smoothstep(R - pixel, R + pixel, a);
          // Soft grey seas on a pale disc, and a wide pearly halo.
          vec2 s = vec2(dot(d, normalize(cross(uMoon, vec3(0.0, 1.0, 0.0)))), d.y - uMoon.y) / R;
          float seas = smoothstep(0.1, 0.6, noise4(s * 1.3 + 4.0).r) * 0.12;
          vec3 col = vec3(1.0, 0.98, 0.92) * (3.2 - seas * 3.0) * disc;
          col += vec3(0.55, 0.7, 1.0) * (exp(-a * 9.0) * 0.06 + exp(-a * 40.0) * 0.22);
          return col;
        }
        void main() {
          vec3 d = normalize(vDir);
          float pixel = max(length(dFdx(d)), length(dFdy(d)));
          vec3 col = nightSky(vec3(d.x, max(d.y, 0.0), d.z), pixel) + moon(d, pixel);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  useFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[100, 48, 14, 0, Math.PI * 2, 0, Math.PI * 0.56]} />
    </mesh>
  );
}
