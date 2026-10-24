// The 3D views shared by the Studio and the headless renderer:
//   <CharacterScene>: the glass characters on a plain floor, driven straight from the dance's
//     curves each frame (fast enough to follow a drag), unmirrored as filmed or mirrored.
//   <GameScene>: exactly what the game shows: the song's stage, its camera and post-processing,
//     and the compiled choreography played by the game's own Dancers, mirrored as the coach.
import { Suspense, useEffect, useLayoutEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Character from '../../../packages/character/Character.tsx';
import type { Pose, TrackCalibration } from '../../../packages/pose/choreography.ts';
import type { SongBundle } from '../../../packages/pose/song.ts';
import { defaultCast } from '../../../packages/pose/song.ts';
import Dancers, { DANCER_LOOKS, dancerSpot } from '../../../packages/stages/shared/Dancers.tsx';
import { STAGES } from '../../../packages/stages/index.ts';
import type { StageId } from '../../../packages/stages/index.ts';
import { RenderPipeline, resetPost } from '../../../packages/stages/shared/post.tsx';
import { stagePlay } from '../../../packages/stages/shared/hooks.ts';

function Environment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const generator = new THREE.PMREMGenerator(gl), room = new RoomEnvironment(), target = generator.fromScene(room, 0.04);
    scene.environment = target.texture;
    room.dispose(); generator.dispose();
    return () => { scene.environment = null; target.dispose(); };
  }, [gl, scene]);
  return null;
}
/** Reports once everything inside the same Suspense boundary has loaded and mounted. */
export function Ready({ onReady }: { onReady: () => void }) {
  useLayoutEffect(() => onReady(), [onReady]);
  return null;
}
export interface CharacterSceneProps {
  poses: RefObject<(Pose | null)[]>;
  calibrations: readonly TrackCalibration[];
  /** As the game's coach (mirrored), instead of as filmed. */
  mirror?: boolean;
  /** A dancer to show solid; the others are drawn fainter. */
  focus?: number | null;
  onReady?: () => void;
}
function PoseCharacter({ index, poses, calibration, opacity }: { index: number; poses: RefObject<(Pose | null)[]>; calibration: TrackCalibration; opacity: number }) {
  // Character reads poseRef.current each frame; this view of the shared array keeps it current.
  const poseRef = useMemo((): RefObject<Pose | null> => ({ get current() { return poses.current?.[index] ?? null; } } as RefObject<Pose | null>), [poses, index]);
  const look = useMemo(() => ({ ...DANCER_LOOKS[index % DANCER_LOOKS.length], opacity }), [index, opacity]);
  return <Character poseRef={poseRef} calibration={calibration} appearance={look} />;
}
/** Frames `count` dancers standing side by side: closer for one, wider for a crew. */
export function CharacterCamera({ count }: { count: number }) {
  const camera = useThree(s => s.camera);
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    // The character's head tops out about 3.4 units up; leave room for raised hands and a
    // lifted foot. Three or four dancers stand closer together and smaller (dancerSpot).
    const crew = count > 2, distance = count === 1 ? 10 : count === 2 ? 12.5 : 9.2;
    camera.fov = 32;
    camera.position.set(0, crew ? 1.9 : 2.4, distance);
    camera.lookAt(0, crew ? 1.2 : 1.75, 0);
    camera.updateProjectionMatrix();
  }, [camera, count]);
  return null;
}
export function CharacterScene({ poses, calibrations, mirror = false, focus = null, onReady }: CharacterSceneProps) {
  const count = calibrations.length;
  return (
    <>
      <CharacterCamera count={count} />
      <color attach="background" args={['#14313b']} />
      <hemisphereLight args={['#dbffff', '#1d615d', 1.8]} />
      <directionalLight position={[-3, 6, 5]} intensity={3} />
      <Environment />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[7.5, 96]} />
        <meshPhysicalMaterial color="#3f7681" metalness={0.35} roughness={0.28} />
      </mesh>
      <gridHelper args={[16, 32, '#3f8391', '#27545f']} position={[0, -0.01, 0]} />
      <Suspense fallback={null}>
        {calibrations.map((calibration, i) => {
          const spot = dancerSpot(i, count, 4);
          return (
            <group key={i} position={[spot.x, 0.015, 0]} scale={spot.scale}>
              <group scale={[mirror ? -1 : 1, 1, 1]}>
                <PoseCharacter index={i} poses={poses} calibration={calibration} opacity={focus === null || focus === i ? 0.85 : 0.45} />
              </group>
            </group>
          );
        })}
        {onReady && <Ready onReady={onReady} />}
      </Suspense>
    </>
  );
}
export interface GameSceneProps {
  stage: StageId;
  bundle: SongBundle;
  timeMs: () => number;
  /** The render buffer (the game's is 640×480) and the frame it's shown at (the game's is 16:9). */
  width: number; height: number; aspect?: number;
  onReady?: () => void;
}
const stageOf = (id: StageId) => STAGES.find(s => s.meta.id === id) ?? STAGES[0];
export function GameScene({ stage, bundle, timeMs, width, height, aspect = width / height, onReady }: GameSceneProps) {
  const { meta, Component } = stageOf(stage);
  const gl = useThree(s => s.gl), size = useThree(s => s.size);
  // Like the game: one fixed buffer, stretched to the displayed frame.
  useLayoutEffect(() => { gl.setSize(width, height, false); }, [gl, width, height, size.width, size.height]);
  const hud = useMemo(() => ({ scene: new THREE.Scene(), camera: new THREE.OrthographicCamera() }), []);
  const routine = useMemo(() => ({ bundle, cast: defaultCast(bundle.choreography.tracks.length, bundle.choreography.tracks.length), timeMs }), [bundle, timeMs]);
  useLayoutEffect(() => {
    resetPost(meta.post);
    stagePlay.dancing = true;
    return () => { stagePlay.dancing = false; };
  }, [meta]);
  return (
    <>
      <RenderPipeline hudScene={hud.scene} hudCamera={hud.camera} width={width} height={height} aspect={aspect} />
      <Suspense fallback={null}>
        <Component />
        <Dancers routine={routine} {...meta.dancers} />
        {onReady && <Ready onReady={onReady} />}
      </Suspense>
    </>
  );
}
