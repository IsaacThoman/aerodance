import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeBox, facadeCylinderUVs, isStyleKey, type CityMaterialKey, type CityMaterials } from './facades.ts';
import type { WorldRandom } from './random.ts';
import type { TreeKind, TreeSpec } from './trees.ts';

/** Axis-aligned tower bounds for sun occlusion: [x0, x1, top, z0, z1] (bottom is the ground). */
export type Occluder = [x0: number, x1: number, y1: number, z0: number, z1: number];

/**
 * Collects the static city geometry per material (merged into one mesh each at the end),
 * the trees planted on and around buildings, and the towers' occlusion boxes.
 */
export class CityBuilder {
  readonly random: WorldRandom;
  /** When true, geometry is generated (to keep the random stream in step) but thrown away. */
  sink = false;
  /** Where tree() plants. */
  treeList: TreeSpec[];
  readonly occluders: Occluder[] = [];
  private readonly geo = new Map<CityMaterialKey, THREE.BufferGeometry[]>();

  constructor(random: WorldRandom, trees: TreeSpec[]) {
    this.random = random;
    this.treeList = trees;
  }

  add(k: CityMaterialKey, g: THREE.BufferGeometry) {
    if (this.sink) { g.dispose(); return; }
    let list = this.geo.get(k);
    if (!list) this.geo.set(k, list = []);
    list.push(g);
  }

  box(k: CityMaterialKey, x: number, y: number, z: number, w: number, h: number, d: number, ry = 0) {
    const g = isStyleKey(k) ? facadeBox(w, h, d) : new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z); this.add(k, g);
  }

  cyl(k: CityMaterialKey, x: number, y: number, z: number, r: number, h: number, seg = 28, r2 = r) {
    const g = new THREE.CylinderGeometry(r2, r, h, seg, 1);
    if (isStyleKey(k)) facadeCylinderUVs(g, r, h, seg);
    if (seg === 8) g.rotateY(Math.PI / 8);
    g.translate(x, y, z); this.add(k, g);
  }

  tree(x: number, z: number, s: number, kind: TreeKind = 'round', y = 0) {
    if (!this.sink) this.treeList.push({ x, y, z, s, kind });
  }

  occ(b: Occluder) {
    if (!this.sink) this.occluders.push(b);
  }

  /** Merges everything collected so far into one mesh per material. */
  merge(root: THREE.Object3D, materials: CityMaterials) {
    for (const [k, geos] of this.geo) {
      const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
      const g = mergeGeometries(list);
      geos.forEach((x) => x.dispose());
      const m = new THREE.Mesh(g, materials[k]);
      m.castShadow = m.receiveShadow = k !== 'red';
      root.add(m);
    }
    this.geo.clear();
  }
}
