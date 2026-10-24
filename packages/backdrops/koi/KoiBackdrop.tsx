import { useMemo } from 'react';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { CAMERA } from './layout.ts';
import { makePondUniforms } from './shaders.ts';
import { Pond } from './Pond.tsx';
import { Koi } from './Koi.tsx';
import { Lilies } from './Lilies.tsx';
import { Petals } from './Petals.tsx';

/**
 * koi: looking steeply down into a clear jade pond. Sunlit caustics dance on a pebble floor,
 * koi loop through it trailing soft shadows, lily pads and pink lotus bob on the surface, drops
 * ring the water, and cherry petals drift down to float on it, under the sun's glitter.
 */
export default function KoiBackdrop() {
  const shared = useMemo(() => makePondUniforms(), []);

  useBackdropFrame((_state, _delta, time) => {
    shared.uTime.value = time;
  });

  return (
    <>
      <BackdropCamera {...CAMERA} sway={[0.25, 0.08, 0.15]} parallax={[0.35, 0.2]} />
      <color attach="background" args={['#0c4a44']} />
      <Pond shared={shared} />
      <Koi shared={shared} />
      <Lilies shared={shared} />
      <Petals shared={shared} camera={CAMERA.position} />
    </>
  );
}
