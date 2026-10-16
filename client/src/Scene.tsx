import AeroWorld from './aero/AeroWorld.tsx';

export default function Scene({ paused = false }: { paused?: boolean }) {
  return <AeroWorld speed={1} paused={paused} />;
}
