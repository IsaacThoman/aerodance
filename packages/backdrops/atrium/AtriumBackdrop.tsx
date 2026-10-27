import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { Aquarium } from './Aquarium.tsx';
import { Balustrades, Dome, GlassWall, Structure } from './Architecture.tsx';
import { CAMERA, SUN_DIR } from './layout.ts';
import { Glints, Motes, Shafts, SunGlow } from './Light.tsx';
import { Clouds, Landscape, Maglev } from './Outside.tsx';
import { Curtains, Plants } from './Plants.tsx';
import { Pool } from './Pool.tsx';
import { atriumUniforms } from './shading.ts';

// atrium: inside a sunlit eco-tech atrium, 2008 brochure style. Curved white balconies trailing
// plants wrap round a tall aquarium column of circling fish and rising bubbles, ringed by a glass
// walkway and standing in a reflecting pool; sunbeams and dust motes stream down through a ribbed
// glass dome; and through the glass wall on the right a maglev glides past white eco-towers.
// The plan and the camera are in layout.ts; the shared light (sun through the dome, haze) in
// shading.ts. Trees and the balconies' greenery sit behind the title, the glass wall's sky and
// the tropical bed behind the dancers, and the column between them.

/** Moves every material's clock on: everything animates in its shader from this. */
function Clock() {
  useBackdropFrame((_state, _delta, time) => {
    atriumUniforms.uTime.value = time;
  });
  return null;
}

export default function AtriumBackdrop() {
  return (
    <>
      <BackdropCamera position={CAMERA.position} target={CAMERA.target} fov={CAMERA.fov} near={0.3} far={3000} sway={[0.35, 0.12, 0.2]} parallax={[0.5, 0.25]} />
      <Clock />
      {/* Outside: sky, clouds, the park and its towers, the maglev. */}
      <SkyDome top="#0f5cc8" horizon="#9ad6ff" bottom="#d4f0ff" exponent={0.45} sunDirection={SUN_DIR.toArray()} sunColor="#fff2d6" sunDisc={3} sunGlow={0.8} sunSize={1.4} radius={2000} />
      <Clouds />
      <Landscape />
      <Maglev />
      {/* The atrium. */}
      <Structure />
      <Pool />
      <Plants />
      <Curtains />
      <Aquarium />
      <GlassWall />
      <Balustrades />
      <Dome />
      {/* Light made visible. */}
      <Shafts />
      <Motes />
      <Glints />
      <SunGlow />
    </>
  );
}
