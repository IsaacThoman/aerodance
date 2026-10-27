import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { beat, StageCamera } from '../shared/hooks.ts';
import { StageEnvironment } from '../shared/Environment.tsx';
import { SkyDome } from '../shared/Sky.tsx';
import { post } from '../shared/post.tsx';
import type { PostOverrides } from '../shared/post.tsx';
import { Aquarium } from './Aquarium.tsx';
import { Balustrades, Dome, GlassWall, Structure } from './Architecture.tsx';
import { CAMERA } from './layout.ts';
import { Glints, Motes, Shafts, SunGlow } from './Light.tsx';
import type { AtriumLook } from './looks.ts';
import { Clouds, Landscape, Maglev } from './Outside.tsx';
import { Platform } from './Platform.tsx';
import { Curtains, Plants } from './Plants.tsx';
import { Pool } from './Pool.tsx';
import { AtriumContext, makeAtriumUniforms } from './shading.ts';
import type { Atrium } from './shading.ts';

// atrium: inside a round eco-tech atrium, 2008 brochure style. The dancers stand on a white stage
// reaching into a reflecting pool; behind them an aquarium column of circling fish and rising
// bubbles climbs to a ribbed glass dome, ringed by curved white balconies trailing plants, and
// through the glass wall at the back right a maglev glides past white eco-towers. Three looks:
// sunlit midday (atrium), golden hour (atriumdusk) and night (atriumnight). The plan and the
// camera are in layout.ts, the looks in looks.ts, the light every shader shares in shading.ts.

/** Moves every material's clock on: everything animates in its shader from this. */
function Clock({ atrium, bloom }: { atrium: Atrium; bloom: number }) {
  useFrame((state) => {
    atrium.uniforms.uTime.value = state.clock.elapsedTime;
    atrium.uniforms.uBeat.value = beat.pulse;
    post.bloomStrength = bloom * (1 + beat.pulse * 0.15);
  });
  return null;
}

export interface AtriumStageProps {
  look: AtriumLook;
  post: PostOverrides;
}

export function AtriumScene({ look, post: settings }: AtriumStageProps) {
  const atrium = useMemo<Atrium>(() => ({ look, uniforms: makeAtriumUniforms(look) }), [look]);
  const { sky, key, hemi, environment } = look;
  return (
    <AtriumContext.Provider value={atrium}>
      <StageCamera position={CAMERA.position} target={CAMERA.target} fov={CAMERA.fov} near={0.3} far={3000} orbit={[0.08, 0.02]} sway={[0.12, 0.06, 0]} parallax={[0.4, 0.2]} />
      <Clock atrium={atrium} bloom={settings.bloomStrength ?? 0} />
      <StageEnvironment top={environment.top} horizon={environment.horizon} bottom={environment.bottom} lights={environment.lights} intensity={environment.intensity} />
      <hemisphereLight args={[hemi[0], hemi[1], hemi[2]]} />
      <directionalLight
        castShadow
        position={key.position}
        intensity={key.intensity}
        color={key.color}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-normalBias={0.03}
        shadow-bias={-0.0004}
      />
      {/* Outside: sky, clouds, the park and its towers, the maglev. */}
      <SkyDome
        top={sky.top}
        horizon={sky.horizon}
        bottom={sky.bottom}
        exponent={sky.exponent}
        sunDirection={look.sunDir.toArray()}
        sunColor={sky.sun}
        sunDisc={sky.disc}
        sunGlow={sky.glow}
        sunSize={sky.size}
        stars={look.stars}
        radius={2000}
      />
      <Clouds />
      <Landscape />
      <Maglev />
      {/* The atrium. */}
      <Structure />
      <Pool />
      <Platform />
      <Plants />
      <Curtains />
      <Aquarium />
      <GlassWall />
      <Balustrades />
      <Dome />
      {/* Light made visible. */}
      <Shafts />
      <Motes />
      {look.glints && <Glints />}
      <SunGlow />
    </AtriumContext.Provider>
  );
}
