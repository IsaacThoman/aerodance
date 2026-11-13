import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createAeroWorld, type AeroPart, type AeroWorldHandle } from './aeroBackground.ts';
import { screenOwner } from '../screenOwner.ts';
import { cameraPilot } from '../../../../packages/stages/shared/hooks.ts';

export interface AeroWorldProps {
  speed?: number;
  paused?: boolean;
  /** Diagnostics: parts of the world left out (createAeroWorld's hide). */
  hide?: readonly AeroPart[];
  /** Called once, after the world has drawn its first frame. */
  onShown?: () => void;
}

/**
 * Puts the Aero drone flight inside the surrounding <Canvas>.
 * It drives the default camera (or walk mode's cameraPilot does) and renders the frame itself
 * (useFrame priority 1), so it uses whatever buffer size the Canvas has, e.g. a fixed 640x480.
 *
 * paused stops it updating and rendering (a dance stage has the screen; stage/StageView.tsx).
 * It also stands down at once whenever a stage holds the renderer (screenOwner.ts), since the
 * paused prop arrives frames later.
 *
 * <AeroWorld speed={1} paused={false} onShown={() => ...} />
 */
export default function AeroWorld({ speed = 1, paused = false, hide, onShown }: AeroWorldProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const worldRef = useRef<AeroWorldHandle | null>(null);
  const shownRef = useRef(false);
  const shownCallback = useRef(onShown);
  shownCallback.current = onShown;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      console.warn('AeroWorld needs a perspective camera');
      return;
    }
    shownRef.current = false;
    let world: AeroWorldHandle | null = null;
    // Deferred one tick so StrictMode's mount/unmount/mount only builds the scene once.
    const timer = setTimeout(() => {
      world = createAeroWorld({
        renderer: gl, scene, camera, speed, hide, steer: (cam) => cameraPilot.fly?.(cam, scene),
      });
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

  useFrame((_, delta) => {
    const world = worldRef.current;
    if (!world || pausedRef.current || screenOwner.stage) return;
    world.update(delta);
    world.render();
    if (!shownRef.current) { shownRef.current = true; shownCallback.current?.(); }
  }, 1);

  return null;
}
