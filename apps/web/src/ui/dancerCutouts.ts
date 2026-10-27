import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cloneCharacter } from '../../../../packages/character/cloneCharacter.ts';
import { createAccessorySelector } from '../../../../packages/character/accessories.ts';
import modelUrl from '../../../../packages/character/assets/aero-character.glb?url';
import { CUTOUT, type Cutout, type CutoutPose } from './cutout.ts';

/*
 * Thresholded cutouts of the aero dancer, rendered in-engine: the real model, held in a pose,
 * drawn flat by the game's renderer into a render target and read back as a hard-edged mask (no
 * antialiasing, so every pixel is one of its parts or nothing: each is drawn in its own shade),
 * with how near each pixel is, so a part in front of another can be told apart from it.
 *
 * const [cutout] = await bakeCutouts(gl, [{ ArmL: [-0.5, 2.3, 0.6, 0, 0, 0, 1] }], 72);
 */

// Coverage over half is the dancer's.
const THRESHOLD = 127;
// How far past the posed model's bounds to frame it (character units): its bounds miss what a
// pose does to the skin.
const REACH = 2.5;
// Each part is drawn as this many times its CUTOUT value in red, well clear of rounding.
const ID_STEP = 32;
// The part a mesh is, by the bone it's skinned to; the rest is the body.
const BONE_PARTS: Record<string, number> = {
  Head: CUTOUT.head, ArmL: CUTOUT.leftHand, ArmR: CUTOUT.rightHand, FootL: CUTOUT.leftFoot, FootR: CUTOUT.rightFoot,
};

let model: Promise<THREE.Object3D> | null = null;
/** Starts loading the model, once. */
export const loadCutoutModel = () => model ??= new GLTFLoader().loadAsync(modelUrl).then((gltf) => gltf.scene, (err: unknown) => {
  model = null;
  throw err;
});

/**
 * Renders each pose once with `gl`, at `ppu` pixels per character unit. Leaves the renderer as
 * it found it.
 */
export async function bakeCutouts(gl: THREE.WebGLRenderer, poses: readonly CutoutPose[], ppu: number): Promise<Cutout[]> {
  const source = await loadCutoutModel();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  const ids = new Map<number, THREE.MeshBasicMaterial>(Object.values(CUTOUT).map((part) => [part, new THREE.MeshBasicMaterial({ color: new THREE.Color((part * ID_STEP) / 255, 0, 0), toneMapped: false })]));
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 0 });
  const previous = { target: gl.getRenderTarget(), color: gl.getClearColor(new THREE.Color()), alpha: gl.getClearAlpha() };
  const results: Cutout[] = [];
  const skeletons = new Set<THREE.Skeleton>();
  try {
    gl.setClearColor(0x000000, 0);
    for (const pose of poses) {
      const dancer = cloneCharacter(source);
      createAccessorySelector(dancer).select('None');
      dancer.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        mesh.frustumCulled = false;
        // The ink is the eyes; the gel is the part of the bone it's skinned to.
        const skinned = mesh as THREE.SkinnedMesh;
        const bone = skinned.isSkinnedMesh ? skinned.skeleton.bones[skinned.geometry.getAttribute('skinIndex')?.getX(0) ?? -1] : undefined;
        if (skinned.isSkinnedMesh) skeletons.add(skinned.skeleton);
        mesh.material = ids.get(mesh.material.name === 'Ink' ? CUTOUT.eye : BONE_PARTS[bone?.name ?? ''] ?? CUTOUT.body)!;
      });
      let body: THREE.Object3D | undefined;
      dancer.traverse((o) => {
        if (!(o as THREE.Bone).isBone) return;
        if (o.name === 'Body') body = o;
        const held = pose[o.name];
        if (held) {
          o.position.fromArray(held, 0);
          o.quaternion.fromArray(held, 3).normalize();
        }
      });
      scene.clear();
      scene.add(dancer);
      dancer.visible = true;
      scene.updateMatrixWorld(true);

      // Frame it wide, looking down -z from in front, then crop to what was drawn.
      const box = new THREE.Box3().setFromObject(dancer, true);
      const left = box.min.x - REACH, bottom = box.min.y - REACH;
      const W = Math.ceil((box.max.x - box.min.x + 2 * REACH) * ppu), H = Math.ceil((box.max.y - box.min.y + 2 * REACH) * ppu);
      Object.assign(camera, { left, right: left + W / ppu, top: bottom + H / ppu, bottom, near: 5 - REACH, far: 5 + REACH + box.max.z - box.min.z });
      camera.position.set(0, 0, box.max.z + 5);
      camera.updateProjectionMatrix();
      target.setSize(W, H);
      // Each pass's pixels, rows from the top.
      const pass = (material: THREE.Material | null) => {
        const pixels = new Uint8Array(W * H * 4);
        scene.overrideMaterial = material;
        gl.setRenderTarget(target);
        gl.clear();
        gl.render(scene, camera);
        gl.readRenderTargetPixels(target, 0, 0, W, H, pixels);
        return (x: number, y: number, channel: number) => pixels[((H - 1 - y) * W + x) * 4 + channel];
      };
      const id = pass(null), near = pass(depthMaterial);
      scene.overrideMaterial = null;

      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (id(x, y, 3) <= THRESHOLD) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (x1 < 0) throw Error('The dancer drew nothing in this pose');
      const w = x1 - x0 + 1, h = y1 - y0 + 1, part = new Uint8Array(w * h), depth = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (id(x + x0, y + y0, 3) <= THRESHOLD) continue;
        part[y * w + x] = Math.round(id(x + x0, y + y0, 0) / ID_STEP);
        depth[y * w + x] = near(x + x0, y + y0, 0);
      }
      // It stands on its spot by its body's middle.
      const mid = body ? body.getWorldPosition(new THREE.Vector3()).x : (box.min.x + box.max.x) / 2;
      results.push({ w, h, ppu, cx: (mid - left) * ppu - x0, part, depth });
    }
  } finally {
    gl.setRenderTarget(previous.target);
    gl.setClearColor(previous.color, previous.alpha);
    scene.overrideMaterial = null;
    scene.clear();
    skeletons.forEach((skeleton) => skeleton.dispose());
    target.dispose();
    ids.forEach((material) => material.dispose());
    depthMaterial.dispose();
  }
  return results;
}
