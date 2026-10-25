import { Sphere, Vector3 } from 'three';
import type { Bone, Object3D, SkinnedMesh } from 'three';

interface Part { mesh: SkinnedMesh; bone: Bone; point: Vector3; }

/**
 * Keeps each rigidly skinned part's bounding sphere on its bone. Three.js computes a skinned
 * mesh's sphere once, in whatever pose it first renders, and sorts blended meshes (the glass
 * gel writes no depth) and culls them by it, so without this the draw order of the body,
 * head, hands and feet never changes and the body paints over a hand held in front of it.
 * Call it after posing, once the bones' world matrices are current.
 */
export function createSkinBounds(model: Object3D): () => void {
  const parts: Part[] = [];
  model.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const index = mesh.geometry.getAttribute('skinIndex'), weight = mesh.geometry.getAttribute('skinWeight');
    if (!index || !weight || index.count === 0) return;
    // Only parts bound wholly to one bone: a blended skin's sphere isn't a bone's point.
    const k = index.getX(0);
    for (let i = 0; i < index.count; i++) if (index.getX(i) !== k || weight.getX(i) !== 1) return;
    mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere!;
    // The sphere's centre in the bone's space; the skin moves it rigidly with the bone.
    const point = sphere.center.clone().applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[k]);
    mesh.boundingSphere = new Sphere(sphere.center.clone(), sphere.radius);
    parts.push({ mesh, bone: mesh.skeleton.bones[k], point });
  });
  return () => {
    for (const { mesh, bone, point } of parts) {
      // Mesh space, as the skin shader places it: bindMatrixInverse · bone world · point.
      mesh.boundingSphere!.center.copy(point).applyMatrix4(bone.matrixWorld).applyMatrix4(mesh.bindMatrixInverse);
    }
  };
}
