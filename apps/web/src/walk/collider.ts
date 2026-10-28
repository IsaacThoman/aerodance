import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Where a ray met a surface: how far along it, and the surface's normal facing back along it. */
export interface Hit {
  distance: number;
  normal: THREE.Vector3;
}

/** What the walker (walker.ts) bumps into and stands on. */
export interface Collider {
  /** The nearest surface along the ray from `origin` (dir normalized), up to `far` away. */
  cast(origin: THREE.Vector3, dir: THREE.Vector3, far: number): Hit | null;
}

// Instanced meshes with more copies than this are foliage or particles: grass, petals, motes.
const MAX_INSTANCES = 3000;

// What looks solid: not a glow, a sky dome seen from inside, or see-through (mostly, or drawn
// without depth like haze and light). Opaque ground drawn without depth, behind everything
// else, is solid: a backdrop's mirror lake, say.
const solidMaterial = (m: THREE.Material | undefined) => !!m && m.visible && m.blending !== THREE.AdditiveBlending
  && m.side !== THREE.BackSide && !(m.transparent && (m.opacity < 0.5 || !m.depthWrite)) && !(m as THREE.MeshBasicMaterial).wireframe;

/** Whether the walker collides with `object`: a mesh that looks solid (not the dancers, who move). */
export function isSolid(object: THREE.Object3D): object is THREE.Mesh {
  const mesh = object as THREE.Mesh & Partial<THREE.InstancedMesh & THREE.SkinnedMesh>;
  if (!mesh.isMesh || mesh.isSkinnedMesh) return false;
  if (mesh.isInstancedMesh && (mesh.count ?? 0) > MAX_INSTANCES) return false;
  const geometry = mesh.geometry as THREE.BufferGeometry & { isInstancedBufferGeometry?: boolean };
  const position = geometry?.getAttribute('position');
  // Copies placed by a shader (instanced attributes) aren't where the geometry says.
  if (!position || position.count < 3 || geometry.isInstancedBufferGeometry) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some(solidMaterial);
}

/** A solid mesh, or one copy of an instanced one, where it is now. */
interface Piece {
  bvh: MeshBVH;
  matrix: THREE.Matrix4;
  inverse: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  sphere: THREE.Sphere;
}

const _ray = new THREE.Ray();
const _local = new THREE.Ray();
const _point = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/**
 * Collision against everything solid (isSolid) under a scene's root, by ray casts through a
 * bounding volume hierarchy (three-mesh-bvh) of each mesh's geometry, so a city of a million
 * triangles costs microseconds a ray. The BVHs are built once per geometry, beside it: the
 * geometry itself is left as it is (an `indirect` BVH doesn't reorder its index).
 *
 * refresh() picks up what's been added or hidden since (call it now and then); focus() narrows
 * the casts to what's near the walker, where things are this frame. Both sides of every face
 * count, and shaders that move vertices (waves, swaying grass) aren't seen.
 *
 * const collider = new SceneCollider(scene);
 * collider.focus(feet, 4);
 * const hit = collider.cast(origin, down, 2);
 */
export class SceneCollider implements Collider {
  private readonly bvhs = new WeakMap<THREE.BufferGeometry, MeshBVH | null>();
  private solids: THREE.Mesh[] = [];
  private pieces: Piece[] = [];
  private readonly pool: Piece[] = [];

  private readonly root: THREE.Object3D;

  constructor(root: THREE.Object3D) {
    this.root = root;
    this.refresh();
  }

  /** How many meshes it collides with. */
  get size(): number { return this.solids.length; }

  refresh(): void {
    const solids: THREE.Mesh[] = [];
    this.root.updateMatrixWorld();
    this.root.traverseVisible((object) => {
      if (isSolid(object) && this.bvhFor(object.geometry)) solids.push(object);
    });
    this.solids = solids;
  }

  private bvhFor(geometry: THREE.BufferGeometry): MeshBVH | null {
    let bvh = this.bvhs.get(geometry);
    if (bvh !== undefined) return bvh;
    try {
      bvh = new MeshBVH(geometry, { indirect: true });
    } catch (error) {
      console.warn('[walk] a mesh has no collision:', error);
      bvh = null;
    }
    this.bvhs.set(geometry, bvh);
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    return bvh;
  }

  /** Casts only see what's within `radius` of `center`, where it is now. */
  focus(center: THREE.Vector3, radius: number): void {
    this.pool.push(...this.pieces);
    this.pieces = [];
    for (const mesh of this.solids) {
      const bvh = this.bvhs.get(mesh.geometry);
      const bounds = mesh.geometry.boundingSphere;
      if (!bvh || !bounds) continue;
      const near = (matrix: THREE.Matrix4) => {
        _sphere.copy(bounds).applyMatrix4(matrix);
        return _sphere.center.distanceTo(center) <= radius + _sphere.radius;
      };
      if (mesh instanceof THREE.InstancedMesh) {
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, _matrix);
          _matrix.premultiply(mesh.matrixWorld);
          if (near(_matrix)) this.add(bvh, _matrix);
        }
      } else if (near(mesh.matrixWorld)) {
        this.add(bvh, mesh.matrixWorld);
      }
    }
  }

  private add(bvh: MeshBVH, matrix: THREE.Matrix4) {
    const piece = this.pool.pop() ?? { bvh, matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4(), normalMatrix: new THREE.Matrix3(), sphere: new THREE.Sphere() };
    piece.bvh = bvh;
    piece.matrix.copy(matrix);
    piece.inverse.copy(matrix).invert();
    piece.normalMatrix.getNormalMatrix(matrix);
    piece.sphere.copy(_sphere);
    this.pieces.push(piece);
  }

  cast(origin: THREE.Vector3, dir: THREE.Vector3, far: number): Hit | null {
    _ray.set(origin, dir);
    let best: Hit | null = null;
    let nearest = far;
    for (const piece of this.pieces) {
      const { sphere } = piece;
      if (_ray.distanceSqToPoint(sphere.center) > sphere.radius * sphere.radius) continue;
      if (origin.distanceTo(sphere.center) - sphere.radius > nearest) continue;
      _local.copy(_ray).applyMatrix4(piece.inverse);
      const hit = piece.bvh.raycastFirst(_local, THREE.DoubleSide);
      if (!hit?.face) continue;
      const distance = _point.copy(hit.point).applyMatrix4(piece.matrix).distanceTo(origin);
      if (distance > nearest) continue;
      nearest = distance;
      const normal = hit.face.normal.clone().applyMatrix3(piece.normalMatrix).normalize();
      if (normal.dot(dir) > 0) normal.negate();
      best = { distance, normal };
    }
    return best;
  }
}
