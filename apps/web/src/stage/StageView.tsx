import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { STAGES, resolveStage } from '../../../../packages/stages/index.ts';
import type { DancerPlacement, Stage, StageId, StageMeta } from '../../../../packages/stages/index.ts';
import { RenderPipeline, resetPost } from '../../../../packages/stages/shared/post.tsx';
import Dancers from '../../../../packages/stages/shared/Dancers.tsx';
import { beat, stageOrbit, stagePlay } from '../../../../packages/stages/shared/hooks.ts';
import { loadMotion } from '../../../../packages/character/motion.ts';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import type { SongRoutine } from '../game/GameSession.ts';
import type { ResultsShow } from '../game/results.ts';
import ResultsDancers from './ResultsDancers.tsx';
import { diagnostic } from '../diagnostics.ts';
import { screenOwner } from '../screenOwner.ts';

/** How the stage is doing, reported through onState. */
export interface StageState {
  /** A stage has the screen (the Aero world should pause). */
  showing: boolean;
  /** The stage is built and its shaders compiled (or it failed): it's about to get, or has, the screen. */
  prepared: boolean;
  /** Mounted, compiled and unveiled. */
  ready: boolean;
  stage: StageId | null;
  failed: boolean;
  dancersFailed?: boolean;
}
export interface StageViewProps {
  active?: boolean;
  orbiting?: boolean;
  /** The song's stage id (openreef if unset or unknown). */
  stageId?: string | null;
  routine?: SongRoutine | null;
  /** The results reveal: swaps the reference dancers for the celebration. */
  results?: RefObject<ResultsShow | null> | null;
  onState?: (state: StageState) => void;
}
type ReadyHandler = (id: StageId, failed: boolean) => void;
/** The veil's opacity, and frames the shown stage has had to settle. */
interface Fade { value: number; settled: number; }

/**
 * The game's dance stages (packages/stages) inside its canvas, with the routine's dancers.
 *
 * Each stage was built to own a canvas: its StageCamera becomes the default camera, its
 * environment lights the default scene and RenderPipeline renders whatever those are. Here
 * the stage lives in a createPortal scene, whose store has its own scene and camera, so it
 * never touches the Aero world's.
 *
 * Coming from the world, a stage is mounted out of sight first: it loads, builds and compiles
 * its shaders (Precompile) while the world and the menus over it carry on, so nothing sits on
 * a blank screen. Once it's prepared (onState's `prepared`), a pale veil drawn over the world
 * (priority 1.6, under the menus) comes up, the stage takes the screen, and the veil goes down.
 * Changes of stage while one is on screen, and going back to the world, happen behind the veil:
 * up, swap, let the new stage settle for a few frames, down.
 *
 * While a stage has the screen it takes the renderer's shadow and tone-mapping settings and the
 * Aero world should pause (onState's `showing`); both are put back when it goes.
 *
 * On the results screen, `results` (a ref of { start, results, winner }) swaps the reference
 * dancers for the celebration (ResultsDancers).
 *
 * With `orbiting` (Song Select's preview) the stage camera slowly circles the dancers, and
 * swings back round to the front when it stops (the song starts).
 *
 * <StageView active orbiting stageId="openreef" routine={{ bundle, playerCount, timeMs, playing }} results={showRef}
 *   onState={({ showing, prepared, ready, stage, failed, dancersFailed }) => ...} />
 */

const FADE_UP = 0.25;
const FADE_DOWN = 0.6;
// A new stage gets this many frames to compile its shaders before it is revealed.
const SETTLE_FRAMES = 3;
const STAGE_BPM = beat.bpm;
// The preview's camera circles the dancers once a minute; a song brings it round to the
// front by the shorter way, settling within its countdown.
const ORBIT_SPEED = (Math.PI * 2) / 60;
const ORBIT_RETURN = 2.4;
const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const byId = new Map(STAGES.map((stage) => [stage.meta.id, stage]));
const stageFor = (id: StageId): Stage => {
  const stage = byId.get(id);
  if (!stage) throw Error(`Unknown stage "${id}"`);
  return stage;
};
const hasShow = (results: RefObject<ResultsShow | null>): results is RefObject<ResultsShow> => results.current !== null;

// Keeps one broken stage from taking down the game.
class StageBoundary extends Component<{ id: StageId; fallback: ReactNode; children?: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidCatch(error: unknown) { console.error(`[stage] "${this.props.id}" crashed:`, error); }
  render() { return this.state.error ? this.props.fallback : this.props.children; }
}

