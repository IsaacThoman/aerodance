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

/** One draw for the visible cells of a static, opaque instance field. Cell bounds and instance
 * order are the same as splitIntoCells; only visibility changes rewrite the GPU buffers.
 * Call with includeAll while rebuilding shadows; reflected fields also need the mirror view.
 */
export class InstanceCellBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly cells: { sphere: THREE.Sphere; first: number; end: number; visible: boolean }[] = [];
  private readonly matrices: Float32Array;
  private readonly colors: Float32Array | null;
  private readonly bounds = new THREE.Box3();

  constructor(source: THREE.InstancedMesh, cellSize: number) {
    const cells = splitIntoCells(source, cellSize);
    this.mesh = source;
    this.matrices = new Float32Array(source.count * 16);
    this.colors = source.instanceColor ? new Float32Array(source.count * 3) : null;
    let first = 0;
    for (const cell of cells) {
      this.matrices.set(cell.instanceMatrix.array, first * 16);
      if (this.colors && cell.instanceColor) this.colors.set(cell.instanceColor.array, first * 3);
      this.cells.push({ sphere: cell.boundingSphere!.clone(), first, end: first + cell.count, visible: false });
      this.bounds.union(cell.boundingSphere!.getBoundingBox(new THREE.Box3()));
      first += cell.count;
      cell.dispose();
    }
    source.count = 0;
    source.frustumCulled = false;
    source.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    source.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  }

  update(frustum: THREE.Frustum, includeAll = false) {
    // Once an entire field is behind the camera, avoid retesting every one of its cells.
    // The box contains the cell spheres themselves, preserving their exact culling decisions.
    if (!includeAll && !frustum.intersectsBox(this.bounds)) {
      if (this.mesh.count) for (const cell of this.cells) cell.visible = false;
      this.mesh.count = 0; this.mesh.visible = false;
      return;
    }
    let changed = false;
    for (const cell of this.cells) {
      const visible = includeAll || frustum.intersectsSphere(cell.sphere);
      if (visible !== cell.visible) { cell.visible = visible; changed = true; }
    }
    if (!changed) { this.mesh.visible = this.mesh.count > 0; return; }
    let count = 0;
    const { mesh, matrices, colors } = this;
    for (const cell of this.cells) if (cell.visible) {
      (mesh.instanceMatrix.array as Float32Array).set(matrices.subarray(cell.first * 16, cell.end * 16), count * 16);
      if (colors && mesh.instanceColor) (mesh.instanceColor.array as Float32Array).set(colors.subarray(cell.first * 3, cell.end * 3), count * 3);
      count += cell.end - cell.first;
    }
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.instanceMatrix.clearUpdateRanges();
    if (count) { mesh.instanceMatrix.addUpdateRange(0, count * 16); mesh.instanceMatrix.needsUpdate = true; }
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      if (count) { mesh.instanceColor.addUpdateRange(0, count * 3); mesh.instanceColor.needsUpdate = true; }
    }
  }
}

export interface IndexCell { sphere: THREE.Sphere; indices: Uint32Array }

/** Grass keeps its original vertex IDs (the shader uses them to address the blade texture),
 * but draws the indices of all visible cells together. No upload until the visible set changes.
 */
export class IndexCellBatch {
  readonly geometry = new THREE.BufferGeometry();
  private readonly cells: (IndexCell & { visible: boolean })[];
  private readonly bounds = new THREE.Box3();

  constructor(cells: readonly IndexCell[]) {
    this.cells = cells.map((cell) => ({ ...cell, visible: false }));
    for (const cell of cells) this.bounds.union(cell.sphere.getBoundingBox(new THREE.Box3()));
    this.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(cells.reduce((n, c) => n + c.indices.length, 0)), 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
  }

  update(frustum: THREE.Frustum) {
    if (!frustum.intersectsBox(this.bounds)) {
      if (this.geometry.drawRange.count) for (const cell of this.cells) cell.visible = false;
      this.geometry.setDrawRange(0, 0);
      return;
    }
    let changed = false;
    for (const cell of this.cells) {
      const visible = frustum.intersectsSphere(cell.sphere);
      if (visible !== cell.visible) { cell.visible = visible; changed = true; }
    }
    if (!changed) return;
    const index = this.geometry.index!;
    let count = 0;
    for (const cell of this.cells) if (cell.visible) {
      (index.array as Uint32Array).set(cell.indices, count);
      count += cell.indices.length;
    }
    this.geometry.setDrawRange(0, count);
    index.clearUpdateRanges();
    if (count) { index.addUpdateRange(0, count); index.needsUpdate = true; }
  }
}
