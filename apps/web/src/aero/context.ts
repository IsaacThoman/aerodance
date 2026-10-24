import * as THREE from 'three';
import { createWorldRandom, type WorldRandom } from './random.ts';
import { col } from './util.ts';

export const FOG_BASE = col('#cfeaff'), FOG_WHITE = col('#f4f9ff'), FOG_DENSITY = 0.00032;

interface Disposable { dispose(): void }

/** State shared by every world builder. */
export interface AeroContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Everything the world adds to the scene lives under this group. */
  readonly root: THREE.Group;
  readonly fog: THREE.FogExp2;
  readonly random: WorldRandom;
  readonly sun: THREE.Vector3;
  /** Shared shader clock (seconds). */
  readonly time: THREE.IUniform<number>;
  /** Wraps a canvas as a texture that is disposed with the world. */
  tex(c: HTMLCanvasElement, repeat?: boolean, color?: boolean): THREE.CanvasTexture;
  /**
   * Stacks same-sized canvases into one colour texture array, sampled like tex() would sample
   * each canvas, so one instanced draw can pick a picture per instance (sampler2DArray).
   */
  texArray(canvases: readonly HTMLCanvasElement[]): THREE.DataArrayTexture;
  /** Resources that are not reachable from the scene graph, freed on dispose. */
  readonly disposables: (Disposable | null)[];
  /**
   * Objects whose own position, rotation or scale changes as the world runs. Everything else
   * keeps the matrix it was built with (matrixAutoUpdate off), so three.js doesn't recompose
   * thousands of static matrices every frame.
   */
  readonly moving: THREE.Object3D[];
  /** Puts back the renderer, scene and camera settings the world changed and frees everything. */
  dispose(overlays: THREE.Object3D[]): void;
}

export interface ContextOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

type Drawable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite;
const isDrawable = (o: THREE.Object3D): o is Drawable =>
  o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line || o instanceof THREE.Sprite;

/** Takes over the renderer, scene and camera settings the world needs. */
export function createAeroContext({ renderer, scene, camera }: ContextOptions): AeroContext {
  const prev = {
    autoClear: renderer.autoClear, toneMapping: renderer.toneMapping,
    shadow: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type, shadowAuto: renderer.shadowMap.autoUpdate,
    fog: scene.fog, environment: scene.environment, background: scene.background,
    sceneMatrixAutoUpdate: scene.matrixAutoUpdate,
    fov: camera.fov, near: camera.near, far: camera.far,
  };
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  // The scene itself stays still. Recomposing it on every render forces every descendant's
  // world matrix to be multiplied again, even the frozen meshes and hidden shadow trees.
  if (scene.matrixAutoUpdate) scene.updateMatrix();
  scene.matrixAutoUpdate = false;
  const ANISO = renderer.capabilities.getMaxAnisotropy();
  const root = new THREE.Group();
  root.name = 'aero-world';
  scene.add(root);
  scene.background = null;
  camera.fov = 66; camera.near = 0.3; camera.far = 6500; camera.updateProjectionMatrix();

  const textures: THREE.Texture[] = [];
  function tex(c: HTMLCanvasElement, repeat?: boolean, color = true) {
    const t = new THREE.CanvasTexture(c);
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    textures.push(t);
    return t;
  }

  function texArray(canvases: readonly HTMLCanvasElement[]) {
    const w = canvases[0].width, h = canvases[0].height, row = w * 4;
    const data = new Uint8Array(row * h * canvases.length);
    canvases.forEach((c, layer) => {
      const g = c.getContext('2d');
      if (!g) throw new Error('2D canvas unavailable');
      const px = g.getImageData(0, 0, w, h).data;
      // Bottom row first, as a CanvasTexture (flipY) uploads it.
      for (let y = 0; y < h; y++) data.set(px.subarray((h - 1 - y) * row, (h - y) * row), (layer * h + y) * row);
    });
    const t = new THREE.DataArrayTexture(data, w, h, canvases.length);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = ANISO;
    t.needsUpdate = true;
    textures.push(t);
    return t;
  }

  const fog = new THREE.FogExp2(FOG_BASE.clone(), FOG_DENSITY);
  scene.fog = fog;
  const disposables: (Disposable | null)[] = [];

  function dispose(overlays: THREE.Object3D[]) {
    scene.remove(root);
    const seen = new Set<Disposable>();
    const free = (o: Disposable | null | undefined) => { if (o && !seen.has(o)) { seen.add(o); o.dispose(); } };
    for (const r of [root, ...overlays]) r.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if (!isDrawable(o)) return;
      free(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) free(v);
        free(m);
      }
    });
    textures.forEach(free);
    disposables.forEach(free);
    if (scene.environment) scene.environment.dispose();
    Object.assign(renderer, { autoClear: prev.autoClear, toneMapping: prev.toneMapping });
    Object.assign(renderer.shadowMap, { enabled: prev.shadow, type: prev.shadowType, autoUpdate: prev.shadowAuto });
    Object.assign(scene, { fog: prev.fog, environment: prev.environment, background: prev.background, matrixAutoUpdate: prev.sceneMatrixAutoUpdate });
    Object.assign(camera, { fov: prev.fov, near: prev.near, far: prev.far }); camera.updateProjectionMatrix();
  }

  return {
    renderer, scene, camera, root, fog, tex, texArray, disposables, dispose, moving: [],
    // The main random stream is fixed so the scene looks the same every load.
    random: createWorldRandom(20261010),
    sun: new THREE.Vector3(0.45, 0.5, -0.74).normalize(),
    time: { value: 0 },
  };
}
