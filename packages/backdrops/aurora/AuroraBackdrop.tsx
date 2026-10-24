import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function AuroraBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#0b1e4a" horizon="#2fd6b0" bottom="#06101f" sunDisc={0} sunGlow={0} />
    </>
  );
}
