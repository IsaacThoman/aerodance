import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { nightSky, noiseTexture, palette, polar } from './world.ts';

/**
 * The night sky dome (world.ts nightSky), following the camera and drawn behind everything.
 * It reaches just below the horizon, where the land or a mirror takes over.
 */
export function NightSky() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
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
        varying vec3 vDir;
        ${hash}
        ${noiseTexture}
        ${palette}
        ${nightSky}
        void main() {
          vec3 d = normalize(vDir);
          float pixel = max(length(dFdx(d)), length(dFdy(d)));
          vec3 col = nightSky(vec3(d.x, max(d.y, 0.0), d.z), pixel);
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
