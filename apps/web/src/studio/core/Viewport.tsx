// The coach view: the dance's glass characters, moving with the song clock. Two looks:
//   floor  a bright practice floor, quick to read while editing, mirrored or as filmed
//   stage  the song's own stage with the game's camera, post-processing and 640×480 picture,
//          mirrored as the game's coach: what players will follow
// Either way the characters are driven straight from the dance (edits in progress included),
// so nothing waits for a compile. Dancers listed in `live` follow the camera instead.
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Character from '../../../../../packages/character/Character.tsx';
import type { Pose, TrackCalibration } from '../../../../../packages/pose/choreography.ts';
import { createPerformanceSampler } from '../../../../../packages/pose/performance.ts';
import type { CharacterPose } from '../../../../../packages/pose/performance.ts';
import { DANCER_LOOKS, dancerSpot } from '../../../../../packages/stages/shared/Dancers.tsx';
import { STAGES } from '../../../../../packages/stages/index.ts';
import type { StageId } from '../../../../../packages/stages/index.ts';
import { RENDER_HEIGHT, RENDER_WIDTH, RenderPipeline, resetPost } from '../../../../../packages/stages/shared/post.tsx';
import { stagePlay } from '../../../../../packages/stages/shared/hooks.ts';
import { useCalibrations, useEvaluators, useProject, useSession } from './hooks.ts';
import type { LivePeople } from './live.ts';

export interface ViewportProps {
  view?: 'floor' | 'stage';
  /** Floor view: as the game's coach (mirrored, the default) or as filmed. The stage is always mirrored. */
  mirror?: boolean;
  /** A dancer to show solid; the others are drawn fainter. */
  focus?: number | null;
  /** People from the camera, and which camera slot each dancer follows (dancer index → slot). */
  live?: { people: LivePeople; slots: ReadonlyMap<number, number> } | null;
  /** The song time to show (default: the transport's). */
  timeMs?: () => number;
  className?: string;
  /** Drawn over the picture (labels, a countdown). */
  children?: ReactNode;
}
type PoseRefs = RefObject<(Pose | null)[]>;
type PerformanceRefs = RefObject<(CharacterPose | null)[]>;

