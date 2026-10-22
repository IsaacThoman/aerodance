import * as THREE from 'three';

export const TEAR_DURATION = 0.62;

interface Skin {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  rest: THREE.BufferAttribute;
  side: number;
  opacity: number;
}

const smooth = (a: number, b: number, t: number) => THREE.MathUtils.smoothstep(t, a, b);
// A shared zigzag through head and torso, rather than a separate cut through each body part.
const seam = (y: number) => (2 / Math.PI) * Math.asin(Math.sin(y * 19)) * 0.065;

/** The actual posed skin tears into two ragged halves, recoils and crumples like latex. */
export class BalloonTear {
  readonly group = new THREE.Group();
  private skins: Skin[] = [];
  private centre = new THREE.Vector3();

  constructor() {
    this.group.name = 'balloon-tear';
    this.group.visible = false;
  }

  /** Capture in the dancer's floor coordinates, including its current pose and mirror. */
  capture(source: THREE.Object3D) {
    this.dispose();
    source.updateWorldMatrix(true, true);
    const toLocal = source.matrixWorld.clone().invert();
    const snapshots: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    source.traverse((object) => {
      // Entrance bubbles and the puck are ordinary meshes; only capture the character.
      if (!(object instanceof THREE.SkinnedMesh) || !object.visible || Array.isArray(object.material)) return;
      object.skeleton.update();
      const matrix = new THREE.Matrix4().multiplyMatrices(toLocal, object.matrixWorld);
      const geometry = object.geometry.clone();
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        object.getVertexPosition(i, point).applyMatrix4(matrix);
        position.setXYZ(i, point.x, point.y, point.z);
        bounds.expandByPoint(point);
      }
      // The menu mirrors the dancer. Correct winding before rebuilding the posed normals.
      const index = geometry.index;
      if (index && matrix.determinant() < 0) {
        for (let i = 0; i < index.count; i += 3) {
          const b = index.getX(i + 1);
          index.setX(i + 1, index.getX(i + 2));
          index.setX(i + 2, b);
        }
      }
      geometry.computeVertexNormals();
      snapshots.push({ geometry, material: object.material });
    });
    if (bounds.isEmpty()) return;
    bounds.getCenter(this.centre);

    for (const { geometry, material } of snapshots) {
      const position = geometry.getAttribute('position');
      const indices: number[][] = [[], []];
      const count = geometry.index?.count ?? position.count;
      for (let i = 0; i < count; i += 3) {
        const a = geometry.index?.getX(i) ?? i;
        const b = geometry.index?.getX(i + 1) ?? i + 1;
        const c = geometry.index?.getX(i + 2) ?? i + 2;
        const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
        const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
        indices[x < this.centre.x + seam(y) ? 0 : 1].push(a, b, c);
      }
      for (let half = 0; half < 2; half++) {
        if (!indices[half].length) continue;
        const skin = geometry.clone();
        skin.setIndex(indices[half]);
        const latex = material.clone();
        // Material.clone does not retain the gel's height shading hook.
        latex.onBeforeCompile = material.onBeforeCompile;
        latex.customProgramCacheKey = () => material.customProgramCacheKey();
        latex.side = THREE.DoubleSide;
        latex.transparent = true;
        latex.depthWrite = false;
        const mesh = new THREE.Mesh(skin, latex);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.skins.push({ mesh, rest: position.clone() as THREE.BufferAttribute, side: half ? 1 : -1, opacity: material.opacity });
      }
      geometry.dispose();
    }
    this.group.visible = this.skins.length > 0;
  }

  /** Absolute age makes interruption and a rapid remove/add/remove deterministic. */
  update(age: number) {
    this.group.visible = this.skins.length > 0 && age < TEAR_DURATION;
    if (!this.group.visible) return;
    const recoil = smooth(0.025, 0.24, age);
    const crumple = smooth(0.16, TEAR_DURATION, age);
    const fade = 1 - smooth(0.44, TEAR_DURATION, age);
    const { x: cx, y: cy, z: cz } = this.centre;
    for (const { mesh, rest, side, opacity } of this.skins) {
      const position = mesh.geometry.getAttribute('position');
      for (let i = 0; i < rest.count; i++) {
        const x = rest.getX(i) - cx;
        const y = rest.getY(i) - cy;
        const z = rest.getZ(i) - cz;
        // The puncture runs up and down from the belly in the first few frames.
        const open = 1 - Math.exp(-Math.max(0, age - Math.abs(y) * 0.018) * 32);
        const curl = y * 3.5 + age * 22;
        position.setXYZ(i,
          cx + side * (0.45 + 0.5 * open) + (x - side * 0.45) * (1 - recoil * 0.65) * (1 - crumple * 0.7)
            + side * Math.sin(curl) * recoil * 0.13 * (1 - crumple * 0.5),
          Math.max(Math.min(rest.getY(i), 0.035), cy + y * (1 - recoil * 0.6) * (1 - crumple * 0.7) - 5 * age * age
            + (Math.cos(curl) - 1) * recoil * 0.09),
          cz + z * (1 - recoil * 0.94) + Math.sin(y * 4 - age * 25) * recoil * 0.16 * (1 - crumple * 0.5),
        );
      }
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.material.opacity = opacity * fade;
    }
  }

  dispose() {
    for (const { mesh } of this.skins) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.skins = [];
    this.group.clear();
    this.group.visible = false;
  }
}
