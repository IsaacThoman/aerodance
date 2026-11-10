import { SkyDome } from '../shared/Sky.tsx';
import { Aquarium } from './Aquarium.tsx';
import { Balustrades, Dome, GlassWall, Structure } from './Architecture.tsx';
import { SUN_DIR } from './layout.ts';
import { Glints, Motes, Shafts, SunGlow } from './Light.tsx';
import { Clouds, Landscape, Maglev } from './Outside.tsx';
import { Curtains, Plants } from './Plants.tsx';
import { Pool } from './Pool.tsx';
import type { AtriumUniforms } from './shading.ts';

// atrium: inside a sunlit eco-tech atrium, 2008 brochure style. Curved white balconies trailing
// plants wrap round a tall aquarium column of darting fish and rising bubbles, ringed by a glass
// walkway and standing in a reflecting pool where koi glide; sunbeams and dust motes stream down through a ribbed
// glass dome; and through the glass wall on the right a maglev glides past white eco-towers.
// The plan and the cameras are in layout.ts; the shared light (sun through the dome, haze) in
// shading.ts. From the menu's camera, trees and the balconies' greenery sit behind the title, the
// glass wall's sky and the tropical bed behind the menu's dancers, and the column between them.

/**
 * The atrium, for a scene that brings its own camera and clock and moves `uniforms.uTime` on:
 * the menu's backdrop (packages/backdrops/atrium) and the dance stage (AtriumStage.tsx).
 *
 * Its see-through layers (vines, glass, bubbles, light) draw below renderOrder 0, before the
 * stage's glass dancers: they don't write depth, so anything drawn after them paints over them.
 * Only the sun's glow, a lens effect in screen space, comes last.
 */
export function Atrium({ uniforms }: { uniforms: AtriumUniforms }) {
  return (
    <>
      {/* Outside: sky, clouds, the park and its towers, the maglev. */}
      <SkyDome top="#0f5cc8" horizon="#9ad6ff" bottom="#d4f0ff" exponent={0.45} sunDirection={SUN_DIR.toArray()} sunColor="#fff2d6" sunDisc={3} sunGlow={0.8} sunSize={1.4} radius={2000} />
      <Clouds uniforms={uniforms} />
      <Landscape uniforms={uniforms} />
      <Maglev uniforms={uniforms} />
      {/* The atrium. */}
      <Structure uniforms={uniforms} />
      <Pool uniforms={uniforms} />
      <Plants uniforms={uniforms} />
      <Curtains uniforms={uniforms} />
      <Aquarium uniforms={uniforms} />
      <GlassWall uniforms={uniforms} />
      <Balustrades uniforms={uniforms} />
      <Dome uniforms={uniforms} />
      {/* Light made visible. */}
      <Shafts uniforms={uniforms} />
      <Motes uniforms={uniforms} />
      <Glints uniforms={uniforms} />
      <SunGlow uniforms={uniforms} />
    </>
  );
}
