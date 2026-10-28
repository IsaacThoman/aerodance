import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import AeroWorld from './aero/AeroWorld.tsx';
import BackdropView from './backdrop/BackdropView.tsx';
import type { BackgroundId } from './backdrop/backgrounds.ts';
import Veil from './stage/Veil.tsx';
import type { Fade } from './stage/Veil.tsx';
import { aeroHide } from './diagnostics.ts';

const FADE_UP = 0.25;
const FADE_DOWN = 0.6;
// Frames the new background draws behind the veil before it comes down.
const SETTLE_FRAMES = 3;

/**
 * What's behind the menus: the Aero world (aero/AeroWorld.tsx) or one of the menu backdrops
 * (backdrop/BackdropView.tsx), whichever `background` says.
 *
 * The page's first background fades the canvas in once it's built. A change of background
 * happens behind the stages' pale veil: up, swap, wait until the new one is built and has
 * drawn a few frames, down. A backdrop that crashes gives way to the Aero world for the rest
 * of the visit. `paused`: a dance stage has the screen.
 *
 * The canvas reports data-background (the one mounted) and data-background-ready (built, and
 * the veil down) for tests.
 *
 * <Scene background="koi" paused={stageShowing} />
 */
export default function Scene({ paused = false, background }: { paused?: boolean; background: BackgroundId }) {
  const gl = useThree((state) => state.gl);
  const [shown, setShown] = useState(background);
  const fade = useRef<Fade>({ value: 0, settled: 0 });
  const st = useRef({
    requested: background, shown: background, ready: null as BackgroundId | null, failed: new Set<BackgroundId>(), faded: false, reported: '',
  }).current;
  st.requested = background;

  // The canvas stays hidden until the first background is built.
  useLayoutEffect(() => {
    const canvas = gl.domElement;
    canvas.style.transition = 'opacity 1.2s ease';
    if (!st.faded) canvas.style.opacity = '0';
  }, [gl, st]);

  const onReady = useCallback((id: BackgroundId) => {
    if (id !== st.shown) return;
    st.ready = id;
    if (!st.faded) { st.faded = true; gl.domElement.style.opacity = '1'; }
  }, [gl, st]);
  const onBackdropReady = useCallback((id: BackgroundId, failed: boolean) => {
    if (failed) st.failed.add(id);
    else onReady(id);
  }, [onReady, st]);
  const onWorldShown = useCallback(() => onReady('skyline'), [onReady]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    const f = fade.current;
    const want = st.failed.has(st.requested) ? 'skyline' : st.requested;
    if (want !== st.shown) {
      // Before the first one is up the canvas is hidden anyway: swap at once.
      f.value = st.faded ? Math.min(1, f.value + dt / FADE_UP) : 1;
      if (f.value >= 1) {
        st.shown = want;
        st.ready = null;
        f.settled = 0;
        setShown(want);
      }
    } else if (st.ready === st.shown && f.value > 0) {
      if (++f.settled > SETTLE_FRAMES) f.value = Math.max(0, f.value - dt / FADE_DOWN);
    }
    const ready = st.ready === st.shown && f.value === 0;
    const report = `${st.shown}|${ready}`;
    if (report !== st.reported) {
      st.reported = report;
      state.gl.domElement.dataset.background = st.shown;
      state.gl.domElement.dataset.backgroundReady = String(ready);
    }
  });

  return (
    <>
      {shown === 'skyline'
        ? <AeroWorld speed={1} paused={paused} hide={aeroHide} onShown={onWorldShown} />
        : <BackdropView id={shown} paused={paused} onReady={onBackdropReady} />}
      <Veil fade={fade} />
    </>
  );
}
