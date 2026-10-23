import { useLayoutEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { phoneBuffer } from './layout.ts';

/*
 * The pieces of a phone-sized page that is one canvas like the game's (the phone camera page
 * and the TV remote): a low-resolution buffer in the screen's own shape, and a plain background.
 */

/** Keeps the render buffer at most PHONE_LONG_SIDE along its long side, whatever the screen. */
export function PhoneRenderResolution() {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  useLayoutEffect(() => {
    // Fiber tracks the displayed size for pointer events; the buffer stays small.
    const { w, h } = phoneBuffer(size.width, size.height);
    gl.setSize(w, h, false);
  }, [gl, size.width, size.height]);
  return null;
}

/** The page's background, as in styles.css (.canvas-frame.phone). */
export const PHONE_BACKGROUND = '#1f6fd6';

/** Clears to the background at the start of each frame, before the UI (useFrame priority 1). */
export function Background() {
  const gl = useThree((state) => state.gl);
  useFrame(() => {
    gl.setClearColor(PHONE_BACKGROUND, 1);
    gl.clear();
  }, 1);
  return null;
}
