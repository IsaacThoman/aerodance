import { useEffect, useMemo } from "react";
import type { RefObject } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  AnimationMixer,
  MeshPhysicalMaterial,
  MeshBasicMaterial,
  Color,
  BufferAttribute,
} from "three";
import type { BufferGeometry, ColorRepresentation, Mesh, Object3D, Skeleton, SkinnedMesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createRetargeter } from "./motion.ts";
import { createPoseApplier } from "./retarget.ts";
import { createPerformanceApplier } from './performance.ts';
import type { CharacterPose } from '../pose/performance.ts';
import { BalloonPop } from "./balloonPop.ts";
import { LivePoseFilter } from './livePoseFilter.ts';
import { cloneCharacter } from './cloneCharacter.ts';
import { hasRigidSkinning, patchRigidSkinning } from './rigidSkinning.ts';
import { createAccessorySelector } from './accessories.ts';
import { createSkinBounds } from './skinBounds.ts';
import modelUrl from "./assets/aero-character.glb?url";
import type { MotionTake } from "../pose/motion.ts";
import type { Pose, TrackCalibration } from "../pose/choreography.ts";

export interface CharacterAppearance {
  color: ColorRepresentation;
  /** 0-100. */
  gloss: number;
  opacity?: number;
  /** Shows the rig's acc_<name>_ meshes; "None" hides them all. */
  accessory: string;
}
/**
 * The rig is driven by the first that applies: a live/edited pose (calibration + poseRef), a
 * recorded take (motion + playback, in seconds), or else the named animation clip.
 */
export interface CharacterProps {
  appearance: CharacterAppearance;
  /** Fades the character (gel and ink) each frame. */
  opacityRef?: RefObject<number>;
  /** Suspends pose/effect updates while the enclosing scene is off screen. */
  activeRef?: RefObject<boolean>;
  animation?: string;
  motion?: MotionTake | null;
  person?: number;
  playback?: RefObject<number>;
  poseRef?: RefObject<Pose | null>;
  /** Authored character performance; used while a clip is active. */
  performanceRef?: RefObject<CharacterPose | null>;
  calibration?: TrackCalibration | null;
  /** Live webcam input: smooth the displayed pose and keep rendering while it settles. */
  live?: boolean;
  /** Seconds since the character popped like a balloon (balloonPop.ts); negative while whole. */
  popRef?: RefObject<number>;
  url?: string;
}
const isMesh = (o: Object3D): o is Mesh => "isMesh" in o && o.isMesh === true;

