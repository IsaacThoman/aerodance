import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { useAtrium } from './shading.ts';

// The floor is drawn by the atrium's own shader, which knows nothing of the dancers, so their
// shadows from the key light fall on a shadow catcher just above it: invisible but for them.
export function FloorShadows() {
  const { look } = useAtrium();
  const geometry = useDisposable(() => new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2).translate(0, 0.005, 0));
  const material = useDisposable(() => new THREE.ShadowMaterial({ color: '#1a2a3a', opacity: look.shadow, depthWrite: false }));
  return <mesh geometry={geometry} material={material} receiveShadow renderOrder={1} />;
}
