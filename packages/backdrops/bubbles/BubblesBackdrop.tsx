import { useMemo } from 'react';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { Bokeh } from './Bokeh.tsx';
import { Bubbles } from './Bubbles.tsx';
import { Background, GodRays } from './Light.tsx';
import { CAMERA } from './layout.ts';
import { makeShared } from './shaders.ts';

/**
 * bubbles: the Vista wallpaper. Big glossy soap bubbles, rainbow-filmed, rise and wobble
 * through luminous aqua light, with god rays fanning down from the bright water overhead, its
 * caustics rippling far above, bokeh at every depth and a few thin streams of small bubbles.
 *
 * Drawn back to front: the aqua (Light.tsx), the rays, bokeh, then every bubble far to near.
 */
export default function BubblesBackdrop() {
  const shared = useMemo(() => makeShared(), []);
  useBackdropFrame((_state, _delta, time) => {
    shared.uTime.value = time;
  });
  return (
    <>
      <BackdropCamera {...CAMERA} sway={[0.22, 0.12, 0.25]} swaySpeed={0.8} parallax={[0.3, 0.16]} />
      <Background shared={shared} />
      <GodRays shared={shared} />
      <Bokeh shared={shared} />
      <Bubbles shared={shared} />
    </>
  );
}
