import type { BufferGeometry, Material, Object3D, SkinnedMesh } from 'three';

const rigid = new WeakMap<BufferGeometry, boolean>();

/** Only specialize skins whose other three influences have exactly zero weight. */
export function hasRigidSkinning(model: Object3D): boolean {
  let result = true;
  model.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry;
    let single = rigid.get(geometry);
    if (single === undefined) {
      const weights = geometry.getAttribute('skinWeight');
      single = !!weights;
      for (let i = 0; single && i < weights.count; i++) {
        single = weights.getX(i) === 1 && weights.getY(i) === 0 && weights.getZ(i) === 0 && weights.getW(i) === 0;
      }
      rigid.set(geometry, single);
    }
    result &&= single;
  });
  return result;
}

/** Keep three's skin position/normal math, omitting three unused matrix fetches. */
export function patchRigidSkinning(material: Material) {
  const base = material.onBeforeCompile.bind(material);
  const key = `${material.customProgramCacheKey()}|rigid-skin`;
  material.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <skinbase_vertex>', /* glsl */ `
      #ifdef USE_SKINNING
        mat4 boneMatX = getBoneMatrix(skinIndex.x);
        mat4 boneMatY = mat4(0.0);
        mat4 boneMatZ = mat4(0.0);
        mat4 boneMatW = mat4(0.0);
      #endif
    `);
  };
  material.customProgramCacheKey = () => key;
}
