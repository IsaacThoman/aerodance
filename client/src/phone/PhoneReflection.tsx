import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Character from '../../../packages/character/Character.tsx';
import { MAX_PLAYERS } from '../../../packages/pose/choreography.ts';
import type { PlayerCount, Pose, TrackCalibration } from '../../../packages/pose/choreography.ts';
import { DANCER_LOOKS } from '../../../packages/stages/shared/Dancers.tsx';
import { createLivePlayer } from '../game/livePose.ts';
import { phoneDesign, phoneLayout } from './layout.ts';
import type { PhoneLink } from './PhoneLink.ts';

/*
 * The phone's mirror: each tracked player's glass character, copying them live inside the
 * setup preview (PhoneScreen leaves that rect clear). Mirrored like the game's own live
 * characters (stage/LivePanels.tsx), so a raised right hand shows on the right. Each
 * character calibrates from the player's first steady poses, as in a replay.
 *
 * <PhoneReflection visible link={link} playerCount={1} />
 */

// The character's height at scale 1 with its arms down.
const HEIGHT = 3.4;
// Player 1 on the left of the mirror, then the others to its right, this far apart.
const SPACING = 2.5;
const FOV = 30;
const PRESENT_MS = 400;
const LOOKS = DANCER_LOOKS.map((look) => ({ ...look, opacity: 0.92 }));

function Environment({ scene }: { scene: THREE.Scene }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    scene.environment = target.texture;
    room.dispose();
    pmrem.dispose();
    return () => { scene.environment = null; target.dispose(); };
  }, [gl, scene]);
  return null;
}

interface MirrorPlayerProps { id: number; x: number; poses: { current: (Pose | null)[] }; calibration: TrackCalibration | null; }
function MirrorPlayer({ id, x, poses, calibration }: MirrorPlayerProps) {
  const poseRef = useRef<Pose | null>(null);
  useFrame(() => { poseRef.current = poses.current[id] ?? null; }, -1);
  return (
    <group position={[x, 0, 0]} scale={[-1, 1, 1]}>
      {calibration && <Character poseRef={poseRef} calibration={calibration} appearance={LOOKS[id]} />}
    </group>
  );
}

export interface PhoneReflectionProps { visible: boolean; link: PhoneLink; playerCount: PlayerCount; }

export default function PhoneReflection({ visible, link, playerCount }: PhoneReflectionProps) {
  const gl = useThree((state) => state.gl);
  const stage = useMemo(() => new THREE.Scene(), []);
  const cam = useMemo(() => new THREE.PerspectiveCamera(FOV, 1, 0.5, 60), []);
  // A fresh calibration for every camera session and player count.
  const players = useMemo(() => Array.from({ length: MAX_PLAYERS }, (_, playerId) => createLivePlayer({ playerId })), [playerCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const present = useRef(Array<number>(MAX_PLAYERS).fill(-Infinity));
  const poses = useRef<(Pose | null)[]>(Array<Pose | null>(MAX_PLAYERS).fill(null));
  const [calibrations, setCalibrations] = useState<(TrackCalibration | null)[]>(Array<TrackCalibration | null>(MAX_PLAYERS).fill(null));

  useEffect(() => {
    const off = link.camera.subscribeRecords((event) => {
      if (!('record' in event)) return;
      const now = performance.now();
      for (const pose of event.record.poses) {
        if (pose.playerId >= playerCount) continue;
        present.current[pose.playerId] = now;
        players[pose.playerId].push(pose.landmarks, event.record.input, now);
      }
    });
    return () => { off(); };
  }, [link, players, playerCount]);

  useFrame(() => {
    const now = performance.now();
    poses.current = players.map((p, id) => p.frame(now, now - present.current[id] <= PRESENT_MS));
    if (players.some((p, id) => p.calibration !== calibrations[id])) setCalibrations(players.map((p) => p.calibration));
  }, -2);

  useFrame(() => {
    if (!visible) return;
    const buf = gl.getDrawingBufferSize(new THREE.Vector2());
    const el = gl.domElement;
    const L = phoneLayout(phoneDesign(el.clientWidth || 1, el.clientHeight || 1));
    const sx = buf.x / L.w, sy = buf.y / L.h;
    const r = L.preview;
    const x = Math.round(r.x * sx), w = Math.round(r.w * sx), h = Math.round(r.h * sy);
    const y = Math.round(buf.y - (r.y + r.h) * sy);
    if (w < 2 || h < 2) return;
    // Fit everyone, standing, with room for raised and outstretched arms.
    const aspect = w / h;
    const tan = Math.tan((FOV * Math.PI) / 360);
    const width = Math.max(4, (playerCount - 1) * SPACING + 3.6);
    const distance = Math.max((HEIGHT * 1.4) / 2 / tan, width / 2 / (tan * aspect));
    cam.aspect = aspect;
    cam.position.set(0, HEIGHT * 0.52, distance);
    cam.lookAt(0, HEIGHT * 0.5, 0);
    cam.updateProjectionMatrix();
    const pr = gl.getPixelRatio();
    const ac = gl.autoClear;
    const tm = gl.toneMapping;
    gl.autoClear = false;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.setViewport(x / pr, y / pr, w / pr, h / pr);
    gl.setScissor(x / pr, y / pr, w / pr, h / pr);
    gl.setScissorTest(true);
    gl.clearDepth();
    gl.render(stage, cam);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, buf.x / pr, buf.y / pr);
    gl.toneMapping = tm;
    gl.autoClear = ac;
  }, 1.5);

  const xs = Array.from({ length: playerCount }, (_, id) => (id - (playerCount - 1) / 2) * SPACING);
  return createPortal(
    <>
      <Environment scene={stage} />
      <hemisphereLight args={['#d9faff', '#489789', 1.3]} />
      <directionalLight position={[-6, 12, 8]} intensity={2.5} />
      <pointLight position={[0, 1.3, 3]} color="#65f7ff" intensity={8} distance={9} />
      {xs.map((x, id) => (
        <mesh key={`floor-${id}`} position={[x, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.9, 0.96, 64]} />
          <meshBasicMaterial color="#7affdc" transparent opacity={0.8} depthWrite={false} />
        </mesh>
      ))}
      <Suspense fallback={null}>
        {xs.map((x, id) => <MirrorPlayer key={id} id={id} x={x} poses={poses} calibration={calibrations[id]} />)}
      </Suspense>
    </>,
    stage,
  );
}
