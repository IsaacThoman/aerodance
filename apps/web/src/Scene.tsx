import AeroWorld from './aero/AeroWorld.tsx';
import { aeroHide } from './diagnostics.ts';

export default function Scene({ paused = false }: { paused?: boolean }) {
  return <AeroWorld speed={1} paused={paused} hide={aeroHide} />;
}
