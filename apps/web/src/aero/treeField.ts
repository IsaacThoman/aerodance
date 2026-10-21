import * as THREE from 'three';

/** Where trees get coarser: camera distances (m) to a cell's nearest tree for detail levels 1 and 2. */
export interface TreeLod {
  near: number;
  far: number;
}

/** A static tree for the field: its position and a radius that holds its trunk and canopy. */
export interface FieldTree { x: number; y: number; z: number; radius: number }

/** One batch of trees of one model, and the instanced meshes that draw it at each detail level. */
export interface FieldGroup {
  trees: readonly FieldTree[];
  /** Each tree's instance matrix (16 floats) and colour (3 floats, or null), in `trees` order. */
  matrices: Float32Array;
  colors: Float32Array | null;
  /**
   * Per detail level (0 as modelled, 1, 2), the meshes each tree is drawn with there (say a trunk
   * and a canopy). Groups may share a mesh; it needs room for all their trees.
   */
  levels: readonly (readonly THREE.InstancedMesh[])[];
}

interface Cell { x: number; y: number; z: number; r: number; box: THREE.Box3; level: number }
interface PackedGroup {
  matrices: Float32Array;
  colors: Float32Array | null;
  /** [cell, first, end) triples into matrices/colors, sorted by cell. */
  runs: Int32Array;
  levels: readonly (readonly THREE.InstancedMesh[])[];
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
  private readonly meshes = new Set<THREE.InstancedMesh>();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly plans = new Map<THREE.InstancedMesh, number[]>();
  /** How many times cells changed, and how many mesh buffers that rewrote (diagnostics). */
  repacks = 0;
  uploads = 0;

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
    for (const meshes of group.levels) for (const m of meshes) { m.count = 0; m.frustumCulled = false; this.meshes.add(m); }
    this.groups.push({ matrices, colors, runs: Int32Array.from(runs), levels: group.levels });
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
    // Which runs each mesh draws now, in order; a mesh whose list is unchanged keeps its buffers
    // (each upload goes to the GPU, which can cost more than the copying).
    const plans = new Map<THREE.InstancedMesh, number[]>();
    for (const m of this.meshes) plans.set(m, []);
    this.groups.forEach((g, gi) => {
      for (let k = 0; k < g.runs.length; k += 3) {
        const level = this.cells[g.runs[k]].level;
        if (level >= 0) for (const m of g.levels[level]) plans.get(m)?.push(gi, k);
      }
    });
    for (const [m, plan] of plans) {
      const last = this.plans.get(m);
      if (last && last.length === plan.length && last.every((v, i) => v === plan[i])) continue;
      this.plans.set(m, plan);
      let count = 0;
      for (let i = 0; i < plan.length; i += 2) {
        const g = this.groups[plan[i]], k = plan[i + 1], first = g.runs[k + 1], end = g.runs[k + 2];
        (m.instanceMatrix.array as Float32Array).set(g.matrices.subarray(first * 16, end * 16), count * 16);
        if (g.colors && m.instanceColor) (m.instanceColor.array as Float32Array).set(g.colors.subarray(first * 3, end * 3), count * 3);
        count += end - first;
      }
      m.count = count;
      m.visible = count > 0;
      m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, count * 16); m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) { m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, count * 3); m.instanceColor.needsUpdate = true; }
      this.uploads++;
    }
  }
}