// The dancers can fail on their own (their model didn't load); the stage carries on without them.
class DancerBoundary extends Component<{ onFail: () => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('[stage] dancers could not load:', error); this.props.onFail(); }
  render() { return this.state.failed ? null : this.props.children; }
}

// The fallback of a stage that crashed: reports it as in, and failed.
function Ready({ onReady, id, failed = false }: { onReady: ReadyHandler; id: StageId; failed?: boolean }) {
  useLayoutEffect(() => { onReady(id, failed); }, [onReady, id, failed]);
  return null;
}

// The part of three's WebGLProgram that Precompile uses.
interface Program { isReady(): boolean; getUniforms(): unknown }

// A frame's worth of preparing the stage, so what's on screen keeps moving meanwhile.
const PREPARE_BUDGET_MS = 12;
// Objects drawn at a time while their geometry goes up to the GPU.
const UPLOAD_CHUNK = 6;

const isDrawable = (object: THREE.Object3D) => {
  const o = object as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return !!(o.isMesh || o.isPoints || o.isLine || o.isSprite);
};

/**
 * Mounts once the lazily loaded stage has resolved and been built, then gets it ready to draw
 * before reporting it in, instead of leaving all of it to the first frame that draws the stage
 * (which stalls the page, for seconds on slower GPUs). Everything goes into a 1×1 target with
 * the settings the stage draws with (its shadows; a render target, so no tone mapping), so the
 * programs it makes are the ones the stage's frames use. A few steps, a frame's budget at a time:
 *
 *   compile  start each program: one mesh per material and kind of object, as the rest share
 *            them. This blocks too (the browser checks and translates the shaders: over three
 *            seconds for a stage at once on an Intel iGPU under Windows).
 *   finish   with KHR_parallel_shader_compile, wait while the GPU finishes them in the
 *            background; without it, finishing one blocks, so a few at a time.
 *   upload   draw a few objects at a time (the rest hidden), which sends their geometry to
 *            the GPU and catches any program the compile step missed.
 *   shadows  one draw of it all with its shadow maps, which compiles their depth programs.
 */
