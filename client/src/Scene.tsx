import AeroWorld from './aero/AeroWorld.tsx';
import { aeroHide, quality } from './quality.ts';

export default function Scene({ paused = false }: { paused?: boolean }) {
  return <AeroWorld speed={1} paused={paused} quality={quality} hide={aeroHide} />;
}
