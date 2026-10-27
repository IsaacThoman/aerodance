import { useMemo } from 'react';
import { Atrium } from '../../stages/atrium/Atrium.tsx';
import { MENU_CAMERA } from '../../stages/atrium/layout.ts';
import { makeAtriumUniforms } from '../../stages/atrium/shading.ts';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';

// atrium: the atrium stage's room (packages/stages/atrium) seen from where the menu wants it,
// without its dance floor: trees and the balconies' greenery behind the title, the glass wall's
// sky and the tropical bed behind the menu's dancers, and the aquarium column between them.

export default function AtriumBackdrop() {
  // The floor nearest the camera in the shade, which frames the menu better.
  const uniforms = useMemo(() => makeAtriumUniforms({ fov: MENU_CAMERA.fov, foreShade: 1 }), []);
  // Everything animates in its shader from this clock.
  useBackdropFrame((_state, _delta, time) => {
    uniforms.uTime.value = time;
  });
  return (
    <>
      <BackdropCamera position={MENU_CAMERA.position} target={MENU_CAMERA.target} fov={MENU_CAMERA.fov} near={0.3} far={3000} sway={[0.35, 0.12, 0.2]} parallax={[0.5, 0.25]} />
      <Atrium uniforms={uniforms} />
    </>
  );
}
