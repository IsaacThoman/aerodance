import AeroWorld from './aero/AeroWorld.tsx';
import type { AeroQuality } from './aero/types.ts';

export default function Scene({ paused = false, quality = 'auto' }: { paused?: boolean; quality?: AeroQuality }) {
  return <AeroWorld speed={1} paused={paused} quality={quality} />;
}
