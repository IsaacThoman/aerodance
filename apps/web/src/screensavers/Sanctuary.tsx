import SanctuaryStage from '../../../../packages/stages/sanctuary/SanctuaryStage.tsx';
import ScenicCamera, { type ScenicShot } from './ScenicCamera.tsx';

// The first flight follows the broad river between tower blocks. The second
// looks across the conservatory and its elevated railway from the opposite bank.
const shots: readonly ScenicShot[] = [
  {
    fov: 54,
    frame(camera, time) {
      const phase = time * 0.021;
      camera.position.set(62 + 48 * Math.sin(phase), 84 + 12 * Math.sin(phase * 0.8), -302 + 86 * Math.cos(phase));
      camera.lookAt(5 + 35 * Math.sin(phase), -38, -760);
    },
  },
  {
    fov: 48,
    frame(camera, time) {
      const phase = time * 0.028;
      camera.position.set(-34 + 20 * Math.sin(phase), -5 + 9 * Math.sin(phase * 0.8), -242 - 22 * Math.cos(phase));
      camera.lookAt(-174, -35, -459);
    },
  },
];

export default function Sanctuary({ view }: { view: number }) {
  return <SanctuaryStage camera={<ScenicCamera view={view} shots={shots} near={0.5} far={9000} />} />;
}
