import { useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { POST_DEFAULTS } from '../../stages/shared/post.tsx';
import type { PostOverrides, PostSettings } from '../../stages/shared/post.tsx';
import { reducedMotion } from '../../stages/shared/hooks.ts';

/**
 * The live post-processing settings of the backdrop showing. A backdrop may change them every
 * frame (to breathe its bloom, say); the host resets them to its meta's whenever one mounts.
 * Separate from the stages' `post`, which a stage being prepared out of sight resets meanwhile.
 */
export const backdropPost: PostSettings = { ...POST_DEFAULTS };

export function resetBackdropPost(overrides: PostOverrides = {}): void {
  Object.assign(backdropPost, POST_DEFAULTS, overrides);
}

/** Set by the host while something else has the screen (a dance stage): backdrops stand still. */
export const backdropPlay: { paused: boolean } = { paused: false };

/**
 * The backdrops' clock, in seconds. It stops while paused and runs at half speed with
 * prefers-reduced-motion, so every moving thing should go by it rather than R3F's clock.
 */
export const backdropClock: { time: number; delta: number; stamp: number } = { time: 0, delta: 0, stamp: -1 };

const MOTION = reducedMotion ? 0.5 : 1;

// The first callback each frame moves the clock on; the rest see the same time.
function tick(state: RootState, delta: number) {
  const stamp = state.clock.elapsedTime;
  if (stamp === backdropClock.stamp) return;
  backdropClock.stamp = stamp;
  backdropClock.delta = Math.min(delta, 0.1) * MOTION;
  backdropClock.time += backdropClock.delta;
}

/**
 * useFrame for backdrops: skipped while the backdrop is paused, and handed the backdrop clock's
 * step and time instead of R3F's. Keep the priority at 0 (above 0 takes over rendering).
 *
 *   useBackdropFrame((state, delta, time) => { material.uniforms.uTime.value = time; });
 */
export function useBackdropFrame(callback: (state: RootState, delta: number, time: number) => void, priority = 0): void {
  useFrame((state, delta) => {
    if (backdropPlay.paused) return;
    tick(state, delta);
    callback(state, backdropClock.delta, backdropClock.time);
  }, priority);
}
