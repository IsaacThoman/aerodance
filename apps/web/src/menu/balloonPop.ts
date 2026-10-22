import * as THREE from 'three';

const FLAPS = 6;
const SECTOR = Math.PI * 2 / FLAPS;
const BODY_Y = 1.5;
const DURATION = 0.62;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

interface TriangleBatch {
  positions: number[];
  normals: number[];
  colors: number[];
}

interface Flap {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>;
  rest: Float32Array;
  normals: Float32Array;
  dx: number;
  dy: number;
}

const isMesh = (object: THREE.Object3D): object is THREE.Mesh => 'isMesh' in object && object.isMesh === true;
const isSkinned = (mesh: THREE.Mesh): mesh is THREE.SkinnedMesh => 'isSkinnedMesh' in mesh && mesh.isSkinnedMesh === true;

function visibleWithin(object: THREE.Object3D, source: THREE.Group) {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
    if (!parent.visible) return false;
    if (parent === source) return true;
  }
  return false;
}

/**
 * A posed copy of the dancer's own skin, torn into six broad, jagged flaps. Nothing is
 * substituted at the puncture: every original triangle starts in exactly the same place.
 * The owner positions this group beside the source, using the source's transform.
 */
export class BalloonPop {
  readonly group = new THREE.Group();
  private flaps: Flap[] = [];
  private materials: THREE.Material[] = [];
  private opacities: number[] = [];
  private time = Infinity;

  constructor() {
    this.group.name = 'balloon-tear';
    this.group.visible = false;
  }

