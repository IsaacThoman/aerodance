import type { CSSProperties } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import AeroWorld from '../aero/AeroWorld.tsx';
import BackdropView from '../backdrop/BackdropView.tsx';
import StageView from '../stage/StageView.tsx';
import type { StageState } from '../stage/StageView.tsx';
import FixedRenderResolution from '../FixedRenderResolution.tsx';
import { DISPLAY_MODES, displayModeFor } from '../display.ts';
import type { DisplayMode } from '../display.ts';
import { aeroHide } from '../diagnostics.ts';
import WalkControls, { createWalkStatus } from './WalkControls.tsx';
import WalkHud from './WalkHud.tsx';
import { stepScene, walkSceneFor } from './scenes.ts';
import type { WalkScene } from './scenes.ts';

/** A scene, by its key (WalkScene.key), is built and showing, or failed. */
type ReadyHandler = (key: string, failed: boolean) => void;

// One scene, as the game shows it, with its own camera until the walker takes it over.
function SceneHost({ scene, onReady }: { scene: WalkScene; onReady: ReadyHandler }) {
  const { key } = scene;
  const onShown = useCallback(() => onReady(key, false), [key, onReady]);
  const onBackdrop = useCallback((_id: string, failed: boolean) => onReady(key, failed), [key, onReady]);
  const onState = useCallback(({ ready, failed }: StageState) => { if (ready) onReady(key, failed); }, [key, onReady]);
  if (scene.kind === 'skyline') return <AeroWorld hide={aeroHide} onShown={onShown} />;
  if (scene.kind === 'backdrop') return <BackdropView id={scene.id} onReady={onBackdrop} />;
  return <StageView active demo stageId={scene.id} onState={onState} />;
}

/**
 * Walk mode (/?walk, or /?walk=<scene key>): walk round any of the game's scenes, first person,
 * instead of playing. Skyline, the menu backdrops and the dance stages each show as the game
 * shows them (same buffer, post and aspect), and WalkControls takes over their camera once
 * they're built. The menu (Esc) picks another; [ and ] step through them. The URL follows the
 * scene, so a reload comes back to it.
 */
export default function WalkApp() {
  const viewport = useRef<HTMLDivElement>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => displayModeFor(innerWidth, innerHeight));
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setDisplayMode(displayModeFor(entry.contentRect.width, entry.contentRect.height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [scene, setScene] = useState(() => walkSceneFor(new URLSearchParams(location.search).get('walk')));
  const [status] = useState(() => createWalkStatus(scene));
  const choose = useCallback((next: WalkScene) => {
    Object.assign(status, { scene: next, ready: false, failed: false });
    setScene(next);
    const url = new URL(location.href);
    url.searchParams.set('walk', next.key);
    history.replaceState(history.state, '', url);
  }, [status]);
  const onStep = useCallback((step: -1 | 1) => choose(stepScene(status.scene.key, step)), [choose, status]);
  const onReady = useCallback<ReadyHandler>((key, failed) => {
    if (key !== status.scene.key) return;
    Object.assign(status, { ready: !failed, failed });
  }, [status]);

  return (
    <div ref={viewport} className="display-viewport">
      <div className="canvas-frame display" style={{ '--display-aspect': DISPLAY_MODES[displayMode].aspect } as CSSProperties}>
        <Canvas dpr={1} flat gl={{ antialias: false }} camera={{ fov: 66, near: 0.3, far: 6500 }}>
          <FixedRenderResolution />
          <SceneHost key={scene.key} scene={scene} onReady={onReady} />
          <WalkControls status={status} onStep={onStep} />
          <WalkHud status={status} onChoose={choose} />
        </Canvas>
      </div>
    </div>
  );
}
