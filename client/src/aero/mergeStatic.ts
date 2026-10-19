import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type Static = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;

const plainRender = THREE.Object3D.prototype.onBeforeRender;
const plainCompile = THREE.Material.prototype.onBeforeCompile;

/**
 * Marks `object` and its descendants as never moving: computes each local matrix from its
 * position, rotation and scale, then stops three.js recomputing it every frame. (Turning
 * `matrixAutoUpdate` off without this freezes whatever matrix was last computed, often identity.)
 */
export function freezeMatrices(object: THREE.Object3D) {
  object.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
}

/** True for a plain opaque mesh that never moves (it and its parents keep their matrices). */
function mergeable(o: THREE.Object3D, top: THREE.Object3D): o is Static {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || o instanceof THREE.SkinnedMesh) return false;
  if (o.onBeforeRender !== plainRender || o.morphTargetInfluences || !o.visible) return false;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  // (Custom shaders may depend on the geometry as it is, e.g. on gl_VertexID.)
  if (!o.geometry.attributes.position || mats.some((m) => m.transparent || m.alphaTest > 0 || m.onBeforeCompile !== plainCompile || m instanceof THREE.ShaderMaterial)) return false;
  for (let p: THREE.Object3D | null = o; p; p = p === top ? null : p.parent) if (p.matrixAutoUpdate) return false;
  return true;
}

/** The mesh's geometry transformed by `matrix`, one piece per material it uses. */
function pieces(m: Static & { material: THREE.Material | THREE.Material[] }, matrix: THREE.Matrix4) {
  const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(matrix);
  if (!Array.isArray(m.material)) return [{ material: m.material, geometry: g }];
  const out = m.geometry.groups.map((group) => {
    const part = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const a = attr as THREE.BufferAttribute;
      part.setAttribute(name, new THREE.BufferAttribute(a.array.slice(group.start * a.itemSize, (group.start + group.count) * a.itemSize), a.itemSize, a.normalized));
    }
    return { material: (m.material as THREE.Material[])[group.materialIndex ?? 0], geometry: part };
  });
  g.dispose();
  return out;
}

/**
 * Static batching: merges the plain, opaque meshes among `objects` (and their descendants) that
 * never move relative to `parent` and share a material and render settings into one mesh each,
 * child of `parent`, with their transforms baked in. Each mesh three.js draws costs JavaScript
 * time on every frame, which without a JIT (tvOS) is the main cost of a scene. Returns the
 * top-level objects to keep in place of `objects`.
 */
export function mergeStatic(parent: THREE.Object3D, objects: readonly THREE.Object3D[]): THREE.Object3D[] {
  const groups = new Map<string, { material: THREE.Material; meshes: Static[]; geos: THREE.BufferGeometry[] }>();
  parent.updateMatrixWorld(true);
  const toParent = parent.matrixWorld.clone().invert(), local = new THREE.Matrix4();
  for (const top of objects) {
    top.updateMatrixWorld(true);
    top.traverse((o) => {
      if (!mergeable(o, top)) return;
      local.multiplyMatrices(toParent, o.matrixWorld);
      // A mirrored mesh would turn its triangles over once its transform is baked in.
      if (local.determinant() <= 0) return;
      for (const { material, geometry } of pieces(o, local)) {
        const key = [material.uuid, o.castShadow, o.receiveShadow, o.renderOrder, o.layers.mask, Object.keys(geometry.attributes).sort().join()].join('|');
        let g = groups.get(key);
        if (!g) groups.set(key, g = { material, meshes: [], geos: [] });
        if (!g.meshes.includes(o)) g.meshes.push(o);
        g.geos.push(geometry);
      }
    });
  }
  const removed = new Set<THREE.Object3D>(), added: THREE.Object3D[] = [];
  for (const { material, meshes, geos } of groups.values()) {
    // Where it saves draws. (A multi-material mesh is always split up into its materials.)
    const merge = geos.length > 1 || meshes.some((m) => Array.isArray(m.material));
    const geometry = merge ? mergeGeometries(geos) : null;
    geos.forEach((g) => g.dispose());
    if (!geometry) continue;
    const merged = new THREE.Mesh(geometry, material);
    const [first] = meshes;
    Object.assign(merged, { castShadow: first.castShadow, receiveShadow: first.receiveShadow, renderOrder: first.renderOrder, matrixAutoUpdate: false });
    merged.layers.mask = first.layers.mask;
    merged.updateMatrix(); merged.matrixWorldNeedsUpdate = true;
    parent.add(merged);
    added.push(merged);
    for (const m of meshes) removed.add(m);
  }
  // (Their geometry was never uploaded; it may be shared with meshes that stay.)
  for (const m of removed) m.removeFromParent();
  return [...objects.filter((o) => !removed.has(o)), ...added];
}