function Precompile({ onReady, id }: { onReady: ReadyHandler; id: StageId }) {
  const gl = useThree((state) => state.gl);
  const get = useThree((state) => state.get);
  useEffect(() => {
    let alive = true;
    let frame = 0;
    // The portal's scene and the stage's camera (StageCamera made itself the default).
    const { scene, camera } = get();
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const shadows = !diagnostic('nostageshadows');
    const parallel = gl.extensions.has('KHR_parallel_shader_compile');

    const drawables: THREE.Object3D[] = [];
    const queue: THREE.Object3D[] = [];
    const seen = new Set<string>();
    scene.traverse((object) => {
      if (!isDrawable(object)) return;
      drawables.push(object);
      const { material } = object as THREE.Mesh;
      const kind = `${object.type}:${(object as THREE.InstancedMesh).instanceColor ? 'colored' : ''}`;
      const keys = (Array.isArray(material) ? material : [material]).filter(Boolean).map((m) => `${m.uuid}:${kind}`);
      if (!keys.length || keys.every((key) => seen.has(key))) return;
      keys.forEach((key) => seen.add(key));
      queue.push(object);
    });
    const programs = new Set<Program>();
    let uploaded = 0;
    let phase: 'compile' | 'finish' | 'upload' | 'shadows' = 'compile';

    // Runs fn drawing into the target with the stage's settings, then puts the world's back.
    const asStage = (fn: () => void) => {
      const { enabled, type, autoUpdate, needsUpdate } = gl.shadowMap;
      const saved = { target: gl.getRenderTarget(), enabled, type, autoUpdate, needsUpdate };
      try {
        gl.setRenderTarget(target);
        Object.assign(gl.shadowMap, { enabled: shadows, type: THREE.PCFShadowMap, autoUpdate: false, needsUpdate: false });
        fn();
      } catch (error) {
        // Only costs time: the first frame on screen does whatever is left.
        console.warn('[stage] preparing failed:', error);
        queue.length = 0;
        programs.clear();
        uploaded = drawables.length;
      } finally {
        gl.setRenderTarget(saved.target);
        Object.assign(gl.shadowMap, { enabled: saved.enabled, type: saved.type, autoUpdate: saved.autoUpdate, needsUpdate: saved.needsUpdate });
      }
    };
    const compile = (begin: number) => asStage(() => {
      while (queue.length && performance.now() - begin < PREPARE_BUDGET_MS) {
        const object = queue.shift();
        if (!object?.parent) continue;
        for (const material of gl.compile(object, camera, scene as THREE.Scene)) {
          const program = (gl.properties.get(material) as { currentProgram?: Program }).currentProgram;
          if (program) programs.add(program);
        }
      }
    });
    const finish = (begin: number) => {
      for (const program of programs) {
        if (parallel) {
          if (program.isReady()) programs.delete(program);
        } else {
          if (performance.now() - begin > PREPARE_BUDGET_MS) break;
          program.getUniforms();
          programs.delete(program);
        }
      }
    };
    const upload = (begin: number) => asStage(() => {
      while (uploaded < drawables.length && performance.now() - begin < PREPARE_BUDGET_MS) {
        const chunk = new Set(drawables.slice(uploaded, uploaded + UPLOAD_CHUNK));
        uploaded += UPLOAD_CHUNK;
        // Everything else hidden, and the chunk drawn even out of view (the camera moves).
        const saved = drawables.map((o) => [o, o.visible, o.frustumCulled] as const);
        for (const o of drawables) {
          if (chunk.has(o)) o.frustumCulled = false;
          else o.visible = false;
        }
        try {
          gl.render(scene, camera);
        } finally {
          for (const [o, visible, culled] of saved) {
            o.visible = visible;
            o.frustumCulled = culled;
          }
        }
      }
    });
    const drawShadows = () => asStage(() => {
      gl.shadowMap.needsUpdate = true;
      gl.render(scene, camera);
    });

    const step = () => {
      if (!alive) return;
      const begin = performance.now();
      if (phase === 'compile') {
        compile(begin);
        if (!queue.length) phase = 'finish';
      } else if (phase === 'finish') {
        finish(begin);
        if (!programs.size) phase = 'upload';
      } else if (phase === 'upload') {
        upload(begin);
        if (uploaded >= drawables.length) phase = 'shadows';
      } else {
        if (shadows) drawShadows();
        target.dispose();
        onReady(id, false);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    step();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      target.dispose();
    };
  }, [gl, get, onReady, id]);
  return null;
}

function Veil({ fade }: { fade: RefObject<Fade> }) {
  const gl = useThree((state) => state.gl);
  const layer = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({ color: '#f4fdff', transparent: true, toneMapped: false, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return { material, quad, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1) };
  }, []);
  useEffect(() => () => { layer.material.dispose(); layer.quad.geometry.dispose(); }, [layer]);
  useFrame(() => {
    const v = fade.current.value;
    if (v < 0.001) return;
    layer.material.opacity = v;
    const ac = gl.autoClear;
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(layer.scene, layer.camera);
    gl.autoClear = ac;
  }, 1.6);
  return null;
}

// The captured demo clip the results dancers celebrate to, loaded once.
let celebration: Promise<MotionTake> | null = null;
const loadCelebration = () => {
  celebration ??= fetch(motionUrl).then((r) => {
    if (!r.ok) throw Error('Celebration clip unavailable');
    return r.arrayBuffer();
  }).then(loadMotion);
  return celebration;
};

function Results({ show, floor, accent }: { show: RefObject<ResultsShow>; floor: DancerPlacement; accent: StageMeta['accent'] }) {
  const [motion, setMotion] = useState<MotionTake | null>(null);
  const playback = useRef(0);
  useEffect(() => {
    let alive = true;
    loadCelebration().then((m) => alive && setMotion(m), (error: unknown) => console.warn('[stage] results dancers:', error instanceof Error ? error.message : error));
    return () => { alive = false; };
  }, []);
  useFrame((_, delta) => { playback.current += Math.min(delta, 0.1); });
  return motion ? <ResultsDancers motion={motion} playback={playback} show={show} floor={floor} accent={accent} /> : null;
}

interface StageContentProps {
  id: StageId;
  /** On screen. Until then the stage is built and compiled out of sight while the world shows. */
  onScreen: boolean;
  routine: SongRoutine | null;
  results: RefObject<ResultsShow | null> | null;
  onReady: ReadyHandler;
  onDancersFail: () => void;
}

