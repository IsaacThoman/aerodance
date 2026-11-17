import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Life, turtlePath } from '../../../../packages/stages/openreef/Life.tsx';
import { Reef as Coral, VENTS, makeFloorHeight } from '../../../../packages/stages/openreef/Reef.tsx';
import { Bubbles, GodRays, MarineSnow, WaterBackground } from '../../../../packages/stages/openreef/Water.tsx';
import { SURFACE_Y } from '../../../../packages/stages/openreef/constants.ts';
import { makeShared } from '../../../../packages/stages/openreef/shaders.ts';
import ScenicCamera from './ScenicCamera.tsx';

const bubbleSources = VENTS.map(vent => ({ ...vent, top: SURFACE_Y - 0.1 }));

export default function Reef({ view }: { view: number; clock: boolean }) {
  const floorHeight = useMemo(makeFloorHeight, []);
  const shared = useMemo(makeShared, []);
  const shots = useMemo(() => {
    const turtle = new THREE.Vector3(), heading = new THREE.Vector3();
    return [
      {
        fov: 45,
        frame(camera: THREE.PerspectiveCamera, t: number) {
          camera.position.set(-4.1 + Math.sin(t * 0.049) * 2.6, 2.35 + Math.sin(t * 0.084) * 0.28, 0.7 + 1.15 * Math.cos(t * 0.049));
          camera.lookAt(-12.1, 1.65, -8.5);
        },
      },
      {
        fov: 46,
        frame(camera: THREE.PerspectiveCamera) {
          // Track the same path and clock as the turtle's swimming animation.
          turtlePath(shared.uTime.value, 0, turtle);
          turtlePath(shared.uTime.value + 0.3, 0, heading).sub(turtle);
          heading.y = 0;
          heading.normalize();
          // Stay above and alongside the shell through both turns of its loop.
          camera.position.set(turtle.x + heading.x * 2.65 + heading.z * 4.4, turtle.y + 3.4, turtle.z + heading.z * 2.65 - heading.x * 4.4);
          camera.lookAt(turtle.x + heading.x * 0.16, turtle.y - 0.12, turtle.z + heading.z * 0.16);
        },
      },
    ];
  }, [shared]);
  useFrame(({ clock }) => { shared.uTime.value = clock.elapsedTime; }, -2);
  return <>
    <ScenicCamera view={view} shots={shots} far={600} />
    <WaterBackground shared={shared} />
    <Coral shared={shared} floorHeight={floorHeight} />
    <Life shared={shared} />
    <GodRays shared={shared} />
    <Bubbles shared={shared} sources={bubbleSources} />
    <MarineSnow shared={shared} />
  </>;
}
