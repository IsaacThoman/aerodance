import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cloneCharacter } from '../../../../packages/character/cloneCharacter.ts';
import { createAccessorySelector } from '../../../../packages/character/accessories.ts';
import { createRetargeter, loadMotion } from '../../../../packages/character/motion.ts';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import modelUrl from '../../../../packages/character/assets/aero-character.glb?url';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import { CUTOUT, clearShift, type Cutout, type CutoutPose } from './cutout.ts';

/*
 * Thresholded cutouts of the aero dancer, rendered in-engine: the real model, held in a moment
 * of the menu capture, drawn flat by the game's renderer into a render target and read back as
 * a hard-edged mask (no antialiasing, so every pixel is the dancer, its eyes or nothing). A hand
 * the pose holds against the body or head would vanish into the silhouette, so it's slid out
 * sideways, away from the body's middle, until there's a pixel clear between them.
 *
 * const [cutout] = await bakeCutouts(gl, [{ take: 1, seconds: 5 }], 9.5, 7.1);
 */

// Coverage over half is the dancer's.
const THRESHOLD = 127;
// How far past the posed model's bounds to frame it (character units): its bounds miss what a
// pose does to the skin.
const REACH = 2.5;
// Hands are slid out at most this far (character units).
const HAND_SLIDE = 1.5;
const BODY = new THREE.Color(1, 1, 1);
const EYES = new THREE.Color(0, 0, 0);

let assets: Promise<{ scene: THREE.Object3D; motion: MotionTake }> | null = null;
/** Starts loading the model and the capture, once. */
export const loadCutoutAssets = () => assets ??= Promise.all([
  new GLTFLoader().loadAsync(modelUrl),
  fetch(motionUrl).then((r) => {
    if (!r.ok) throw Error(`The dance capture didn't load (${r.status})`);
    return r.arrayBuffer();
  }).then(loadMotion),
]).then(([gltf, motion]) => ({ scene: gltf.scene, motion }), (err: unknown) => {
  assets = null;
  throw err;
});

/**
 * Renders each pose once with `gl`, at `ppu` pixels per character unit down and `ppuX` across
 * (the overlay's pixels are 4:3 wide in widescreen). Leaves the renderer as it found it.
 */
