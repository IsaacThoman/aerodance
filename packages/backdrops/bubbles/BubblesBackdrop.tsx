import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function BubblesBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#0a74c8" horizon="#9ff4ff" bottom="#063a6e" sunDisc={0} sunGlow={0} />
    </>
  );
}