class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  render() { return this.state.error ? <div className="viewport-note">The 3D view isn't available: {this.state.error}</div> : this.props.children; }
}
/** Feeds the characters their poses each frame; renders on demand while nothing moves. */
function Driver({ poses, performances, live, timeMs }: { poses: PoseRefs; performances: PerformanceRefs; live: ViewportProps['live']; timeMs?: () => number }) {
  const session = useSession(), { shown } = useProject(), evaluators = useEvaluators();
  const performers = useMemo(() => shown.dancers.map(d => createPerformanceSampler(d.performance ?? [])), [shown]);
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => session.transport.subscribe(() => invalidate()), [session, invalidate]);
  // (`live` too: the camera coming on while the song is paused has to start the drawing.)
  useEffect(() => { invalidate(); }, [shown, evaluators, live, invalidate]);
  useFrame(() => {
    const t = timeMs ? timeMs() : Math.max(0, session.transport.timeMs());
    poses.current = evaluators.map((e, i) => {
      const slot = live?.slots.get(i);
      if (slot !== undefined) return live!.people.poses.current[slot] ?? null;
      return { playerId: i, landmarks: e.landmarks(t) };
    });
    performances.current = performers.map((sample, i) => live?.slots.has(i) ? null : sample(t - shown.dancers[i].timeOffsetMs));
    // The camera's people move whether or not the song does.
    if (session.transport.state.playing || live) invalidate();
  }, -2);
  return null;
}
function Dancer({ index, poses, performances, calibration, opacity, live }: { index: number; poses: PoseRefs; performances: PerformanceRefs; calibration: TrackCalibration; opacity: number; live: boolean }) {
  const poseRef = useMemo((): RefObject<Pose | null> => ({ get current() { return poses.current?.[index] ?? null; } } as RefObject<Pose | null>), [poses, index]);
  const performanceRef = useMemo((): RefObject<CharacterPose | null> => ({ get current() { return performances.current?.[index] ?? null; } } as RefObject<CharacterPose | null>), [performances, index]);
  const look = useMemo(() => ({ ...DANCER_LOOKS[index % DANCER_LOOKS.length], opacity }), [index, opacity]);
  return <Character poseRef={poseRef} performanceRef={performanceRef} calibration={calibration} appearance={look} live={live} />;
}
/** The dancers side by side as the game stands them (shared/Dancers.tsx): mirrored like a coach unless `mirror` is off. */
function Dancers({ poses, performances, calibrations, focus, mirror, live, spacing = 4 }: { poses: PoseRefs; performances: PerformanceRefs;
  calibrations: readonly (TrackCalibration | null)[]; focus: number | null; mirror: boolean; live: ViewportProps['live']; spacing?: number }) {
  const count = calibrations.length;
  return (
    <Suspense fallback={null}>
      {calibrations.map((calibration, i) => {
        const spot = dancerSpot(i, count, spacing);
        return calibration && (
          <group key={i} position={[spot.x, 0, 0]} scale={spot.scale}>
            <group scale={[mirror ? -1 : 1, 1, 1]}>
              <Dancer index={i} poses={poses} performances={performances} calibration={calibration} opacity={focus === null || focus === i ? 0.85 : 0.4} live={!!live?.slots.has(i)} />
            </group>
          </group>
        );
      })}
    </Suspense>
  );
}
function FloorScene({ count }: { count: number }) {
  const { gl, scene, camera, size } = useThree();
  useEffect(() => {
    const generator = new THREE.PMREMGenerator(gl), room = new RoomEnvironment(), target = generator.fromScene(room, 0.04);
    scene.environment = target.texture;
    room.dispose(); generator.dispose();
    return () => { scene.environment = null; target.dispose(); };
  }, [gl, scene]);
  // Frames the dancers standing side by side: closer for one, wider for a crew, and further
  // back in a narrow pane so hands held out to the side stay in the picture.
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const widening = Math.max(1, 4 / 3 / (size.width / size.height) || 1), crew = count > 2;
    camera.fov = 32;
    camera.position.set(0, crew ? 1.9 : 2.4, (count === 1 ? 10 : count === 2 ? 12.5 : 9.2) * widening);
    camera.lookAt(0, crew ? 1.2 : 1.75, 0);
    camera.updateProjectionMatrix();
  }, [camera, count, size.width, size.height]);
  const sky = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 256;
    const g = canvas.getContext('2d')!, gradient = g.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#2a8fe8'); gradient.addColorStop(0.55, '#8fd4ff'); gradient.addColorStop(1, '#e9fbff');
    g.fillStyle = gradient; g.fillRect(0, 0, 4, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
  useEffect(() => () => sky.dispose(), [sky]);
  return (
    <>
      <primitive attach="background" object={sky} />
      <hemisphereLight args={['#ffffff', '#6fc5ff', 2.2]} />
      <directionalLight position={[-3, 6, 5]} intensity={2.6} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[9, 96]} />
        <meshPhysicalMaterial color="#c9f0ff" metalness={0.2} roughness={0.18} transparent opacity={0.9} />
      </mesh>
      <gridHelper args={[18, 18, '#ffffff', '#a9defa']} position={[0, -0.01, 0]} />
    </>
  );
}
const stageOf = (id: StageId) => STAGES.find(s => s.meta.id === id) ?? STAGES[0];
function StageScene({ stage, children }: { stage: StageId; children: ReactNode }) {
  const { meta, Component: Stage } = stageOf(stage);
  const gl = useThree(s => s.gl), size = useThree(s => s.size), invalidate = useThree(s => s.invalidate);
  // Like the game: one fixed buffer, stretched to the displayed frame.
  useLayoutEffect(() => { gl.setSize(RENDER_WIDTH, RENDER_HEIGHT, false); }, [gl, size.width, size.height]);
  const hud = useMemo(() => ({ scene: new THREE.Scene(), camera: new THREE.OrthographicCamera() }), []);
  useLayoutEffect(() => {
    resetPost(meta.post);
    stagePlay.dancing = true;
    return () => { stagePlay.dancing = false; };
  }, [meta]);
  // Stages animate by themselves (water, lights): keep drawing.
  useFrame(() => invalidate());
  const { position, rotationY, spacing, scale = 1 } = meta.dancers;
  return (
    <>
      <RenderPipeline hudScene={hud.scene} hudCamera={hud.camera} width={RENDER_WIDTH} height={RENDER_HEIGHT} aspect={16 / 9} />
      <Suspense fallback={null}>
        <Stage />
        <group position={[position[0], position[1] + 0.015 * scale, position[2]]} rotation={[0, rotationY, 0]} scale={scale} userData={{ spacing }}>{children}</group>
      </Suspense>
    </>
  );
}

export default function Viewport({ view = 'floor', mirror = true, focus = null, live = null, timeMs, className = '', children }: ViewportProps) {
  const { shown } = useProject(), measured = useCalibrations();
  const poses = useRef<(Pose | null)[]>([]), performances = useRef<(CharacterPose | null)[]>([]);
  // A dancer following the camera is sized from the person in front of it, once they've been seen whole.
  const calibrations = measured.map((c, i) => { const slot = live?.slots.get(i); return slot === undefined ? c : live!.people.calibrations[slot] ?? null; });
  const stage = shown.song.stage, spacing = stageOf(stage).meta.dancers.spacing;
  return (
    <div className={`viewport viewport-${view} ${className}`} data-view={view}>
      <Boundary>
        {view === 'floor' ? (
          <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true }}>
            <Driver poses={poses} performances={performances} live={live} timeMs={timeMs} />
            <FloorScene count={calibrations.length} />
            <group position={[0, 0.015, 0]}><Dancers poses={poses} performances={performances} calibrations={calibrations} focus={focus} mirror={mirror} live={live} /></group>
          </Canvas>
        ) : (
          <div className="viewport-game">
            <Canvas key={stage} frameloop="demand" dpr={1} flat gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}>
              <Driver poses={poses} performances={performances} live={live} timeMs={timeMs} />
              <StageScene stage={stage}>
                <Dancers poses={poses} performances={performances} calibrations={calibrations} focus={focus} mirror live={live} spacing={spacing} />
              </StageScene>
            </Canvas>
          </div>
        )}
      </Boundary>
      {children}
    </div>
  );
}