export async function bakeCutouts(gl: THREE.WebGLRenderer, poses: readonly CutoutPose[], ppu: number, ppuX = ppu): Promise<Cutout[]> {
  const { scene: source, motion } = await loadCutoutAssets();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  const body = new THREE.MeshBasicMaterial({ color: BODY, toneMapped: false });
  const eyes = new THREE.MeshBasicMaterial({ color: EYES, toneMapped: false });
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 0 });
  const previous = { target: gl.getRenderTarget(), color: gl.getClearColor(new THREE.Color()), alpha: gl.getClearAlpha() };
  const results: Cutout[] = [];
  const skeletons = new Set<THREE.Skeleton>();
  try {
    gl.setClearColor(0x000000, 0);
    for (const pose of poses) {
      const model = cloneCharacter(source);
      createAccessorySelector(model).select('None');
      const meshes: THREE.Mesh[] = [];
      const hands: { mesh: THREE.Mesh; bone: THREE.Bone }[] = [];
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.visible) return;
        // The gel is the dancer; its ink is the eyes.
        mesh.material = mesh.material.name === 'Ink' ? eyes : body;
        mesh.frustumCulled = false;
        meshes.push(mesh);
        const skinned = mesh as THREE.SkinnedMesh;
        if (!skinned.isSkinnedMesh) return;
        skeletons.add(skinned.skeleton);
        // The hands are the parts skinned to the arm bones.
        const bone = skinned.skeleton.bones[skinned.geometry.getAttribute('skinIndex')?.getX(0) ?? -1];
        if (bone?.name === 'ArmL' || bone?.name === 'ArmR') hands.push({ mesh, bone });
      });
      scene.clear();
      scene.add(model);
      scene.updateMatrixWorld(true);
      createRetargeter(model, motion, pose.take)(pose.seconds);
      model.visible = true;
      scene.updateMatrixWorld(true);

      // Frame it wide, looking down -z from in front, then crop to what was drawn.
      const box = new THREE.Box3().setFromObject(model, true);
      const left = box.min.x - REACH, bottom = box.min.y - REACH;
      const W = Math.ceil((box.max.x - box.min.x + 2 * REACH) * ppuX), H = Math.ceil((box.max.y - box.min.y + 2 * REACH) * ppu);
      Object.assign(camera, { left, right: left + W / ppuX, top: bottom + H / ppu, bottom, near: 5 - REACH, far: 5 + REACH + box.max.z - box.min.z });
      camera.position.set(0, 0, box.max.z + 5);
      camera.updateProjectionMatrix();
      target.setSize(W, H);
      const pixels = new Uint8Array(W * H * 4);
      const render = () => {
        gl.setRenderTarget(target);
        gl.clear();
        gl.render(scene, camera);
        gl.readRenderTargetPixels(target, 0, 0, W, H, pixels);
      };
      // What the visible meshes cover, rows from the top.
      const coverage = () => {
        render();
        const mask = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = pixels[((H - 1 - y) * W + x) * 4 + 3] > THRESHOLD ? 1 : 0;
        return mask;
      };
      let spine: THREE.Object3D | undefined;
      model.traverse((o) => { if ((o as THREE.Bone).isBone && o.name === 'Body') spine = o; });
      const mid = spine ? spine.getWorldPosition(new THREE.Vector3()).x : (box.min.x + box.max.x) / 2;

      // Each hand clear of the rest of the dancer, and of the other hand, sliding out on its own
      // side of the body's middle; if both are held against it on one side, the nearer one goes
      // to the other side.
      const show = (only: readonly THREE.Mesh[] | null) => meshes.forEach((m) => { m.visible = !only || only.includes(m); });
      show(meshes.filter((m) => !hands.some((hand) => hand.mesh === m)));
      const fixed = coverage();
      const middle = (mid - left) * ppuX;
      const placed = hands.map(({ mesh, bone }) => {
        show([mesh]);
        const mask = coverage();
        let sum = 0, n = 0;
        mask.forEach((c, i) => { if (c) { sum += i % W; n++; } });
        const x = n ? sum / n : middle;
        return { bone, mask, x, dir: (x >= middle ? 1 : -1) as 1 | -1, held: clearShift(fixed, mask, W, H, 1, 1, 0) !== 0 };
      });
      if (placed.length === 2 && placed[0].held && placed[1].held && placed[0].dir === placed[1].dir) {
        const nearer = Math.abs(placed[0].x - middle) < Math.abs(placed[1].x - middle) ? placed[0] : placed[1];
        nearer.dir = -nearer.dir as 1 | -1;
      }
      placed.forEach(({ bone, mask, dir }) => {
        const k = clearShift(fixed, mask, W, H, dir, 1, Math.ceil(HAND_SLIDE * ppuX)) ?? 0;
        if (k) {
          // k whole pixels along x, in the bone's parent's space.
          bone.position.add(new THREE.Vector3((dir * k) / ppuX, 0, 0)
            .applyMatrix3(new THREE.Matrix3().setFromMatrix4(bone.parent!.matrixWorld.clone().invert())));
          bone.updateMatrixWorld(true);
        }
        mask.forEach((c, j) => {
          const x = (j % W) + dir * k;
          if (c && x >= 0 && x < W) fixed[j - (j % W) + x] = 1;
        });
      });
      show(null);
      render();

      // Rows come back bottom-up.
      const covered = (x: number, y: number) => pixels[((H - 1 - y) * W + x) * 4 + 3] > THRESHOLD;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!covered(x, y)) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (x1 < 0) throw Error(`The dancer drew nothing at ${pose.seconds} s`);
      const w = x1 - x0 + 1, h = y1 - y0 + 1, part = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!covered(x + x0, y + y0)) continue;
        part[y * w + x] = pixels[((H - 1 - y - y0) * W + x + x0) * 4] > THRESHOLD ? CUTOUT.body : CUTOUT.eye;
      }
      // It stands on its spot by its body's middle.
      results.push({ w, h, cx: Math.round((mid - left) * ppuX) - x0, part });
    }
  } finally {
    gl.setRenderTarget(previous.target);
    gl.setClearColor(previous.color, previous.alpha);
    scene.clear();
    skeletons.forEach((skeleton) => skeleton.dispose());
    target.dispose();
    body.dispose();
    eyes.dispose();
  }
  return results;
}
