import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { nightSky, noiseTexture, palette, polar } from '../polar/world.ts';

/** Where the moon hangs: low on the left, off to the side of the dancers. */
export const MOON = new THREE.Vector3(-0.93, 0.25, 0.2).normalize();

/**
 * The kit's night sky (polar/world.ts) for a stage the preview circles all the way round. Its
 * gradient and farthest aurora are painted for looking towards -z and meet in a seam behind; here
 * the back half of the sky shows the front half mirrored, so there's none. The stars aren't
 * mirrored (their grid is sized to close up round the circle), and a moon with a soft halo hangs
 * low on the left.
 */
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
          vec3 s = vec3(d.x, max(d.y, 0.0), d.z);
          vec3 f = vec3(s.x, s.y, -abs(s.z) - 1e-4);
          float el = asin(clamp(s.y, -1.0, 1.0));
          vec3 col = skyGradient(f) + farAurora(atan(f.x, -f.z), s.y);
          vec2 q = vec2(atan(s.x, -s.z + 1e-6), el);
          // Star cells that divide the circle exactly, so the grid closes up behind without a seam.
          vec3 stars = starLayer(q, el, 6.2831853 / 314.0, 0.16, pixel, 0.5, 3.0) + starLayer(q, el, 6.2831853 / 114.0, 0.3, pixel * 1.25, 1.5, 11.0);
          col += (stars + shootingStar(vec2(atan(f.x, -f.z), el), pixel)) * smoothstep(0.0, 0.14, el);
          col += moon(d, pixel);
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
