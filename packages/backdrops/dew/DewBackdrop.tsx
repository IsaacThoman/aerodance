import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function DewBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#2f8f3a" horizon="#d6ffb0" bottom="#0f3d16" sunDisc={0} sunGlow={0} />
    </>
  );
}
