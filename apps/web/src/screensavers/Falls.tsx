import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, Object3D, type InstancedMesh } from 'three';
import { sailboatGeometry } from '../../../../packages/stages/beach/props.ts';
import { LAKE, LAKE_Y } from '../../../../packages/stages/falls/terrain.ts';
import { useDisposable } from '../../../../packages/stages/shared/hooks.ts';
import FallsStage from '../../../../packages/stages/falls/FallsStage.tsx';
import ScenicCamera, { type ScenicShot } from './ScenicCamera.tsx';

// Glide just beyond the meadow rim, with the floating islands and the cloud
// banks above the lake. Down in the basin the bow rises in front of the falls.
const shots: readonly ScenicShot[] = [
  {
    fov: 51,
    frame(camera, time) {
      const phase = time * 0.027;
      camera.position.set(-5 + 9 * Math.sin(phase), 9 + 3 * Math.sin(phase * 0.7), -17 + 4 * Math.cos(phase));
      camera.lookAt(9, -7, -238);
    },
  },
  {
    fov: 46,
    frame(camera, time) {
      const phase = time * 0.023;
      camera.position.set(-25 + 6 * Math.sin(phase), -12 + 3 * Math.cos(phase), -96 + 7 * Math.cos(phase));
      camera.lookAt(-71, -12, -210);
    },
  },
];

// Three sailboats circle the lake, following their own courses inside the
// shore. The hulls and painted sails are the ones from the beach stage.
const courses = [
  { cx: -37, cz: 20, width: 29, depth: 17, speed: 0.032, phase: 0.2 },
  { cx: 18, cz: 6, width: 32, depth: 18, speed: -0.027, phase: 1.8 },
  { cx: 3, cz: -35, width: 42, depth: 13, speed: 0.029, phase: 4.2 },
];

function LakeSailboats() {
  const fleet = useRef<InstancedMesh>(null);
  const boat = useMemo(() => new Object3D(), []);
  const geometry = useDisposable(() => sailboatGeometry({ hull: '#278ba3', stripe: '#fa784e' }));
  useFrame(({ clock }) => {
    const mesh = fleet.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    courses.forEach((course, i) => {
      const angle = course.phase + t * course.speed;
      const sin = Math.sin(angle), cos = Math.cos(angle);
      boat.position.set(LAKE.x + course.cx + course.width * sin, LAKE_Y + 0.1 * Math.sin(t + i), LAKE.z + course.cz + course.depth * cos);
      const heading = Math.atan2(course.speed * course.width * cos, -course.speed * course.depth * sin);
      boat.rotation.set(0.025 * Math.sin(t + i), heading, 0.065 * Math.sin(t * 0.7 + i) - 0.08, 'YXZ');
      boat.scale.setScalar(1.25);
      boat.updateMatrix();
      mesh.setMatrixAt(i, boat.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={fleet} args={[geometry, undefined, courses.length]} frustumCulled={false}>
    <meshStandardMaterial side={DoubleSide} vertexColors roughness={0.53} />
  </instancedMesh>;
}

export default function Falls({ view }: { view: number }) {
  return <>
    <FallsStage camera={<ScenicCamera view={view} shots={shots} near={0.2} far={6000} />} />
    <LakeSailboats />
  </>;
}