// Everything inside the portal: the pipeline, the stage and its dancers.
function StageContent({ id, onScreen, routine, results, onReady, onDancersFail }: StageContentProps) {
  const gl = useThree((state) => state.gl);
  const { meta, Component: Stage } = stageFor(id);

  // Borrow the renderer's settings while a stage is on screen (the Aero world sets its own once).
  useLayoutEffect(() => {
    if (!onScreen) return undefined;
    const saved = {
      toneMapping: gl.toneMapping,
      toneMappingExposure: gl.toneMappingExposure,
      autoClear: gl.autoClear,
      infoAutoReset: gl.info.autoReset,
      shadow: { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type, autoUpdate: gl.shadowMap.autoUpdate },
    };
    // The stage's shadows are redrawn every other frame (see below).
    Object.assign(gl.shadowMap, { enabled: !diagnostic('nostageshadows'), type: THREE.PCFShadowMap, autoUpdate: false });
    // The world stands down for exactly as long as its settings are borrowed.
    screenOwner.stage = true;
    return () => {
      Object.assign(gl, { toneMapping: saved.toneMapping, toneMappingExposure: saved.toneMappingExposure, autoClear: saved.autoClear });
      Object.assign(gl.shadowMap, saved.shadow);
      gl.info.autoReset = saved.infoAutoReset;
      gl.shadowMap.needsUpdate = true;
      beat.bpm = STAGE_BPM;
      screenOwner.stage = false;
    };
  }, [gl, onScreen]);

  useLayoutEffect(() => { resetPost(meta.post); }, [meta]);

  const frame = useRef(0);
  useFrame(() => { if (onScreen && frame.current++ % 2 === 0) gl.shadowMap.needsUpdate = true; }, 0.9);

  // Beat-reactive lights follow the song while it plays, when it knows its tempo.
  useFrame((_, delta) => {
    // Display metadata: only a numeric tempo drives the lights.
    const bpm = routine?.bundle.song.bpm;
    if (!routine || typeof bpm !== 'number' || !bpm || !routine.playing()) return;
    beat.bpm = bpm;
    // RenderPipeline's tickBeat adds this frame's delta next.
    beat.time = routine.timeMs() / 1000 - Math.min(delta, 0.1);
  }, 0.5);

  return (
    <>
      <RenderPipeline samples={0} bloom={!diagnostic('nobloom')} enabled={onScreen} />
      <StageBoundary key={id} id={id} fallback={<Ready onReady={onReady} id={id} failed />}>
        <Suspense fallback={null}>
          <Stage />
          <Precompile onReady={onReady} id={id} />
        </Suspense>
      </StageBoundary>
      {/* A new song or stage gives dancers that failed to load another try. */}
      <DancerBoundary key={`${id}|${routine?.bundle.song.songId ?? ''}|${results ? 'results' : 'dance'}`} onFail={onDancersFail}>
        {results
          ? hasShow(results) && <Results key={results.current.key} show={results} floor={meta.dancers} accent={meta.accent} />
          : <Dancers routine={routine} {...meta.dancers} />}
      </DancerBoundary>
    </>
  );
}

interface StageViewState {
  loaded: StageId | null;
  failed: Set<StageId>;
  dancersFailed: boolean;
  routine: SongRoutine | null;
  /** The stage last mounted (undefined before the first). */
  requested: StageId | null | undefined;
  /** The mounted stage has the screen (else it's being prepared out of sight). */
  onScreen: boolean;
  reported: string;
}

