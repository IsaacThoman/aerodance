import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function CloudSeaBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#6aa8ff" horizon="#ffd2b0" bottom="#fff1e6" sunDisc={0} sunGlow={0} />
    </>
  );
}
