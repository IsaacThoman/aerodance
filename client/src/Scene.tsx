import AeroWorld from './aero/AeroWorld.tsx';

export default function Scene({ paused = false }) {
  return <AeroWorld speed={1} paused={paused} />;
}
