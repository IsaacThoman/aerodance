import type { Matrix4, Object3D, Skeleton, SkinnedMesh } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

/** Clone the rig, retaining the source skin's sharing between its mesh parts. */
export function cloneCharacter(source: Object3D): Object3D {
  const model = clone(source);
  // SkeletonUtils makes a new Skeleton for every mesh, even when a GLTF skin is
  // shared. Their identical bone palettes otherwise get recomputed and uploaded
  // for every body part, every frame. Inverses retain their source array identity.
  const skins = new Map<Matrix4[], Skeleton[]>();
  model.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const skeleton = mesh.skeleton;
    const candidates = skins.get(skeleton.boneInverses) ?? [];
    const shared = candidates.find((candidate) => candidate.bones.length === skeleton.bones.length &&
      candidate.bones.every((bone, i) => bone === skeleton.bones[i]));
    if (shared) mesh.skeleton = shared;
    else {
      candidates.push(skeleton);
      skins.set(skeleton.boneInverses, candidates);
    }
  });
  return model;
}
