import { useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { reducedMotion } from '../../stages/shared/hooks.ts';

/**
 * The arenas' clock, in seconds. It runs while an arena is mounted, at half speed with
 * prefers-reduced-motion, so every moving thing should go by it rather than R3F's clock. It's
 * their own, not the menu backdrops' (which stops while a game or a stage has the screen).
 */
export const arenaClock: { time: number; delta: number; stamp: number } = { time: 0, delta: 0, stamp: -1 };

const MOTION = reducedMotion ? 0.5 : 1;

// The first callback each frame moves the clock on; the rest see the same time.
function tick(state: RootState, delta: number) {
  const stamp = state.clock.elapsedTime;
  if (stamp === arenaClock.stamp) return;
  arenaClock.stamp = stamp;
  arenaClock.delta = Math.min(delta, 0.1) * MOTION;
  arenaClock.time += arenaClock.delta;
}

/**
 * useFrame for arenas, handed the arena clock's step and time instead of R3F's. Keep the
 * priority at 0 (above 0 takes over rendering).
 *
 *   useArenaFrame((state, delta, time) => { material.uniforms.uTime.value = time; });
 */
export function useArenaFrame(callback: (state: RootState, delta: number, time: number) => void, priority = 0): void {
  useFrame((state, delta) => {
    tick(state, delta);
    callback(state, arenaClock.delta, arenaClock.time);
  }, priority);
}
