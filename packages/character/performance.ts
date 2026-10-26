// Direct posing of the six visible parts. The animator chooses the silhouette, including
// squash, head placement, limb spacing and depth, without going through human landmarks.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Bone, Object3D } from 'three';
import type { CharacterPose, Triple } from '../pose/performance.ts';

export function createPerformanceApplier(model: Object3D) {
  const bones = new Map<string, Bone>();
  model.traverse(o => { if ('isBone' in o && o.isBone) bones.set(o.name, o as Bone); });
  const bone = (name: string) => { const b = bones.get(name); if (!b) throw Error(`Missing rig bone: ${name}`); return b; };
  const [Root, Body, Head, ArmL, ArmR, FootL, FootR] = ['Root', 'Body', 'Head', 'ArmL', 'ArmR', 'FootL', 'FootR'].map(bone);
  const rest = [...bones.values()].map(b => ({ b, position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone(), auto: b.matrixAutoUpdate }));
  const matrix = new Matrix4(), inverse = new Matrix4(), world = new Matrix4();
  const position = new Vector3(), offset = new Vector3(), scale = new Vector3(), rotation = new Quaternion(), euler = new Euler();
  let active = false;
  function place(b: Bone, centre: Triple, angles: Triple, size: Triple, pivot: Triple = [0, 0, 0]) {
    rotation.setFromEuler(euler.set(...angles.map(a => a * Math.PI / 180) as Triple, 'XYZ'));
    scale.fromArray(size);
    offset.fromArray(pivot).multiply(scale).applyQuaternion(rotation);
    position.fromArray(centre).sub(offset);
    matrix.compose(position, rotation, scale);
    inverse.copy(b.parent!.matrixWorld).invert();
    world.multiplyMatrices(inverse, model.matrixWorld).multiply(matrix);
    world.decompose(b.position, b.quaternion, b.scale);
    // Cancelling a squashed, rotated parent can require shear. Keep the exact matrix rather
    // than recomposing its TRS decomposition, which would distort the head and hands.
    b.matrixAutoUpdate = false;
    b.matrix.copy(world);
    b.updateMatrixWorld(true);
  }
  return (pose: CharacterPose | null | undefined): boolean => {
    if (!pose) {
      if (active) for (const { b, position, quaternion, scale, auto } of rest) {
        b.position.copy(position); b.quaternion.copy(quaternion); b.scale.copy(scale); b.matrixAutoUpdate = auto; b.updateMatrix();
      }
      active = false;
      return false;
    }
    active = true;
    model.visible = true;
    Root.position.set(0, 0, 0); Root.quaternion.identity(); Root.scale.setScalar(1);
    Root.updateWorldMatrix(true, true);
    place(Body, pose.body, pose.bodyRotation, pose.bodyScale);
    place(Head, pose.head, pose.headRotation, [pose.headScale, pose.headScale, pose.headScale], [0, .6, 0]);
    const handSize: Triple = [pose.handScale, pose.handScale, pose.handScale];
    place(ArmR, pose.leftHand, [0, 0, 0], handSize, [.26, -.86, 0]);
    place(ArmL, pose.rightHand, [0, 0, 0], handSize, [-.26, -.86, 0]);
    const footSize: Triple = [pose.footScale, pose.footScale, pose.footScale];
    place(FootR, pose.leftFoot, [0, 0, 0], footSize, [0, 0, .13]);
    place(FootL, pose.rightFoot, [0, 0, 0], footSize, [0, 0, .13]);
    return true;
  };
}
