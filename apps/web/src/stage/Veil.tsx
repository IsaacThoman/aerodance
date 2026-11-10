import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/** The veil's opacity, and frames what it covers has had to settle. */
export interface Fade { value: number; settled: number; }

/**
 * A pale full-screen veil at `fade.current.value` opacity, drawn over the world (priority 1.6,
 * under the menus), for swapping what's behind it out of sight.
 *
 * <Veil fade={fadeRef} />
 */
export default function Veil({ fade }: { fade: RefObject<Fade> }) {
  const gl = useThree((state) => state.gl);
  const layer = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({ color: '#f4fdff', transparent: true, toneMapped: false, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return { material, quad, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1) };
  }, []);
  useEffect(() => () => { layer.material.dispose(); layer.quad.geometry.dispose(); }, [layer]);
  useFrame(() => {
    const v = fade.current.value;
    if (v < 0.001) return;
    layer.material.opacity = v;
    const ac = gl.autoClear;
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(layer.scene, layer.camera);
    gl.autoClear = ac;
  }, 1.6);
  return null;
}
