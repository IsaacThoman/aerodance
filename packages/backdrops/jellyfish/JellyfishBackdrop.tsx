import { useMemo } from 'react';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { Jellies } from './Jellies.tsx';
import { CAMERA } from './layout.ts';
import { Bokeh, Motes } from './Particles.tsx';
import { makeShared } from './shaders.ts';
import { Water } from './Water.tsx';

/**
 * jellyfish: luminous open water, bright aqua towards the surface far above and deep indigo
 * below, where glowing jellies pulse and drift up trailing long tentacles, through sun rays,
 * marine snow, plankton sparkles and soft bokeh. Everything moves in its shaders, on the
 * backdrop clock.
 */
export default function JellyfishBackdrop() {
  const shared = useMemo(() => makeShared(), []);
  useBackdropFrame((_state, _delta, time) => {
    shared.uTime.value = time;
  });
  return (
    <>
      <BackdropCamera {...CAMERA} far={800} sway={[0.25, 0.12, 0]} swaySpeed={0.8} parallax={[0.3, 0.15]} />
      <Water shared={shared} />
      <Jellies shared={shared} />
      <Motes shared={shared} />
      <Bokeh shared={shared} />
    </>
  );
}
