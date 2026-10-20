import { useEffect, useLayoutEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import AeroWorld from '../aero/AeroWorld.tsx';
import PhoneScreen from './PhoneScreen.tsx';
import type { PreviewMode } from './PhoneScreen.tsx';
import PhoneReflection from './PhoneReflection.tsx';
import { PhoneLink, linkCode } from './PhoneLink.ts';
import { phoneBuffer } from './layout.ts';

/*
 * A phone as the game's camera: open /pair/#<code> (the game's QR code) or type the code.
 * The phone tracks the players itself and sends the game only their poses (PhoneLink).
 *
 * The whole page is one canvas like the game's: the Aero sky, the players' mirror
 * (PhoneReflection) and the in-engine UI (PhoneScreen). Like the game's fixed 640x480, the
 * buffer is low resolution whatever the screen: at most 640 pixels along its long side, in
 * the screen's own shape, stretched to fill it with chunky pixels. While dimmed, the sky and the mirror stop,
 * leaving the phone's GPU to the tracking. The frame loop itself keeps running: the camera's
 * frames are timed by requestVideoFrameCallback, which a page that stops rendering stops too.
 */

const MODE_KEY = 'aerodance-phone-preview';
function PhoneRenderResolution() {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  useLayoutEffect(() => {
    // Fiber tracks the displayed size for pointer events; the buffer stays small.
    const { w, h } = phoneBuffer(size.width, size.height);
    gl.setSize(w, h, false);
  }, [gl, size.width, size.height]);
  return null;
}
const savedMode = (): PreviewMode => { try { return localStorage.getItem(MODE_KEY) === 'video' ? 'video' : 'mirror'; } catch { return 'mirror'; } };

export default function PhoneApp() {
  const [link] = useState(() => new PhoneLink());
  const [view, setView] = useState(link.view);
  const [camera, setCamera] = useState(link.camera.view);
  const [mode, setMode] = useState(savedMode);
  const [dim, setDim] = useState(false);

  useEffect(() => {
    const offView = link.subscribe(setView);
    const offCamera = link.camera.subscribe(setCamera);
    const join = () => { const code = linkCode(new URL(location.href)); if (code && code !== link.view.code) void link.join(code); };
    join();
    // Back on screen: the camera (stopped while hidden) starts again.
    const onVisible = () => { if (!document.hidden) link.resume(); };
    const onLeave = () => link.leave();
    // Back from the back/forward cache: the page left the game on the way out.
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) join(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('hashchange', join);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('pageshow', onShow);
    // The link outlives this effect (development runs it twice); leaving the page ends it.
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('hashchange', join);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('pageshow', onShow);
      offView();
      offCamera();
    };
  }, [link]);

  // A song starting dims the screen; a tap wakes it.
  useEffect(() => { if (view.playing) setDim(true); }, [view.playing]);
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* Private browsing. */ } }, [mode]);

  const linked = view.stage === 'linked';
  const dimmed = linked && dim;
  return (
    <div className="canvas-frame phone">
      <Canvas dpr={1} flat camera={{ fov: 66, near: 0.3, far: 6500 }}>
        <PhoneRenderResolution />
        <AeroWorld speed={0.6} fps={15} paused={dimmed} />
        <PhoneReflection visible={linked && !dim && mode === 'mirror'} link={link} playerCount={view.playerCount} />
        <PhoneScreen link={link} view={view} camera={camera} mode={mode} onMode={setMode} dim={dimmed} onDim={setDim} />
      </Canvas>
    </div>
  );
}
