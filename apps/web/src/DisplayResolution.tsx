import { useEffect, useLayoutEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { TV_RENDER_SIZE, displayModeFor } from './display.ts';
import { client } from './host.ts';

/** Native screen density, kept on Canvas so Fiber resizes cannot restore a stale DPR. */
export function useDisplayPixelRatio() {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  useEffect(() => {
    if (client() === 'tvos') return;
    // Moving between displays or changing browser zoom can change DPR without a CSS resize.
    // Re-arm the query after each change so it watches the new screen's pixel ratio.
    let query: MediaQueryList;
    const update = () => {
      query?.removeEventListener('change', update);
      const dpr = window.devicePixelRatio || 1;
      setDpr(dpr);
      query = window.matchMedia(`(resolution: ${dpr}dppx)`);
      query.addEventListener('change', update);
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return dpr;
}

/** Keep display reporting and the native TV host's fixed buffer in sync with the frame. */
export default function DisplayResolution() {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  useLayoutEffect(() => {
    // The Apple TV's JavaScriptCore host retains its fixed, anamorphic performance budget.
    if (client() === 'tvos') gl.setSize(TV_RENDER_SIZE.w, TV_RENDER_SIZE.h, false);
    gl.domElement.dataset.displayMode = displayModeFor(size.width, size.height);
  }, [gl, size.width, size.height]);

  return null;
}
