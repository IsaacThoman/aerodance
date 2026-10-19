import * as THREE from 'three';

/**
 * Splits a static InstancedMesh into one InstancedMesh per square cell of the ground (by
 * instance position), sharing its geometry and material, so three.js culls a field of grass or
 * flowers piece by piece instead of drawing all of it whenever any of it is in view. Instances
 * keep their order within a cell. The original mesh is left empty for the caller to drop.
 */
export function splitIntoCells(mesh: THREE.InstancedMesh, cellSize: number): THREE.InstancedMesh[] {
  const n = mesh.count, m = mesh.instanceMatrix.array, c = mesh.instanceColor?.array;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(m[i * 16 + 12] / cellSize)},${Math.floor(m[i * 16 + 14] / cellSize)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, list = []);
    list.push(i);
  }
  return [...cells.values()].map((list) => {
    const part = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
    const pm = part.instanceMatrix.array as Float32Array;
    list.forEach((i, k) => pm.set(m.subarray(i * 16, i * 16 + 16), k * 16));
    if (c) {
      part.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
      const pc = part.instanceColor.array as Float32Array;
      list.forEach((i, k) => pc.set(c.subarray(i * 3, i * 3 + 3), k * 3));
    }
    part.computeBoundingSphere();
    for (const k of ['castShadow', 'receiveShadow', 'renderOrder', 'name'] as const) (part as unknown as Record<string, unknown>)[k] = mesh[k];
    return part;
  });
}
