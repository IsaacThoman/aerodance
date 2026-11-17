import { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MathUtils } from 'three';
import type { PerspectiveCamera } from 'three';
import { ASPECT, reducedMotion } from '../../../../packages/stages/shared/hooks.ts';

export interface ScenicShot {
  fov: number;
  frame(camera: PerspectiveCamera, time: number): void;
}

// Each location directs its own shots. Keep the full width of a composition on
// 4:3 screens and hold a steady viewpoint when the viewer prefers reduced motion.
export default function ScenicCamera({ shots, view, near = 0.1, far = 2000 }: {
  shots: readonly ScenicShot[]; view: number; near?: number; far?: number;
}) {
  const camera = useThree(s => s.camera) as PerspectiveCamera;
  const size = useThree(s => s.size);
  const elapsed = useRef(0);
  const shot = shots[view] ?? shots[0];
  useLayoutEffect(() => {
    elapsed.current = 0;
    shot.frame(camera, 0);
  }, [shot, camera]);
  useLayoutEffect(() => {
    camera.aspect = size.width / Math.max(1, size.height);
    const halfAngle = MathUtils.degToRad(shot.fov) / 2;
    camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(halfAngle) * Math.max(1, ASPECT / camera.aspect)));
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [size, camera, shot, near, far]);
  useFrame((_, delta) => {
    if (reducedMotion) return;
    elapsed.current += Math.min(delta, 0.1);
    shot.frame(camera, elapsed.current);
  }, -1);
  return null;
}
