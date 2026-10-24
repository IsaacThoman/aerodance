import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function KoiBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#3fb8a8" horizon="#d8fff4" bottom="#0f5f5a" sunDisc={0} sunGlow={0} />
    </>
  );
}