  start(source: THREE.Group): boolean {
    this.reset();
    source.updateWorldMatrix(true, true);
    const inverse = source.matrixWorld.clone().invert();
    const materialIndices = new Map<THREE.Material, number>();
    const batches = Array.from({ length: FLAPS }, () => new Map<number, TriangleBatch>());
    const relative = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    const skinMatrix = new THREE.Matrix4();
    const boneMatrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();

    source.traverse((object) => {
      if (!isMesh(object) || !visibleWithin(object, source)) return;
      const mesh = object;
      const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // Character's ink replacement is unnamed; the two eye meshes retain their GLB names.
      // Entrance bubbles and the floor are deliberately excluded, even during an interrupted arrival.
      const allowed = sourceMaterials.map((material) => material.visible && material.opacity > 0.001
        && (material.name === 'AquaGel' || material.name === 'Ink' || /^Eye[._]?/i.test(mesh.name)));
      if (!allowed.some(Boolean)) return;
      const geometry = mesh.geometry;
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      const colors = geometry.getAttribute('color');
      if (!positions) return;
      const skinned = isSkinned(mesh);
      if (skinned) {
        // updateWorldMatrix alone does not run SkinnedMesh's bind-matrix update override.
        mesh.updateMatrixWorld(true);
        mesh.skeleton.update();
      }
      relative.multiplyMatrices(inverse, mesh.matrixWorld);
      const mirrored = relative.determinant() < 0;
      const posed = new Float32Array(positions.count * 3);
      const posedNormals = new Float32Array(positions.count * 3);
      const skinIndices = geometry.getAttribute('skinIndex');
      const skinWeights = geometry.getAttribute('skinWeight');
      const rigidNormals = new Map<number, THREE.Matrix3>();
      const staticNormal = new THREE.Matrix3().getNormalMatrix(relative);
      for (let vertex = 0; vertex < positions.count; vertex++) {
        mesh.getVertexPosition(vertex, position).applyMatrix4(relative);
        const offset = vertex * 3;
        posed[offset] = position.x;
        posed[offset + 1] = position.y;
        posed[offset + 2] = position.z;
        if (normals) normal.fromBufferAttribute(normals, vertex);
        else normal.set(0, 0, 1);
        if (skinned && skinIndices && skinWeights) {
          // Every current character vertex belongs to one rigid bone. Reuse its normal
          // transform instead of inverting a matrix for every vertex on the first click.
          if (skinWeights.getX(vertex) === 1 && skinWeights.getY(vertex) === 0 && skinWeights.getZ(vertex) === 0 && skinWeights.getW(vertex) === 0) {
            const bone = skinIndices.getX(vertex);
            let cached = rigidNormals.get(bone);
            if (!cached) {
              skinMatrix.fromArray(mesh.skeleton.boneMatrices!, bone * 16)
                .premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix).premultiply(relative);
              cached = new THREE.Matrix3().getNormalMatrix(skinMatrix);
              rigidNormals.set(bone, cached);
            }
            normal.applyNormalMatrix(cached);
          } else {
            skinMatrix.elements.fill(0);
            for (let influence = 0; influence < 4; influence++) {
              const weight = skinWeights.getComponent(vertex, influence);
              if (weight === 0) continue;
              boneMatrix.fromArray(mesh.skeleton.boneMatrices!, skinIndices.getComponent(vertex, influence) * 16);
              for (let element = 0; element < 16; element++) skinMatrix.elements[element] += boneMatrix.elements[element] * weight;
            }
            skinMatrix.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix).premultiply(relative);
            normal.applyNormalMatrix(normalMatrix.getNormalMatrix(skinMatrix));
          }
        } else normal.applyNormalMatrix(staticNormal);
        posedNormals[offset] = normal.x;
        posedNormals[offset + 1] = normal.y;
        posedNormals[offset + 2] = normal.z;
      }

      const index = geometry.getIndex();
      const count = index ? index.count : positions.count;
      for (let triangle = 0; triangle + 2 < count; triangle += 3) {
        const sourceGroup = geometry.groups.find((group) => triangle >= group.start && triangle < group.start + group.count);
        const sourceMaterial = sourceGroup?.materialIndex ?? 0;
        if (!allowed[sourceMaterial]) continue;
        const material = sourceMaterials[sourceMaterial];
        let materialIndex = materialIndices.get(material);
        if (materialIndex === undefined) {
          materialIndex = this.materials.length;
          materialIndices.set(material, materialIndex);
          const copy = material.clone();
          // The gel's custom shader expects gelHeight on the live mesh. The copied shell uses
          // its baked vertex colors and the same physical material, without that extra shader.
          copy.onBeforeCompile = () => {};
          copy.side = THREE.DoubleSide;
          copy.forceSinglePass = true;
          this.materials.push(copy);
          this.opacities.push(copy.opacity);
        }
        const a = index ? index.getX(triangle) : triangle;
        const b = index ? index.getX(triangle + 1) : triangle + 1;
        const c = index ? index.getX(triangle + 2) : triangle + 2;
        const x = (posed[a * 3] + posed[b * 3] + posed[c * 3]) / 3;
        const y = (posed[a * 3 + 1] + posed[b * 3 + 1] + posed[c * 3 + 1]) / 3 - BODY_Y;
        const radius = Math.hypot(x, y);
        // A few uneven teeth along each radial cut, rather than a confetti-like triangle spray.
        const angle = Math.atan2(y, x) + Math.sin(radius * 13) * 0.12 + Math.sin(radius * 29) * 0.035;
        const flap = Math.floor(((angle + Math.PI * 4) % (Math.PI * 2)) / SECTOR);
        let batch = batches[flap].get(materialIndex);
        if (!batch) {
          batch = { positions: [], normals: [], colors: [] };
          batches[flap].set(materialIndex, batch);
        }
        // Baking a mirrored character changes handedness. Reverse each triangle so its skin
        // still faces out, including when the curled flap exposes its reverse side.
        for (let corner = 0; corner < 3; corner++) {
          const vertex = corner === 0 ? a : corner === 1 ? (mirrored ? c : b) : (mirrored ? b : c);
          const offset = vertex * 3;
          batch.positions.push(posed[offset], posed[offset + 1], posed[offset + 2]);
          batch.normals.push(posedNormals[offset], posedNormals[offset + 1], posedNormals[offset + 2]);
          batch.colors.push(colors ? colors.getX(vertex) : 1, colors ? colors.getY(vertex) : 1, colors ? colors.getZ(vertex) : 1);
        }
      }
    });

    batches.forEach((batch, index) => {
      if (!batch.size) return;
      const positions: number[] = [];
      const normals: number[] = [];
      const colors: number[] = [];
      const geometry = new THREE.BufferGeometry();
      for (const [material, triangles] of batch) {
        geometry.addGroup(positions.length / 3, triangles.positions.length / 3, material);
        for (const value of triangles.positions) positions.push(value);
        for (const value of triangles.normals) normals.push(value);
        for (const value of triangles.colors) colors.push(value);
      }
      const rest = new Float32Array(positions);
      const restNormals = new Float32Array(normals);
      geometry.setAttribute('position', new THREE.BufferAttribute(rest.slice(), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('normal', new THREE.BufferAttribute(restNormals.slice(), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(geometry, this.materials);
      mesh.frustumCulled = false;
      const angle = (index + 0.5) * SECTOR;
      this.flaps.push({ mesh, rest, normals: restNormals, dx: Math.cos(angle), dy: Math.sin(angle) });
      this.group.add(mesh);
    });
    if (!this.flaps.length) {
      this.reset();
      return false;
    }
    this.time = 0;
    this.group.visible = true;
    return true;
  }

  /** Returns true until the last deflated flap has disappeared. */
  update(dt: number): boolean {
    if (!Number.isFinite(this.time)) return false;
    this.time += Math.max(0, dt);
    if (this.time >= DURATION) {
      this.reset();
      return false;
    }
    const recoil = 1 - (1 - clamp(this.time / 0.16)) ** 3;
    const deflate = clamp((this.time - 0.1) / 0.45);
    const collapse = deflate * deflate * (3 - 2 * deflate);
    const fade = 1 - clamp((this.time - 0.42) / 0.2);
    this.materials.forEach((material, index) => { material.opacity = this.opacities[index] * fade; });
    for (const flap of this.flaps) {
      const positions = flap.mesh.geometry.getAttribute('position');
      const normals = flap.mesh.geometry.getAttribute('normal');
      const { dx, dy, rest } = flap;
      for (let offset = 0; offset < rest.length; offset += 3) {
        const x = rest[offset];
        const y = rest[offset + 1] - BODY_Y;
        const z = rest[offset + 2];
        const radius = Math.hypot(x, y);
        const tip = 1 - clamp(radius / 1.8);
        const front = clamp((this.time - radius * 0.025) / 0.08);
        const opening = front * front * (3 - 2 * front);
        const radial = x * dx + y * dy;
        const tangent = -x * dy + y * dx;
        const curl = opening * tip * 1.8 + collapse * 0.8;
        const r = radial + opening * (0.2 + tip * 0.3) + collapse * (0.45 - radial * 0.68);
        const width = 1 - collapse * 0.78;
        const t = tangent * width;
        const depth = 1 - collapse * 0.91;
        const bent = z * depth + Math.sin(curl) * (0.2 + tip * 0.24) * recoil;
        const shrink = 1 - collapse * 0.55;
        positions.setXYZ(offset / 3,
          (dx * r - dy * t) * shrink,
          BODY_Y + (dy * r + dx * t) * shrink - 4.2 * this.time * this.time,
          bent * shrink,
        );
        // Rotate the original smooth normal with the rolling skin. Keeping the original
        // normals avoids introducing faceted shading along the mesh's existing triangles.
        const nx = flap.normals[offset];
        const ny = flap.normals[offset + 1];
        const nz = flap.normals[offset + 2];
        const nr = nx * dx + ny * dy;
        const nt = (-nx * dy + ny * dx) / width;
        const rotatedR = nr * Math.cos(curl) - nz * Math.sin(curl);
        const rotatedZ = (nr * Math.sin(curl) + nz * Math.cos(curl)) / depth;
        const length = Math.hypot(rotatedR, nt, rotatedZ) || 1;
        normals.setXYZ(offset / 3, (dx * rotatedR - dy * nt) / length, (dy * rotatedR + dx * nt) / length, rotatedZ / length);
      }
      positions.needsUpdate = true;
      normals.needsUpdate = true;
    }
    return true;
  }

  reset() {
    this.time = Infinity;
    this.group.visible = false;
    this.group.clear();
    this.flaps.forEach((flap) => flap.mesh.geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.flaps = [];
    this.materials = [];
    this.opacities = [];
  }

  dispose() { this.reset(); }
}
