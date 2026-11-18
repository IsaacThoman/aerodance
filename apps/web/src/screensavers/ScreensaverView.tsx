import { Component, Suspense, lazy, useEffect, useMemo, useReducer, useRef } from 'react';
import type { LazyExoticComponent, ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import Veil from '../stage/Veil.tsx';
import type { StageState } from '../stage/StageView.tsx';
import { clockFor, sceneFor } from './definition.ts';
import { useCameraViews } from './kit.ts';
import type { ScreensaverHost } from './host.ts';
import { sky } from './sky/sky.ts';
import type { SaverScene, ScreensaverComponent, ScreensaverContext, ScreensaverDefinition } from './types.ts';

/*
 * The 3D side of the screensavers, always mounted in the game's <Canvas>: it steps the host
 * (host.ts) each frame, mounts the screensaver showing (its `load`ed component, with its ctx; a
 * stage screensaver's inside the stage, ScreensaverStagePart), and draws the veil between
 * screensavers. What's behind a background or stage screensaver is App's
 * to draw (the menus' Scene, or StageView); this only watches for it to be ready.
 *
 * The canvas reports data-sv-shown (the screensaver mounted), -sv-scenario, -sv-view (the view
 * showing), -sv-ready (the veil down on the one wanted), -sv-sky (the time of day and weather
 * drawn: "dusk|rain") and the screensaver's own (ctx.report: data-sv-<key>), for play.ts and tests.
 *
 * <ScreensaverView host={host} stage={stageState} />
 */

const components = new Map<string, LazyExoticComponent<ScreensaverComponent>>();
const componentOf = (saver: ScreensaverDefinition) => {
  let c = components.get(saver.id);
  if (!c && saver.load) { c = lazy(saver.load); components.set(saver.id, c); }
  return c ?? null;
};

// A screensaver that throws stands down (the veil comes down on nothing) rather than taking the game with it.
class SaverBoundary extends Component<{ ctx: ScreensaverContext; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    console.error(`[screensavers] ${this.props.ctx.saver.id} crashed:`, error);
    this.props.ctx.ready();
  }
  render() { return this.state.failed ? null : this.props.children; }
}

// A background or stage screensaver with no part of its own: its scene's camera as it is, pushed
// right while the preview covers the left.
function SceneCamera({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, {});
  return null;
}

function Mounted({ ctx }: { ctx: ScreensaverContext }) {
  useEffect(() => { ctx.ready(); }, [ctx]);
  return null;
}

/** Where a screensaver's part goes: inside a stage's scene, a backdrop's, or beside everything (its own world, or the skyline's, which is the canvas's own scene). */
type PartPlace = 'stage' | 'backdrop' | 'world';
const placeOf = (scene: SaverScene): PartPlace => (scene === 'custom' ? 'world' : 'stage' in scene ? 'stage' : scene.background === 'skyline' ? 'world' : 'backdrop');

/**
 * The showing screensaver's own part (its `load`ed component, with its ctx), where it belongs:
 * inside the stage's or the backdrop's scene (App renders ScreensaverStagePart as StageView's
 * child and ScreensaverBackdropPart as the Scene's), so it can add things to it, lit and
 * post-processed with it; beside everything else otherwise.
 */
function SaverPart({ host, place }: { host: ScreensaverHost; place: PartPlace }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.onChange(rerender), [host]);
  const shown = host.shown;
  const scene = shown ? sceneFor(shown.saver, shown.scenario) : null;
  const here = !!scene && placeOf(scene) === place;
  const ctx = useMemo(() => (shown && here ? host.context(shown) : null), [host, shown, here]);
  const Saver = ctx ? componentOf(ctx.saver) : null;
  // A background or stage screensaver's own part is ready once it's mounted (its scene is watched
  // for separately); without one, at once. A 'custom' world says so itself.
  const custom = scene === 'custom';
  useEffect(() => { if (ctx && !Saver && !custom) ctx.ready(); }, [ctx, Saver, custom]);
  if (!ctx) return null;
  if (!Saver) return custom ? null : <SceneCamera key={host.key} ctx={ctx} />;
  return (
    <SaverBoundary key={host.key} ctx={ctx}>
      <Suspense fallback={null}>
        <Saver ctx={ctx} />
        {!custom && <Mounted ctx={ctx} />}
      </Suspense>
    </SaverBoundary>
  );
}

/** A stage screensaver's part, inside the stage's scene: <StageView>{saverStage && <ScreensaverStagePart host={host} />}</StageView>. */
export function ScreensaverStagePart({ host }: { host: ScreensaverHost }) {
  return <SaverPart host={host} place="stage" />;
}

/** A backdrop screensaver's part, inside the backdrop's scene: <Scene background={...}><ScreensaverBackdropPart host={host} /></Scene>. */
export function ScreensaverBackdropPart({ host }: { host: ScreensaverHost }) {
  return <SaverPart host={host} place="backdrop" />;
}

export default function ScreensaverView({ host, stage }: { host: ScreensaverHost; stage: StageState }) {
  const gl = useThree((s) => s.gl);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const reported = useRef<Record<string, string>>({});
  // What the report was last made from (made again only when something in it changes).
  const from = useRef({ shown: null as unknown, view: '', settled: false, clock: '', phase: '', kind: '', reports: -1 });

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const { dataset } = gl.domElement;
    const scene = host.scene();
    // Whether what's behind is ready: the menus' background (Scene reports it on the canvas), or a stage.
    const sceneReady = scene && typeof scene === 'object' && 'stage' in scene
      ? stageRef.current.ready && stageRef.current.stage === scene.stage
      : scene && typeof scene === 'object' ? dataset.background === scene.background && dataset.backgroundReady === 'true'
        : scene === null ? dataset.backgroundReady === 'true' : false;
    host.step(dt, !!sceneReady);
    // What the canvas reports, written only when it changes.
    const shown = host.shown;
    const state = shown ? sky.state() : null;
    const view = host.view(), settled = host.settled(), clock = shown ? clockFor(shown.saver, host.clockChoice) : '';
    const f = from.current;
    if (f.shown === shown && f.view === view && f.settled === settled && f.clock === clock && f.phase === (state?.phase ?? '')
      && f.kind === (state?.weather.kind ?? '') && f.reports === host.reportsVersion) return;
    Object.assign(f, { shown, view, settled, clock, phase: state?.phase ?? '', kind: state?.weather.kind ?? '', reports: host.reportsVersion });
    const next: Record<string, string> = shown ? {
      svShown: shown.saver.id, svScenario: shown.scenario, svView: view, svReady: String(settled),
      svSky: `${state!.phase}|${state!.weather.kind}`, svClock: clock, ...host.takeReports(),
    } : { svReady: String(settled) };
    const last = reported.current;
    for (const k of Object.keys(last)) if (!(k in next)) delete dataset[k];
    for (const [k, v] of Object.entries(next)) if (last[k] !== v) dataset[k] = v;
    reported.current = next;
  }, -1);

  return (
    <>
      <SaverPart host={host} place="world" />
      <Veil fade={{ current: host.fade }} />
    </>
  );
}
