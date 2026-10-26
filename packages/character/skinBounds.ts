import { Matrix4 } from 'three';
import type { Bone, Object3D, SkinnedMesh } from 'three';
import type { Sphere } from 'three';

interface Part { mesh: SkinnedMesh; bone: Bone; bind: Matrix4; rest: Sphere; }

/** Conservative maximum stretch, including shear; exact when the matrix's axes are orthogonal. */
function stretch(matrix: Matrix4): number {
  const e = matrix.elements;
  const xx = e[0] ** 2 + e[1] ** 2 + e[2] ** 2;
  const yy = e[4] ** 2 + e[5] ** 2 + e[6] ** 2;
  const zz = e[8] ** 2 + e[9] ** 2 + e[10] ** 2;
  const xy = Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]);
  const xz = Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]);
  const yz = Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]);
  // The largest absolute row sum bounds the largest eigenvalue of AᵀA.
  return Math.sqrt(Math.max(xx + xy + xz, yy + xy + yz, zz + xz + yz));
}

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
    const bind = new Matrix4().multiplyMatrices(mesh.skeleton.boneInverses[k], mesh.bindMatrix);
    mesh.boundingSphere = sphere.clone();
    parts.push({ mesh, bone: mesh.skeleton.bones[k], bind, rest: sphere.clone() });
  });
  const skin = new Matrix4();
  return () => {
    for (const { mesh, bone, bind, rest } of parts) {
      // The full skin transform maps the geometry's rest sphere into current mesh space.
      skin.multiplyMatrices(mesh.bindMatrixInverse, bone.matrixWorld).multiply(bind);
      mesh.boundingSphere!.center.copy(rest.center).applyMatrix4(skin);
      mesh.boundingSphere!.radius = rest.radius * stretch(skin);
    }
  };
}
