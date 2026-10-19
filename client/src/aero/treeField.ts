import * as THREE from 'three';

/** Where trees get coarser: camera distances (m) to a cell's nearest tree for detail levels 1 and 2. */
export interface TreeLod {
  near: number;
  far: number;
}

/** A static tree for the field: its position and a radius that holds its trunk and canopy. */
export interface FieldTree { x: number; y: number; z: number; radius: number }

/** One instanced batch of trees (one tree model): a mesh per detail level for each of its parts. */
export interface FieldGroup {
  trees: readonly FieldTree[];
  /** Each tree's instance matrix (16 floats) and colour (3 floats, or null), in `trees` order. */
  matrices: Float32Array;
  colors: Float32Array | null;
  /** Per part (trunk, canopy): one InstancedMesh per detail level, each with room for every tree. */
  parts: readonly (readonly THREE.InstancedMesh[])[];
}

interface Cell { x: number; y: number; z: number; r: number; box: THREE.Box3; level: number }
interface PackedGroup {
  matrices: Float32Array;
  colors: Float32Array | null;
  /** [cell, first, end) triples into matrices/colors, sorted by cell. */
  runs: Int32Array;
  parts: readonly (readonly THREE.InstancedMesh[])[];
}

// Hysteresis (m) before a cell goes coarser again, so it doesn't flicker at a boundary.
const LOD_SLACK = 12;
// Extra view angle (radians) around the frustum, so turning doesn't uncover culled trees before
// the cells are repacked.
const VIEW_SLACK = 0.12;

/**
 * Culls and simplifies thousands of instanced trees by area, cheaply enough for an interpreted
 * JavaScript engine: trees are grouped into square cells, and each frame a cell is either out of
 * view or drawn at the detail level its distance calls for. When any cell changes, every group's
 * instance buffers are repacked from per-cell blocks (a few hundred typed-array copies).
 *
 * Cells are tested against the view and its mirror image in the water plane, so trees the lake
 * reflects are kept.
 */
export class TreeField {
  private readonly cells: Cell[] = [];
  private readonly cellIndex = new Map<string, number>();
  private readonly groups: PackedGroup[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  /** How many times the instance buffers have been repacked (diagnostics). */
  repacks = 0;

  private readonly cellSize: number;
  private readonly lod: TreeLod;
  private readonly waterY: number;

  constructor(cellSize: number, lod: TreeLod, waterY = 0.4) {
    this.cellSize = cellSize; this.lod = lod; this.waterY = waterY;
  }

  private cellOf(t: FieldTree) {
    const key = `${Math.floor(t.x / this.cellSize)},${Math.floor(t.z / this.cellSize)}`;
    let i = this.cellIndex.get(key);
    if (i === undefined) {
      i = this.cells.length;
      this.cellIndex.set(key, i);
      this.cells.push({ x: 0, y: 0, z: 0, r: 0, box: new THREE.Box3(), level: -2 });
    }
    const c = this.cells[i];
    c.box.expandByPoint(new THREE.Vector3(t.x - t.radius, t.y - t.radius, t.z - t.radius));
    c.box.expandByPoint(new THREE.Vector3(t.x + t.radius, t.y + t.radius, t.z + t.radius));
    return i;
  }

  add(group: FieldGroup) {
    const n = group.trees.length;
    const cell = group.trees.map((t) => this.cellOf(t));
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => cell[a] - cell[b] || a - b);
    const matrices = new Float32Array(n * 16), colors = group.colors ? new Float32Array(n * 3) : null;
    const runs: number[] = [];
    order.forEach((src, i) => {
      matrices.set(group.matrices.subarray(src * 16, src * 16 + 16), i * 16);
      if (colors && group.colors) colors.set(group.colors.subarray(src * 3, src * 3 + 3), i * 3);
      if (!i || cell[order[i - 1]] !== cell[src]) runs.push(cell[src], i, i + 1);
      else runs[runs.length - 1] = i + 1;
    });
    for (const levels of group.parts) for (const m of levels) { m.count = 0; m.frustumCulled = false; }
    this.groups.push({ matrices, colors, runs: Int32Array.from(runs), parts: group.parts });
    for (const c of this.cells) {
      c.box.getCenter(this.sphere.center);
      Object.assign(c, { x: this.sphere.center.x, y: this.sphere.center.y, z: this.sphere.center.z, r: c.box.getSize(new THREE.Vector3()).length() / 2 });
    }
  }

  private visible(c: Cell, slack: number) {
    const s = this.sphere;
    s.radius = c.r + slack;
    s.center.set(c.x, c.y, c.z);
    if (this.frustum.intersectsSphere(s)) return true;
    s.center.y = 2 * this.waterY - c.y;
    return this.frustum.intersectsSphere(s);
  }

  /** Re-decides every cell for this camera, and repacks the instance buffers if any changed. */
  update(camera: THREE.Camera) {
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const e = camera.position, { near, far } = this.lod;
    let changed = false;
    for (const c of this.cells) {
      const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z, centre = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const d = Math.max(0, centre - c.r);
      let level = -1;
      if (this.visible(c, centre * VIEW_SLACK)) {
        level = d < near ? 0 : d < far ? 1 : 2;
        // Going coarser waits until the cell is LOD_SLACK past the boundary.
        if (c.level >= 0 && level > c.level && d < (level === 1 ? near : far) + LOD_SLACK) level = c.level;
      }
      if (level !== c.level) { c.level = level; changed = true; }
    }
    if (changed) this.repack();
  }

  private repack() {
    this.repacks++;
    const counts = [0, 0, 0];
    for (const g of this.groups) {
      counts.fill(0);
      for (let k = 0; k < g.runs.length; k += 3) {
        const level = this.cells[g.runs[k]].level;
        if (level < 0) continue;
        const first = g.runs[k + 1], end = g.runs[k + 2], at = counts[level];
        for (const levels of g.parts) {
          const m = levels[level];
          (m.instanceMatrix.array as Float32Array).set(g.matrices.subarray(first * 16, end * 16), at * 16);
          if (g.colors && m.instanceColor) (m.instanceColor.array as Float32Array).set(g.colors.subarray(first * 3, end * 3), at * 3);
        }
        counts[level] += end - first;
      }
      for (const levels of g.parts) levels.forEach((m, level) => {
        m.count = counts[level];
        m.visible = counts[level] > 0;
        m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, counts[level] * 16); m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) { m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, counts[level] * 3); m.instanceColor.needsUpdate = true; }
      });
    }
  }
}
