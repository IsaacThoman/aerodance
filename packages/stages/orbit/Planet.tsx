import type { OrbitVariant } from './layout.ts';
import { PLANET_CENTER, PLANET_RADIUS } from './layout.ts';

/** PLACEHOLDER (sky): the planet below. */
export function Planet({ night }: OrbitVariant) {
  return (
    <mesh position={PLANET_CENTER.toArray()}>
      <sphereGeometry args={[PLANET_RADIUS, 128, 64]} />
      <meshBasicMaterial color={night ? '#06102a' : '#1d5fc4'} />
    </mesh>
  );
}
