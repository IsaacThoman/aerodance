import { useEffect, useMemo } from "react";
import type { RefObject } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  AnimationMixer,
  MeshPhysicalMaterial,
  MeshBasicMaterial,
  Color,
  BufferAttribute,
  Vector3,
} from "three";
import type { BufferGeometry, ColorRepresentation, Material, Mesh, Object3D, WebGLProgramParametersWithUniforms } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createRetargeter } from "./motion.ts";
import { createPoseApplier } from "./retarget.ts";
import { LivePoseFilter } from './livePoseFilter.ts';
import { clone } from "three/addons/utils/SkeletonUtils.js";
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
  /** Blows the character up like a balloon each frame: 0 is its own shape, 1 about twice as round in the middle. */
  inflateRef?: RefObject<number>;
  animation?: string;
  motion?: MotionTake | null;
  person?: number;
  playback?: RefObject<number>;
  poseRef?: RefObject<Pose | null>;
  calibration?: TrackCalibration | null;
  /** Live webcam input: smooth the displayed pose and keep rendering while it settles. */
  live?: boolean;
  url?: string;
}
const isMesh = (o: Object3D): o is Mesh => "isMesh" in o && o.isMesh === true;

// Inflating swells the posed body out from its middle (this far above the Body bone, about the
// neck), most near the middle and less towards the hands and feet, so it rounds out like a
// balloon. The swell grows outwards along each ray from the middle, so the eyes stay on the
// face instead of sinking into it.
const INFLATE_MIDDLE = new Vector3(0, 0.85, 0);
const INFLATE_REACH = "1.7";
interface Inflation { inflate: { value: number }; inflateMiddle: { value: Vector3 } }
function inflatable(material: Material, uniforms: Inflation, compile?: (shader: WebGLProgramParametersWithUniforms) => void) {
  material.onBeforeCompile = (shader) => {
    compile?.(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = "uniform float inflate; uniform vec3 inflateMiddle;\n" + shader.vertexShader.replace(
      "#include <skinning_vertex>",
      `#include <skinning_vertex>
      vec3 inflateOut = transformed - inflateMiddle;
      transformed += inflateOut * inflate * exp(-dot(inflateOut, inflateOut) / (${INFLATE_REACH} * ${INFLATE_REACH}));`,
    );
  };
  // Tells three the shader differs from an uninflatable material's with the same hook.
  material.customProgramCacheKey = () => `inflate-${material.type}`;
}

export default function Character({
  appearance,
  opacityRef,
  inflateRef,
  animation = "Idle",
  motion,
  person = 0,
  playback,
  poseRef,
  calibration,
  live = false,
  url = modelUrl,
}: CharacterProps) {
  const gltf = useLoader(GLTFLoader, url);
  const model = useMemo(() => clone(gltf.scene), [gltf]);
  const retarget = useMemo(
    () => (motion ? createRetargeter(model, motion, person) : null),
    [model, motion, person],
  );
  const applyPose = useMemo(() => calibration ? createPoseApplier(model, calibration, {smoothDistance:live}) : null, [model, calibration, live]);
  // A fresh filter for each model/calibration/live session, so old smoothing never carries over.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const poseFilter=useMemo(()=>new LivePoseFilter(),[model,calibration,live]);
  const invalidate=useThree(state=>state.invalidate);
  const mixer = useMemo(() => new AnimationMixer(model), [model]);
  const inflate = useMemo<Inflation>(() => ({ inflate: { value: 0 }, inflateMiddle: { value: new Vector3() } }), []);
  const inflating = !!inflateRef;
  const ink = useMemo(() => {
    const material = new MeshBasicMaterial({ color: "#020611", transparent: !!opacityRef, depthWrite: !opacityRef });
    if (inflating) inflatable(material, inflate);
    return material;
  }, [opacityRef, inflating, inflate]);
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
    const compile = (shader: WebGLProgramParametersWithUniforms) => {
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
    if (inflating) inflatable(material, inflate, compile);
    else material.onBeforeCompile = compile;
    return material;
  }, [inflating, inflate]);
  useEffect(() => {
    const ownedGeometries: BufferGeometry[] = [];
    model.traverse((obj) => {
      if (isMesh(obj)) {
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
    return () => {
      ownedGeometries.forEach((geo) => geo.dispose());
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      gel.dispose();
      ink.dispose();
    };
  }, [model, mixer, gel, ink]);
  useEffect(() => {
    gel.color = new Color(appearance.color);
    gel.roughness = 0.36 - appearance.gloss * 0.0029;
    gel.clearcoat = 0.4 + appearance.gloss * 0.006;
    gel.opacity = appearance.opacity ?? 0.72;
    model.traverse((obj) => {
      if (obj.name.startsWith("acc_"))
        obj.visible = obj.name.startsWith(
          `acc_${appearance.accessory.toLowerCase()}_`,
        );
    });
  }, [appearance, model, gel]);
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
    if (inflateRef) inflate.inflate.value = inflateRef.current;
    if (opacityRef) {
      gel.opacity = (appearance.opacity ?? 0.72) * opacityRef.current;
      ink.opacity = opacityRef.current;
      // Faded out entirely: nobody sees the pose, so skip it.
      if (opacityRef.current <= 0) return;
    }
    if (applyPose) {
      const pose = poseRef?.current ?? null;
      applyPose(live ? poseFilter.update(pose,delta) : pose,delta);
      if(live && (poseFilter.settling || applyPose.settling)) invalidate();
    }
    else if (retarget) retarget(playback?.current ?? 0);
    else mixer.update(Math.min(delta, 0.05));
    // The skinned meshes sit untransformed in the model, so its space is theirs.
    const body = inflateRef && inflateRef.current > 0 ? model.getObjectByName("Body") : undefined;
    if (body) {
      body.updateWorldMatrix(true, false);
      model.worldToLocal(body.localToWorld(inflate.inflateMiddle.value.copy(INFLATE_MIDDLE)));
    }
  }, opacityRef || inflateRef ? 1 : 0);
  return <primitive object={model} dispose={null} />;
}
