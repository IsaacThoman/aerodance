import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { BACKDROPS } from '../../../../packages/backdrops/index.ts';
import type { Backdrop, BackdropId } from '../../../../packages/backdrops/index.ts';
import { backdropPlay, backdropPost, resetBackdropPost } from '../../../../packages/backdrops/shared/frame.ts';
import { RenderPipeline } from '../../../../packages/stages/shared/post.tsx';
import { diagnostic } from '../diagnostics.ts';
import { screenOwner } from '../screenOwner.ts';

export type BackdropReadyHandler = (id: BackdropId, failed: boolean) => void;

export interface BackdropViewProps {
  id: BackdropId;
  /** A dance stage has the screen: the backdrop stands still and draws nothing. */
  paused?: boolean;
  /** Built and its shaders compiled (or crashed): from now on its frames are what it looks like. */
  onReady?: BackdropReadyHandler;
}

/**
 * One of the menu backdrops (packages/backdrops) behind the menus, in place of the Aero world.
 *
 * Like a dance stage (stage/StageView.tsx), the backdrop lives in a createPortal scene with its
 * own camera (BackdropCamera) and draws through the stages' RenderPipeline (bloom, grade, ACES)
 * at priority 1, with its own live post settings (backdropPost). It borrows the renderer's
 * shadow and tone-mapping settings while mounted and puts them back when it goes; what draws over
 * it sets its own (the menu dancers) or isn't tone mapped (the menus).
 *
 * It stands down at once whenever a stage holds the renderer (screenOwner.ts), as `paused`
 * arrives frames later; backdropPlay.paused stops its clock and animation meanwhile.
 *
 * <BackdropView id="koi" paused={stageShowing} onReady={(id, failed) => ...} />
 */
export default function BackdropView({ id, paused = false, onReady }: BackdropViewProps) {
  // A fresh scene for each backdrop, so none inherits another's fog, background or environment.
  const scene = useMemo(() => new THREE.Scene(), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Before every backdrop callback (priority 0) and the pipeline (1).
  useFrame(() => { backdropPlay.paused = pausedRef.current || screenOwner.stage; }, -1);
  useEffect(() => () => { backdropPlay.paused = false; }, []);
  return createPortal(<BackdropContent key={id} backdrop={byId(id)} onReady={onReady} />, scene);
}

const byId = (id: BackdropId): Backdrop => {
  const backdrop = BACKDROPS.find((b) => b.meta.id === id);
  if (!backdrop) throw Error(`Unknown backdrop "${id}"`);
  return backdrop;
};

const live = () => !backdropPlay.paused;

function BackdropContent({ backdrop, onReady }: { backdrop: Backdrop; onReady?: BackdropReadyHandler }) {
  const gl = useThree((state) => state.gl);
  const { meta, Component: Scene } = backdrop;

  useLayoutEffect(() => { resetBackdropPost(meta.post); }, [meta]);

  useLayoutEffect(() => {
    const saved = {
      toneMapping: gl.toneMapping,
      exposure: gl.toneMappingExposure,
      infoAutoReset: gl.info.autoReset,
      shadow: { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type, autoUpdate: gl.shadowMap.autoUpdate },
    };
    // Shadows are redrawn once a frame, by the backdrop's own render (below), not the overlays'.
    Object.assign(gl.shadowMap, { enabled: true, type: THREE.PCFShadowMap, autoUpdate: false, needsUpdate: true });
    return () => {
      Object.assign(gl, { toneMapping: saved.toneMapping, toneMappingExposure: saved.exposure });
      Object.assign(gl.shadowMap, saved.shadow);
      gl.shadowMap.needsUpdate = true;
      gl.info.autoReset = saved.infoAutoReset;
    };
  }, [gl]);

  useFrame(() => { if (live()) gl.shadowMap.needsUpdate = true; }, 0.9);

  return (
    <>
      <RenderPipeline samples={0} bloom={!diagnostic('nobloom')} settings={backdropPost} isEnabled={live} />
      <BackdropBoundary id={meta.id} fallback={<Ready id={meta.id} onReady={onReady} failed />}>
        <Suspense fallback={null}>
          <Scene />
          <Compile id={meta.id} onReady={onReady} />
        </Suspense>
      </BackdropBoundary>
    </>
  );
}

// Keeps a broken backdrop from taking down the menus.
class BackdropBoundary extends Component<{ id: BackdropId; fallback: ReactNode; children?: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown) { console.error(`[backdrop] "${this.props.id}" crashed:`, error); }
  render() { return this.state.error ? this.props.fallback : this.props.children; }
}

function Ready({ id, onReady, failed = false }: { id: BackdropId; onReady?: BackdropReadyHandler; failed?: boolean }) {
  useLayoutEffect(() => { onReady?.(id, failed); }, [id, onReady, failed]);
  return null;
}

// Frames the backdrop gets to draw after compiling before it counts as ready.
const SETTLE_FRAMES = 3;

/**
 * Mounts once the backdrop's module has loaded and its scene is built: compiles its programs
 * (in the background where the browser can) into a target like the pipeline's, so its first
 * frames don't stall, then reports it ready a few frames later.
 */
function Compile({ id, onReady }: { id: BackdropId; onReady?: BackdropReadyHandler }) {
  const gl = useThree((state) => state.gl);
  const get = useThree((state) => state.get);
  const report = useRef(onReady);
  report.current = onReady;
  useEffect(() => {
    let alive = true;
    let raf = 0;
    const { scene, camera } = get();
    const probe = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const settle = (frames = 0) => {
      if (!alive) return;
      if (frames >= SETTLE_FRAMES) { report.current?.(id, false); return; }
      raf = requestAnimationFrame(() => settle(frames + 1));
    };
    const target = gl.getRenderTarget();
    let compiled: Promise<unknown> = Promise.resolve();
    try {
      gl.setRenderTarget(probe);
      compiled = gl.compileAsync(scene, camera);
    } catch (error) {
      console.warn('[backdrop] compiling failed:', error);
    } finally {
      gl.setRenderTarget(target);
    }
    compiled.catch((error: unknown) => console.warn('[backdrop] compiling failed:', error)).finally(() => { probe.dispose(); settle(); });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [gl, get, id]);
  return null;
}
