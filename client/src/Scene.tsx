import AeroWorld from './aero/AeroWorld.tsx';
import type { AeroPart } from './aero/aeroBackground.ts';

// Diagnostics: ?aeroHide=clouds,birds leaves parts of the Aero world out (see AeroPart).
const hide = new URLSearchParams(location.search).get('aeroHide')?.split(',') as AeroPart[] | undefined;

export default function Scene({ paused = false }: { paused?: boolean }) {
  return <AeroWorld speed={1} paused={paused} hide={hide} />;
}
