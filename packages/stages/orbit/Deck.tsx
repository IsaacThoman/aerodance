import type { OrbitVariant } from './layout.ts';
import { DECK_RADIUS, DECK_Y } from './layout.ts';

/** PLACEHOLDER (deck): the deck the dancers stand on. */
export function Deck(_props: OrbitVariant) {
  return (
    <mesh position={[0, DECK_Y - 0.2, 0]} receiveShadow>
      <cylinderGeometry args={[DECK_RADIUS, DECK_RADIUS * 0.94, 0.4, 64]} />
      <meshStandardMaterial color="#e8f0f8" roughness={0.3} />
    </mesh>
  );
}
