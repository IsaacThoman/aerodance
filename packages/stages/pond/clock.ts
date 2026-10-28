import type { RootState } from '@react-three/fiber';
import { reducedMotion } from '../shared/hooks.ts';

// The pond's clock: R3F's, standing still with prefers-reduced-motion (the dancers pause separately).

export const pondTime = (state: RootState): number => (reducedMotion ? 0 : state.clock.elapsedTime);

export const pondDelta = (delta: number): number => (reducedMotion ? 0 : Math.min(delta, 0.1));
