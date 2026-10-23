import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createAeroWorld, type AeroPart, type AeroTelemetry, type AeroWorldHandle } from './aeroBackground.ts';
import { screenOwner } from '../screenOwner.ts';

export interface AeroWorldProps {
  speed?: number;
  /** Caps how often the world renders; omit to render every frame. */
  fps?: number;
  paused?: boolean;
  onTelemetry?: (telemetry: AeroTelemetry) => void;
  /** Diagnostics: parts of the world left out (createAeroWorld's hide). */
  hide?: readonly AeroPart[];
}

/**
 * Puts the Aero drone flight inside the surrounding <Canvas>.
 * It drives the default camera and renders the frame itself (useFrame priority 1),
 * so it uses whatever buffer size the Canvas has, e.g. a fixed 640x480.
 *
 * fps caps how often the world itself renders (phones: it's the battery hog). In between,
 * the last frame is reused from a texture, so overlays can still redraw at full rate.
 * Pair it with <Canvas frameloop="demand"> and something that invalidates at that rate.
 *
 * paused stops it updating and rendering (a dance stage has the screen; stage/StageView.tsx).
 * It also stands down at once whenever a stage holds the renderer (screenOwner.ts), since the
 * paused prop arrives frames later.
 *
 * <AeroWorld speed={1} fps={15} paused={false} onTelemetry={(t) => ...} />
 */
export default function AeroWorld({ speed = 1, fps, paused = false, onTelemetry, hide }: AeroWorldProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const worldRef = useRef<AeroWorldHandle | null>(null);
  const shownRef = useRef(false);
  const teleRef = useRef(onTelemetry);
  teleRef.current = onTelemetry;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      console.warn('AeroWorld needs a perspective camera');
      return;
    }
    const canvas = gl.domElement;
    canvas.style.transition = 'opacity 1.2s ease';
    canvas.style.opacity = '0';
    shownRef.current = false;
    let world: AeroWorldHandle | null = null;
    // Deferred one tick so StrictMode's mount/unmount/mount only builds the scene once.
    const timer = setTimeout(() => {
      world = createAeroWorld({ renderer: gl, scene, camera, speed, hide, onTelemetry: (t) => teleRef.current?.(t) });
      worldRef.current = world;
    }, 0);
    return () => {
      clearTimeout(timer);
      world?.dispose();
      worldRef.current = null;
    };
    // Rebuilding is expensive; speed changes go through setSpeed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  useEffect(() => { worldRef.current?.setSpeed(speed); }, [speed]);

  // Capped mode: the world renders into `cache`, which a full-screen quad shows every frame.
  const cache = useMemo(() => {
    if (!fps) return null;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    const material = new THREE.MeshBasicMaterial({ map: target.texture, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene2 = new THREE.Scene();
    scene2.add(quad);
    return { target, material, quad, scene: scene2, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1), interval: 1 / fps, due: Infinity, fresh: false };
  }, [fps]);
  useEffect(() => () => {
    if (!cache) return;
    cache.target.dispose();
    cache.material.dispose();
    cache.quad.geometry.dispose();
  }, [cache]);

  useFrame((_, delta) => {
    const world = worldRef.current;
    if (!world || pausedRef.current || screenOwner.stage) return;
    if (!cache) {
      world.update(delta);
      world.render();
    } else {
      cache.due += delta;
      const buf = gl.getDrawingBufferSize(new THREE.Vector2());
      if (cache.target.width !== buf.x || cache.target.height !== buf.y) {
        cache.target.setSize(buf.x, buf.y);
        cache.fresh = false;
      }
      if (!cache.fresh || cache.due >= cache.interval) {
        // update() clamps each step to 50ms; step through the whole gap so speed holds.
        let left = Math.min(cache.fresh ? cache.due : delta, 1);
        while (left > 0) { const d = Math.min(left, 0.05); world.update(d); left -= d; }
        gl.setRenderTarget(cache.target);
        world.render();
        gl.setRenderTarget(null);
        cache.due = 0;
        cache.fresh = true;
      }
      gl.clear();
      gl.render(cache.scene, cache.camera);
    }
    if (!shownRef.current) { shownRef.current = true; gl.domElement.style.opacity = '1'; }
  }, 1);

  return null;
}
