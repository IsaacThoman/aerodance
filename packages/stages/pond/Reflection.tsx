import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { REFLECT_ORIGIN } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// What the pond mirrors: the sky, the hills and the garden, captured once into a cube from just
// above the water in the middle (only what's under `scenery`: not the dancers, their pad, the koi
// or anything else on the water). The water looks it up as if the garden stood on a sphere round
// that point (shaders.ts mirrored()), so the banks line up with their reflections. Until then it
// mirrors a plain sky.

const LAYER = 1;
const SIZE = 256;

type Program = { isReady(): boolean };

/** Whether every material under `group` has its program compiled and linked, so drawing it won't stall. */
function compiled(gl: THREE.WebGLRenderer, group: THREE.Object3D): boolean {
  let ready = true;
  group.traverse((object) => {
    const { material } = object as THREE.Mesh;
    if (!ready || !material || Array.isArray(material)) return;
    const program = (gl.properties.get(material) as { currentProgram?: Program }).currentProgram;
    if (!program?.isReady()) ready = false;
  });
  return ready;
}

export function useReflection(shared: PondUniforms, scenery: RefObject<THREE.Group | null>): void {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const capture = useMemo(() => ({ target: null as THREE.WebGLCubeRenderTarget | null }), []);

  useEffect(() => () => {
    shared.uReflect.value = null;
    shared.uReflectReady.value = 0;
    capture.target?.dispose();
    capture.target = null;
  }, [shared, capture]);

  // Once the scenery's shaders are ready (the game prepares them a little at a time, out of
  // sight, before the stage shows), so capturing doesn't stall a frame compiling them.
  useFrame(() => {
    const group = scenery.current;
    if (capture.target || !group || !compiled(gl, group)) return;
    const target = new THREE.WebGLCubeRenderTarget(SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const camera = new THREE.CubeCamera(0.5, 5000, target);
    camera.position.set(...REFLECT_ORIGIN);
    camera.updateMatrixWorld();
    for (const face of camera.children) face.layers.set(LAYER);
    group.traverse((o) => o.layers.enable(LAYER));
    const { autoClear } = gl;
    const shadows = gl.shadowMap.needsUpdate;
    gl.autoClear = true;
    camera.update(gl, scene);
    gl.autoClear = autoClear;
    gl.shadowMap.needsUpdate = shadows;
    capture.target = target;
    shared.uReflect.value = target.texture;
    shared.uReflectReady.value = 1;
  });
}