export default function Character({
  appearance,
  opacityRef,
  activeRef,
  animation = "Idle",
  motion,
  person = 0,
  playback,
  poseRef,
  performanceRef,
  calibration,
  live = false,
  popRef,
  url = modelUrl,
}: CharacterProps) {
  const gltf = useLoader(GLTFLoader, url);
  const model = useMemo(() => {
    const cloned = cloneCharacter(gltf.scene);
    // The shipped clips animate bones; mesh-local transforms are authored once.
    // World matrices still follow moving parents and the current skin as usual.
    if (url === modelUrl) cloned.traverse((object) => {
      if (isMesh(object)) { object.updateMatrix(); object.matrixAutoUpdate = false; }
    });
    return cloned;
  }, [gltf, url]);
  // Custom models can animate accessory nodes; retain their animation bindings.
  const accessories = useMemo(() => createAccessorySelector(model, { detach: url === modelUrl }), [model, url]);
  const rigid = useMemo(() => hasRigidSkinning(gltf.scene), [gltf]);
  const updateBounds = useMemo(() => createSkinBounds(model), [model]);
  const retarget = useMemo(
    () => (motion ? createRetargeter(model, motion, person) : null),
    [model, motion, person],
  );
  const applyPose = useMemo(() => calibration ? createPoseApplier(model, calibration, {smoothDistance:live}) : null, [model, calibration, live]);
  const applyPerformance = useMemo(() => createPerformanceApplier(model), [model]);
  // A fresh filter for each model/calibration/live session, so old smoothing never carries over.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const poseFilter=useMemo(()=>new LivePoseFilter(),[model,calibration,live]);
  const invalidate=useThree(state=>state.invalidate);
  const mixer = useMemo(() => new AnimationMixer(model), [model]);
  const pop = useMemo(() => popRef ? new BalloonPop() : null, [popRef]);
  const ink = useMemo(() => {
    const material = new MeshBasicMaterial({
      color: "#020611", transparent: !!opacityRef, depthWrite: !opacityRef,
    });
    if (rigid) patchRigidSkinning(material);
    pop?.extend(material, false);
    return material;
  }, [opacityRef, pop, rigid]);
  const gel = useMemo(() => {
    const material = new MeshPhysicalMaterial({
      name: "AquaGel",
      color: "#078fff",
      vertexColors: true,
      metalness: 0.7,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      envMapIntensity: 1.4,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        "attribute float gelHeight; varying float vGelHeight;\n" +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGelHeight = gelHeight;",
      );
      shader.fragmentShader =
        "varying float vGelHeight;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * exp(-pow((vGelHeight - 0.19) / 0.16, 2.0)) * pow(max(dot(normal, normalize(vViewPosition)), 0.0), 5.0) * 4.5;",
      );
    };
    if (rigid) patchRigidSkinning(material);
    pop?.extend(material, true);
    return material;
  }, [pop, rigid]);
  useEffect(() => {
    const ownedGeometries: BufferGeometry[] = [];
    const skeletons = new Set<Skeleton>();
    model.traverse((obj) => {
      if (isMesh(obj)) {
        if ((obj as SkinnedMesh).isSkinnedMesh) skeletons.add((obj as SkinnedMesh).skeleton);
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (!Array.isArray(obj.material) && obj.material.name === "AquaGel") {
          const geo = obj.geometry.clone();
          ownedGeometries.push(geo);
          geo.computeBoundingBox();
          const pos = geo.attributes.position;
          const colors = new Float32Array(pos.count * 3);
          const heights = new Float32Array(pos.count);
          const box = geo.boundingBox!; // computed just above
          const min = box.min.y;
          const range = box.max.y - min;
          for (let i = 0; i < pos.count; i++) {
            const h = (pos.getY(i) - min) / range;
            const brightness = 0.065 + 0.935 * Math.pow(1 - h, 1.35);
            heights[i] = h;
            colors.set(
              [brightness, brightness * 0.8, brightness * (1 - 0.8 * h * h)],
              i * 3,
            );
          }
          geo.setAttribute("color", new BufferAttribute(colors, 3));
          geo.setAttribute("gelHeight", new BufferAttribute(heights, 1));
          obj.geometry = geo;
          obj.material = gel;
        }
        if (!Array.isArray(obj.material) && obj.material.name === "Ink") obj.material = ink;
      }
    });
    // Changes made here don't draw by themselves on a canvas that renders on demand.
    invalidate();
    return () => {
      ownedGeometries.forEach((geo) => geo.dispose());
      skeletons.forEach((skeleton) => skeleton.dispose());
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      gel.dispose();
      ink.dispose();
    };
  }, [model, mixer, gel, ink, invalidate]);
  useEffect(() => {
    gel.color = new Color(appearance.color);
    gel.roughness = 0.36 - appearance.gloss * 0.0029;
    gel.clearcoat = 0.4 + appearance.gloss * 0.006;
    gel.opacity = appearance.opacity ?? 0.72;
    accessories.select(appearance.accessory);
    invalidate();
    return () => accessories.restore();
  }, [appearance, accessories, gel, invalidate]);
  useEffect(() => {
    if (retarget || applyPose) return;
    const clip = gltf.animations.find((c) => c.name === animation);
    if (!clip) return;
    const action = mixer.clipAction(clip).reset().fadeIn(0.25).play();
    return () => {
      action.fadeOut(0.25);
    };
  }, [animation, gltf, mixer, retarget, applyPose]);
  useFrame((_, delta) => {
    if (activeRef && !activeRef.current) return;
    if (pop && popRef) pop.update(popRef.current);
    if (opacityRef) {
      gel.opacity = (appearance.opacity ?? 0.72) * opacityRef.current;
      ink.opacity = opacityRef.current;
      // Faded out entirely: nobody sees the pose, so skip it.
      if (opacityRef.current <= 0) return;
    }
    if (applyPerformance(performanceRef?.current)) {
      // The keyed performance already placed every part.
    } else if (applyPose) {
      const pose = poseRef?.current ?? null;
      applyPose(live ? poseFilter.update(pose,delta) : pose,delta);
      if(live && (poseFilter.settling || applyPose.settling)) invalidate();
    }
    else {
      if (retarget) retarget(playback?.current ?? 0);
      else mixer.update(Math.min(delta, 0.05));
      // Posing updates the bones' world matrices; clips and takes leave them to the render.
      model.updateMatrixWorld();
    }
    updateBounds();
  }, opacityRef ? 1 : 0);
  return <primitive object={model} dispose={null} />;
}
