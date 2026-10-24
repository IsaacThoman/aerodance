import { useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { bokehData } from './layout.ts';
import { LIGHT, SKY, world } from './palette.ts';
import { bokehFragment, bokehVertex, skyFragment, skyVertex } from './shaders.ts';

/** The luminous sky gradient and its light, on a dome that follows the camera. */
export function RibbonSky() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: world.uTime,
        uZenith: { value: new THREE.Color(SKY.zenith) },
        uUpper: { value: new THREE.Color(SKY.upper) },
        uMiddle: { value: new THREE.Color(SKY.middle) },
        uLow: { value: new THREE.Color(SKY.low) },
        uFloor: { value: new THREE.Color(SKY.floor) },
        uGlow: { value: new THREE.Color(SKY.glow) },
        uLight: { value: LIGHT },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
    }),
  );
  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[500, 48, 24]} />
    </mesh>
  );
}

// The band the bokeh rise through, in world units.
const BOKEH_HEIGHT = 30;

/** Faint out-of-focus discs drifting up through the light. */
export function Bokeh({ count = 36, seed = 41, renderOrder = 0 }: { count?: number; seed?: number; renderOrder?: number }) {
  const geometry = useDisposable(() => {
    const data = bokehData(count, BOKEH_HEIGHT, seed);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    g.setAttribute('aBokeh', new THREE.InstancedBufferAttribute(new Float32Array(data.bokeh), 4));
    g.setAttribute('aDrift', new THREE.InstancedBufferAttribute(new Float32Array(data.drift), 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(data.color), 3));
    g.instanceCount = count;
    return g;
  }, [count, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      premultipliedAlpha: true,
      uniforms: { uTime: world.uTime, uHeight: { value: BOKEH_HEIGHT } },
      vertexShader: bokehVertex,
      fragmentShader: bokehFragment,
    }),
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={renderOrder} />;
}
