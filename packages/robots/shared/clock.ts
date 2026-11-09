import { useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';

/**
 * The robot hall's clock, in seconds. Every rally and arm goes by it rather than R3F's, so in
 * development it can be paused, slowed or set (window.__robots) and every arm is then exactly
 * where it would be at that moment.
 */
export const robotClock = {
  // A few seconds in, so every rally is under way.
  time: 3,
  delta: 0,
  /** Seconds of rally per second. */
  scale: 1,
  paused: false,
  stamp: -1,
};

/** Moves the clock on, once a frame, before anything reads it. */
export function tickRobotClock(state: RootState, delta: number): void {
  const stamp = state.clock.elapsedTime;
  if (stamp === robotClock.stamp) return;
  robotClock.stamp = stamp;
  robotClock.delta = robotClock.paused ? 0 : Math.min(delta, 0.1) * robotClock.scale;
  robotClock.time += robotClock.delta;
}

/**
 * useFrame on the robots' clock: `time` and `delta` are the rally's. Arms use the default
 * priority 0, after the rallies (-1) have moved their paddle targets on.
 *
 *   useRobotFrame((time, delta) => { joint.rotation.y = ... });
 */
export function useRobotFrame(callback: (time: number, delta: number, state: RootState) => void, priority = 0): void {
  useFrame((state, delta) => {
    tickRobotClock(state, delta);
    callback(robotClock.time, robotClock.delta, state);
  }, priority);
}
