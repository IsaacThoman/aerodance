import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import { ACESFilmicToneMapping, Color, NoToneMapping, PCFShadowMap, PerspectiveCamera, Scene } from 'three';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { drawGlassButton, drawGlassCircle, drawHeader, drawShadowText, glassCorner, ICONS } from '../ui/draw.ts';
import type { IconDraw } from '../ui/draw.ts';
import { screensaverLayout } from './layout.ts';

const scenes = [
  { id: 'rally', title: 'Canopy Rally', views: ['Courtside', 'Skybox'], Content: lazy(() => import('./Rally.tsx')) },
  { id: 'lagoon', title: 'Moonjelly Lagoon', views: ['Reef window', 'Drift current'], Content: lazy(() => import('./Lagoon.tsx')) },
];
const preferenceKey = 'aerodance.screensavers';
function remembered() {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
    const scene = Math.max(0, scenes.findIndex(s => s.id === value?.scene));
    return { scene, view: value?.view === 1 ? 1 : 0, clock: value?.clock !== false };
  } catch {
    return { scene: 0, view: 0, clock: true };
  }
}

const clockIcon: IconDraw = (g, x, y, size) => {
  const r = size * 0.46;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.moveTo(x, y - r * 0.63);
  g.lineTo(x, y);
  g.lineTo(x + r * 0.45, y + r * 0.2);
  g.stroke();
};

// Keep the browser available if one scene's assets fail to load.
class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('Screensaver scene failed', error); this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

// Mounts with the scene after its lazy module and suspended assets resolve.
function Ready({ onReady }: { onReady: () => void }) {
  useLayoutEffect(onReady, [onReady]);
  return null;
}

function SceneFrame({ rally }: { rally: boolean }) {
  useFrame(({ gl, scene, camera }) => {
    const clear = gl.autoClear;
    const shadows = gl.shadowMap;
    const { enabled, type, autoUpdate, needsUpdate } = shadows;
    const mapping = gl.toneMapping, exposure = gl.toneMappingExposure;
    // The skyline freezes its shadow map between updates. This pass needs its
    // own live shadows for the moving paddles, and the arena's exposure.
    gl.autoClear = true;
    shadows.enabled = rally;
    shadows.type = PCFShadowMap;
    shadows.autoUpdate = rally;
    gl.toneMapping = rally ? ACESFilmicToneMapping : NoToneMapping;
    gl.toneMappingExposure = rally ? 0.92 : 1;
    try {
      gl.render(scene, camera);
    } finally {
      Object.assign(shadows, { enabled, type, autoUpdate, needsUpdate });
      gl.autoClear = clear;
      gl.toneMapping = mapping;
      gl.toneMappingExposure = exposure;
    }
  }, 1.9);
  return null;
}

