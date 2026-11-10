import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { RENDER_SIZE, displayModeFor } from './display.ts';

export default function FixedRenderResolution() {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  useLayoutEffect(() => {
    // Fiber tracks the displayed size for projection and pointer events. As on Wii,
    // both display modes use the same buffer; widescreen is anamorphic.
    gl.setSize(RENDER_SIZE.w, RENDER_SIZE.h, false);
    gl.domElement.dataset.displayMode = displayModeFor(size.width, size.height);
  }, [gl, size.width, size.height]);

  return null;
}
