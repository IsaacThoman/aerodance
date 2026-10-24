import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec2, Vec3 } from '../../stages/catalog.ts';
import { ASPECT } from '../../stages/shared/hooks.ts';
import { damp } from '../../stages/shared/random.ts';
import { useBackdropFrame } from './frame.ts';

export interface BackdropCameraProps {
  position?: Vec3;
  target?: Vec3;
  /** Vertical field of view at 16:9; 4:3 widens it to keep the same horizontal view. */
  fov?: number;
  near?: number;
  far?: number;
  /** [x, y, z] world units of slow idle drift. */
  sway?: Vec3;
  /** Drift speed multiplier. */
  swaySpeed?: number;
  /** [x, y] world units the camera leans towards the pointer. */
  parallax?: Vec2;
  /** Custom control after the rig, on the backdrop clock (shared/frame.ts). */
  onFrame?: (camera: THREE.PerspectiveCamera, time: number, delta: number, state: RootState) => void;
}

/**
 * A backdrop's camera, the default camera of the host's portal while mounted: it looks at
 * `target` from `position`, drifting slowly (sway) and leaning a little towards the pointer.
 * Like the stages' StageCamera, without their orbit and results shift.
 *
 * <BackdropCamera position={[0, 2, 12]} target={[0, 1.5, 0]} fov={45} sway={[0.3, 0.1, 0]} />
 */
export function BackdropCamera({
  position = [0, 2, 12],
  target = [0, 1.5, 0],
  fov = 45,
  near = 0.1,
  far = 2000,
  sway = [0.2, 0.08, 0],
  swaySpeed = 1,
  parallax = [0.3, 0.15],
  onFrame,
}: BackdropCameraProps): null {
  const set = useThree((s) => s.set);
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const camera = useMemo(() => {
    // R3F's `manual` flag keeps it from fitting the projection to the canvas.
    const cam: THREE.PerspectiveCamera & { manual?: boolean } = new THREE.PerspectiveCamera(fov, ASPECT, near, far);
    cam.manual = true;
    return cam;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const base = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  const lean = useRef(new THREE.Vector2());

  useLayoutEffect(() => {
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.max(1, ASPECT / aspect)));
    camera.near = near;
    camera.far = far;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    base.current.set(...position);
    look.current.set(...target);
    camera.position.copy(base.current);
    camera.lookAt(look.current);
  }, [camera, fov, near, far, aspect, ...position, ...target]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);

  useBackdropFrame((state, delta, t) => {
    lean.current.x = damp(lean.current.x, state.pointer.x, 2, delta);
    lean.current.y = damp(lean.current.y, state.pointer.y, 2, delta);
    const s = t * swaySpeed;
    camera.position.set(
      base.current.x + Math.sin(s * 0.13) * sway[0] + lean.current.x * parallax[0],
      base.current.y + Math.sin(s * 0.11 + 1.3) * sway[1] + lean.current.y * parallax[1],
      base.current.z + Math.sin(s * 0.09 + 2.1) * sway[2],
    );
    camera.lookAt(look.current);
    onFrame?.(camera, t, delta, state);
  });

  return null;
}