export default function StageView({ active = false, orbiting = false, stageId, routine, results = null, onState }: StageViewProps) {
  const scene = useMemo(() => new THREE.Scene(), []);
  const [shown, setShown] = useState<StageId | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const fade = useRef<Fade>({ value: 0, settled: 0 });
  const st = useRef<StageViewState>({ loaded: null, failed: new Set(), dancersFailed: false, routine: null, requested: undefined, onScreen: false, reported: '' }).current;
  const target = active ? resolveStage(stageId) : null;
  const props = useRef({ target, shown, onState, routine, orbiting, results });
  props.current = { target, shown, onState, routine, orbiting, results };
  useEffect(() => () => { Object.assign(stagePlay, { dancing: false, celebrating: false }); }, []);
  const orbit = useRef({ speed: 0, phase: 0, ramp: 0, on: false });
  // Keep dancing the last routine while the veil comes up on the way out.
  const lastRoutine = useRef<SongRoutine | null>(null);
  if (routine) lastRoutine.current = routine;
  else if (!shown) lastRoutine.current = null;

  const onReady = useMemo((): ReadyHandler => (id, failed) => {
    st.loaded = id;
    if (failed) st.failed.add(id);
  }, [st]);
  const onDancersFail = useMemo(() => () => { st.dancersFailed = true; }, [st]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    const f = fade.current;
    // A new stage, or none, starts facing the front. Orbiting eases up to speed; stopping
    // springs (critically damped, so without overshoot) round to the nearest front view.
    // Stages that can't be circled swing either way instead (meta.previewOrbit.swing).
    const o = orbit.current;
    const { target: want, shown: have, routine: current } = props.current;
    if (current && current !== st.routine) { st.routine = current; st.dancersFailed = false; }
    // Song Select's preview, the song and its results: stages calm their busiest effects.
    const playing = have !== null && want === have;
    stagePlay.dancing = playing && !props.current.results;
    stagePlay.celebrating = playing && !!props.current.results;
    if (have === null || !st.onScreen) {
      Object.assign(o, { speed: 0, phase: 0, ramp: 0, on: false });
      stageOrbit.yaw = 0;
    } else if (props.current.orbiting && want === have && !reducedMotion && dt > 0) {
      const swing = stageFor(have).meta.previewOrbit?.swing;
      // Pick up from wherever the camera is (it may still be swinging back from the last song).
      if (!o.on) Object.assign(o, { on: true, ramp: 0, phase: swing ? Math.asin(Math.max(-1, Math.min(1, stageOrbit.yaw / swing))) : stageOrbit.yaw });
      o.ramp += (1 - o.ramp) * Math.min(1, dt * 1.5);
      o.phase += o.ramp * dt * ORBIT_SPEED * (swing ? 2 : 1);
      const next = swing ? swing * Math.sin(o.phase) : o.phase;
      o.speed = (next - stageOrbit.yaw) / dt;
      stageOrbit.yaw = next;
    } else {
      o.on = false;
      const front = Math.round(stageOrbit.yaw / (Math.PI * 2)) * Math.PI * 2;
      o.speed += (ORBIT_RETURN ** 2 * (front - stageOrbit.yaw) - 2 * ORBIT_RETURN * o.speed) * dt;
      stageOrbit.yaw += o.speed * dt;
      if (Math.abs(front - stageOrbit.yaw) < 1e-4 && Math.abs(o.speed) < 1e-4) { stageOrbit.yaw = 0; o.speed = 0; }
    }
    const up = () => { f.value = Math.min(1, f.value + dt / FADE_UP); };
    const down = () => { f.value = Math.max(0, f.value - dt / FADE_DOWN); };
    // Mounts the next stage (or none); it starts from the front.
    const mount = (id: StageId | null) => {
      st.requested = id;
      st.loaded = null;
      if (id) st.failed.delete(id);
      st.dancersFailed = false;
      f.settled = 0;
      stageOrbit.yaw = 0;
      Object.assign(o, { speed: 0, on: false });
      setShown(id);
    };
    const putOnScreen = (on: boolean) => {
      st.onScreen = on;
      setOnScreen(on);
    };
    if (want !== have && st.onScreen) {
      // A stage has the screen: veil up, then swap what's mounted behind it.
      up();
      if (f.value >= 1 && st.requested !== want) {
        mount(want);
        if (!want) putOnScreen(false);
      }
    } else if (want !== have) {
      // The world has the screen: mount the next stage out of sight, to be built and compiled
      // while the world (and whatever menu is over it) carries on.
      down();
      if (st.requested !== want) mount(want);
    } else if (have !== null && !st.onScreen) {
      st.requested = have;
      // Built and compiled (or failed): veil up, then give it the screen.
      if (st.loaded === have) {
        up();
        if (f.value >= 1) {
          f.settled = 0;
          putOnScreen(true);
        }
      } else down();
    } else {
      st.requested = have;
      // Veil down once the stage is in and compiled; a stage that failed stays veiled.
      if (have === null || (st.loaded === have && !st.failed.has(have))) {
        f.settled += 1;
        if (have === null || f.settled > SETTLE_FRAMES) down();
      }
    }
    const showing = have !== null && st.onScreen;
    const prepared = have !== null && st.loaded === have;
    const ready = showing && prepared && f.value === 0;
    const failed = have !== null && st.failed.has(have);
    const report = `${have}|${showing}|${prepared}|${ready}|${failed}|${st.dancersFailed}`;
    if (report !== st.reported) {
      st.reported = report;
      const { dataset } = state.gl.domElement;
      dataset.stage = have ?? '';
      dataset.stageReady = String(ready);
      props.current.onState?.({ showing, prepared, ready, stage: have, failed, dancersFailed: st.dancersFailed });
    }
  });

  return (
    <>
      {shown && createPortal(<StageContent id={shown} onScreen={onScreen} routine={routine ?? lastRoutine.current} results={results} onReady={onReady} onDancersFail={onDancersFail} />, scene)}
      <Veil fade={fade} />
    </>
  );
}
