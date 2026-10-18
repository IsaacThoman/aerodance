import { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import AeroWorld from '../aero/AeroWorld.tsx';
import PhoneScreen from './PhoneScreen.tsx';
import type { PreviewMode } from './PhoneScreen.tsx';
import PhoneReflection from './PhoneReflection.tsx';
import { PhoneLink, linkCode } from './PhoneLink.ts';

/*
 * A phone as the game's camera: open /phone/#<code> (the game's QR code) or type the code.
 * The phone tracks the players itself and sends the game only their poses (PhoneLink).
 *
 * The whole page is one canvas like the game's: the Aero sky, the players' mirror
 * (PhoneReflection) and the in-engine UI (PhoneScreen). The buffer is the page's CSS size,
 * so its pixels match the game's chunky look. While dimmed, the sky and the mirror stop,
 * leaving the phone's GPU to the tracking. The frame loop itself keeps running: the camera's
 * frames are timed by requestVideoFrameCallback, which a page that stops rendering stops too.
 */

const MODE_KEY = 'aerodance-phone-preview';
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
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('hashchange', join);
    window.addEventListener('pagehide', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('hashchange', join);
      window.removeEventListener('pagehide', onLeave);
      offView();
      offCamera();
      link.stop();
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
        <AeroWorld speed={0.6} quality="low" fps={15} paused={dimmed} />
        <PhoneReflection visible={linked && !dim && mode === 'mirror'} link={link} playerCount={view.playerCount} />
        <PhoneScreen link={link} view={view} camera={camera} mode={mode} onMode={setMode} dim={dimmed} onDim={setDim} />
      </Canvas>
    </div>
  );
}