export default function Screensavers({ onBack }: { onBack: () => void }) {
  const gl = useThree(s => s.gl);
  const size = useThree(s => s.size);
  const [{ scene, view, clock }, setChoice] = useState(remembered);
  const [watching, setWatching] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const markReady = useCallback(() => setStatus('ready'), []);
  const current = scenes[scene];
  const world = useMemo(() => {
    const result = new Scene();
    result.background = new Color('#124459');
    return result;
  }, []);
  const camera = useMemo(() => new PerspectiveCamera(48, 1, 0.05, 1000), []);
  useLayoutEffect(() => {
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
  }, [camera, size]);
  // Browsers release the display lock in the background. Reacquire it on return,
  // and release even a pending request when the viewer leaves Watch.
  useEffect(() => {
    if (!watching || !navigator.wakeLock) return;
    let active = true;
    let lock: WakeLockSentinel | undefined;
    const keepAwake = async () => {
      if (document.hidden || (lock && !lock.released)) return;
      try {
        const acquired = await navigator.wakeLock.request('screen');
        if (active && (!lock || lock.released)) lock = acquired;
        else void acquired.release();
      } catch { /* the host controls whether the display may stay awake */ }
    };
    void keepAwake();
    document.addEventListener('visibilitychange', keepAwake);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', keepAwake);
      void lock?.release();
    };
  }, [watching]);
  const portalState = useMemo(() => ({ camera }), [camera]);
  const fade = useRef(0);
  const hintUntil = useRef(0);
  const stepScene = (direction: number) => {
    setStatus('loading');
    setChoice(c => ({ ...c, scene: (c.scene + scenes.length + direction) % scenes.length, view: 0 }));
  };
  const stepView = () => setChoice(c => ({ ...c, view: (c.view + 1) % current.views.length }));
  const ui = useCanvasUI({
    priority: 3,
    keyNav: !watching,
    widgets: ({ w, h }): Widget[] => {
      if (watching) return [{ id: 'wake', rect: { x: 0, y: 0, w, h }, nav: false }];
      const l = screensaverLayout(w);
      return [
        { id: 'prev', circle: l.SAVER_PREV }, { id: 'next', circle: l.SAVER_NEXT },
        { id: 'watch', rect: l.SAVER_WATCH, primary: true, corner: glassCorner(l.SAVER_WATCH.h) },
        { id: 'view', rect: l.SAVER_VIEW, corner: glassCorner(l.SAVER_VIEW.h) },
        { id: 'clock', rect: l.SAVER_CLOCK, corner: glassCorner(l.SAVER_CLOCK.h) },
        { id: 'back', circle: l.SAVER_BACK },
      ];
    },
    onActivate: ({ id }, s) => {
      if (id === 'wake') setWatching(false);
      if (id === 'back') onBack();
      if (id === 'prev' || id === 'next') stepScene(id === 'prev' ? -1 : 1);
      if (id === 'view') stepView();
      if (id === 'clock') setChoice(c => ({ ...c, clock: !c.clock }));
      if (id === 'watch' && status !== 'failed') {
        s.focus(null);
        hintUntil.current = s.time + 2.4;
        setWatching(true);
      }
    },
    onStep: ({ id }, dir) => {
      if (id === 'view') { stepView(); return true; }
      if (id === 'prev' || id === 'next') { stepScene(dir); return true; }
      return false;
    },
    onKey: e => {
      if (e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (watching && ['Enter', ' ', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        setWatching(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      }
    },
    update: (_, s) => { fade.current = s.ease(fade.current, !watching || s.time < hintUntil.current ? 1 : 0, 8); },
    opacity: () => fade.current,
    draw: (g, s) => {
      if (watching) {
        drawShadowText(g, 'Tap or press OK to show controls', s.w / 2, 830, { size: 26, align: 'center' });
        return;
      }
      const l = screensaverLayout(s.w), x = l.SAVER_WATCH.x;
      const shade = g.createLinearGradient(0, 520, 0, 900);
      shade.addColorStop(0, 'rgba(5,29,52,0)');
      shade.addColorStop(0.48, 'rgba(5,29,52,0.61)');
      shade.addColorStop(1, 'rgba(4,24,45,0.94)');
      g.fillStyle = shade;
      g.fillRect(0, 520, s.w, 380);
      drawHeader(g, l.SAVER_BACK, 'SCREENSAVERS', s.hover.back ?? 0);
      drawShadowText(g, current.title, x, 650, { size: 66, weight: 700 });
      drawShadowText(g, status === 'loading' ? 'Opening scene…' : status === 'failed' ? 'Scene unavailable' : `Scene ${scene + 1} of ${scenes.length}`, x + 2, 707, { size: 26, weight: 500 });
      for (const [id, c, icon] of [['prev', l.SAVER_PREV, 'left'], ['next', l.SAVER_NEXT, 'right']] as const) {
        drawGlassCircle(g, c, s.hover[id] ?? 0);
        g.strokeStyle = '#ffffff';
        g.lineCap = g.lineJoin = 'round';
        g.lineWidth = 4;
        ICONS[icon](g, c.x, c.y, c.r * 1.3);
      }
      drawGlassButton(g, l.SAVER_WATCH, { label: 'Watch', icon: 'play', hover: s.hover.watch, disabled: status === 'failed', chevron: false });
      drawGlassButton(g, l.SAVER_VIEW, { label: current.views[view], sub: 'Camera view', icon: 'camera', hover: s.hover.view, chevron: false });
      drawGlassButton(g, l.SAVER_CLOCK, { label: clock ? 'Clock on' : 'Clock off', sub: 'Scene clock', icon: clockIcon, hover: s.hover.clock, chevron: false });
    },
  });

  useLayoutEffect(() => {
    ui.invalidate();
    const data = gl.domElement.dataset;
    data.screensaverScene = current.id;
    data.screensaverReady = String(status === 'ready');
    data.screensaverView = current.views[view];
    data.screensaverClock = String(clock);
    data.screensaverMode = watching ? 'watch' : 'browse';
    return () => {
      delete data.screensaverScene;
      delete data.screensaverReady;
      delete data.screensaverView;
      delete data.screensaverClock;
      delete data.screensaverMode;
    };
  }, [gl, current, view, clock, watching, ui, status]);
  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ scene: current.id, view, clock })); } catch { /* unavailable */ }
  }, [current, view, clock]);

  return createPortal(<>
    <SceneFrame rally={current.id === 'rally'} />
    <SceneBoundary key={current.id} onError={() => { setStatus('failed'); setWatching(false); }}>
      <Suspense fallback={null}>
        <current.Content view={view} clock={clock} />
        <Ready onReady={markReady} />
      </Suspense>
    </SceneBoundary>
  </>, world, portalState);
}
