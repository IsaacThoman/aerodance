import { useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { noise, shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { nightSky, palette, world } from './world.ts';

/** The night sky dome (world.ts nightSky), following the camera. */
export function NightSky() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: world.uTime },
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
        ${noise}
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
  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[100, 48, 24]} />
    </mesh>
  );
}
