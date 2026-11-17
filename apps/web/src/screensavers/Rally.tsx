import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import BiodomeArena, { BIODOME_FAR } from '../../../../packages/arenas/biodome/BiodomeArena.tsx';
import { Ball } from '../../../../packages/arenas/shared/Gear.tsx';
import Character from '../../../../packages/character/Character.tsx';
import { neutralCharacterPose } from '../../../../packages/pose/performance.ts';
import TorvenArm from '../../../../packages/robots/arms/sixaxis/Arm.tsx';
import { ARM_METAS, TABLE, stationOf } from '../../../../packages/robots/layout.ts';
import { Paddle } from '../../../../packages/robots/shared/Paddle.tsx';
import { fromStation, makeTarget, Rally as RallySimulation } from '../../../../packages/robots/shared/rally.ts';
import { createDriver, updateDriver } from '../../../../packages/robots/shared/station.ts';
import { carriageFor } from '../minigames/table-tennis/robot.ts';
import { reducedMotion, useDisposable } from '../../../../packages/stages/shared/hooks.ts';

const HALF = TABLE.length / 2;
const DANCER_SCALE = 0.49;
const PADDLE_SCALE = 1.4;
const APPEARANCE = { color: '#1898ff', gloss: 82, opacity: 0.94, accessory: 'None' };
const TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

// Both players follow the same shots as the robotics hall. Work in its table
// frame (+X along play), then turn the whole rally onto the Biodome's table.
function Players() {
  const match = useMemo(() => {
    const station = stationOf('sixaxis');
    const rally = new RallySimulation(station.table);
    return {
      rally, robot: createDriver(station, ARM_METAS.find(arm => arm.id === station.arm)!, rally),
      player: makeTarget(), grip: new THREE.Vector3(), time: 1,
    };
  }, []);
  const ball = useRef<THREE.Group>(null);
  const paddle = useRef<THREE.Group>(null);
  const dancer = useRef<THREE.Group>(null);
  const pose = useRef(neutralCharacterPose());
  const steps = useRef({
    leftFoot: { z: 0.27 + 0.51 * DANCER_SCALE, lift: 0 },
    rightFoot: { z: 0.27 - 0.54 * DANCER_SCALE, lift: 0 },
  });
  const trackAt = useMemo(() => () => carriageFor(match.robot.target.position.z), [match]);

  useFrame((_, delta) => {
    if (!ball.current || !paddle.current || !dancer.current) return;
    const { rally, robot, player, grip } = match;
    const t = match.time += Math.min(delta, 0.1) * (reducedMotion ? 0.55 : 0.9);
    rally.advance(t);
    rally.ball(t, ball.current.position);
    updateDriver(robot, rally, t, ball.current.position);
    rally.paddle('B', t, player);
    fromStation('B', player.position, paddle.current.position);
    paddle.current.quaternion.copy(TURN).multiply(player.quaternion);
    // A slight roll exposes the blade in profile and puts the handle into the mitt.
    paddle.current.rotateZ(-0.48);
    grip.set(0, -0.15 * PADDLE_SCALE, 0).applyQuaternion(paddle.current.quaternion).add(paddle.current.position);

    const body = dancer.current;
    const stance = THREE.MathUtils.clamp(grip.z * 0.65 + 0.27, -0.34, 0.66);
    body.position.z = THREE.MathUtils.damp(body.position.z, stance, 6, delta);
    const p = pose.current;
    const weight = THREE.MathUtils.clamp(player.velocity.x, -1.8, 1.8);
    const bob = Math.cos(t * 4.4) * 0.04;
    p.body[1] = 1.13 + bob;
    p.bodyRotation[0] = 8 + weight * 3;
    p.bodyRotation[1] = -15 + weight * 9;
    p.head[1] = 2.77 + bob;
    p.head[2] = 0.19;
    p.headRotation[1] = THREE.MathUtils.clamp((ball.current.position.z - body.position.z) * 19, -20, 20);
    p.handScale = 0.72;
    p.leftHand[0] = 0.85;
    p.leftHand[1] = 1.55 - weight * 0.08;
    p.leftHand[2] = 0.49;
    p.rightHand[0] = (grip.z - body.position.z) / DANCER_SCALE;
    p.rightHand[1] = grip.y / DANCER_SCALE;
    p.rightHand[2] = (body.position.x - grip.x) / DANCER_SCALE;
    // Keep a foot planted until the shuffle takes the body far enough to
    // warrant a step. The two staggered thresholds give the stance some weight.
    for (const foot of ['leftFoot', 'rightFoot'] as const) {
      const step = steps.current[foot];
      const goal = body.position.z + (foot === 'leftFoot' ? 0.51 : -0.54) * DANCER_SCALE;
      const distance = goal - step.z;
      if (Math.abs(distance) > (foot === 'leftFoot' ? 0.10 : 0.14)) step.lift = 1;
      if (step.lift > 0) {
        step.z = THREE.MathUtils.damp(step.z, goal, 14, delta);
        step.lift = Math.max(0, step.lift - 5 * delta);
      }
      p[foot][0] = (step.z - body.position.z) / DANCER_SCALE;
      p[foot][1] = 0.30 + Math.sin(Math.PI * step.lift) * 0.15;
    }
    p.leftFoot[2] = 0.22;
    p.rightFoot[2] = -0.23;
  }, -1);

  return <group rotation-y={-Math.PI / 2}>
    <group position-x={-HALF}><TorvenArm driver={match.robot} trackAt={trackAt} /></group>
    <group ref={dancer} position={[2.23, 0, 0.27]} rotation-y={-Math.PI / 2} scale={DANCER_SCALE}>
      <Character appearance={APPEARANCE} performanceRef={pose} />
    </group>
    <group ref={paddle} scale={PADDLE_SCALE}><Paddle /></group>
    <group ref={ball}><Ball position={[0, 0, 0]} color="#ff7b23" glow={0.42} /></group>
  </group>;
}

// Fired-enamel clock face, on a post just inside the balustrade.
function dialTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f3f8eb';
  ctx.fillRect(0, 0, 512, 512);
  ctx.translate(256, 256);
  for (let i = 0; i < 60; i++) {
    ctx.save();
    ctx.rotate(i * Math.PI / 30);
    ctx.fillStyle = '#164d4e';
    const major = i % 5 === 0;
    ctx.fillRect(major ? -4 : -1.4, -236, major ? 8 : 2.8, major ? 28 : 11);
    ctx.restore();
  }
  ctx.fillStyle = '#164d4e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 48px sans-serif';
  for (const hour of [3, 6, 9, 12]) {
    const a = hour * Math.PI / 6;
    ctx.fillText(String(hour), Math.sin(a) * 176, -Math.cos(a) * 176);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function DialHand({ length, width, color, z }: { length: number; width: number; color: string; z: number }) {
  return <mesh position={[0, length * 0.4, z]}>
    <boxGeometry args={[width, length, 0.007]} />
    <meshBasicMaterial color={color} />
  </mesh>;
}

function PavilionClock() {
  const face = useDisposable(dialTexture);
  const hour = useRef<THREE.Group>(null), minute = useRef<THREE.Group>(null), second = useRef<THREE.Group>(null);
  const previous = useRef(-1);
  useFrame(() => {
    const stamp = Math.floor(Date.now() / 1000);
    if (stamp === previous.current) return;
    previous.current = stamp;
    const now = new Date(stamp * 1000);
    const minutes = now.getMinutes() + now.getSeconds() / 60;
    if (hour.current) hour.current.rotation.z = -(now.getHours() + minutes / 60) * Math.PI / 6;
    if (minute.current) minute.current.rotation.z = -minutes * Math.PI / 30;
    if (second.current) second.current.rotation.z = -now.getSeconds() * Math.PI / 30;
  });

  return <group position={[-3.35, 0, 1.3]} rotation-y={Math.PI * 0.48}>
    <mesh position-y={0.055} castShadow><cylinderGeometry args={[0.13, 0.21, 0.11, 32]} /><meshStandardMaterial color="#a8bcb9" /></mesh>
    <mesh position-y={1.07} castShadow><cylinderGeometry args={[0.036, 0.055, 2.12, 20]} /><meshStandardMaterial color="#e3ede6" metalness={0.45} roughness={0.28} /></mesh>
    <group position-y={2.28}>
      <mesh rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[0.395, 0.39, 0.1, 64]} /><meshStandardMaterial color="#197874" metalness={0.35} roughness={0.23} /></mesh>
      <mesh position-z={0.052}><circleGeometry args={[0.366, 64]} /><meshBasicMaterial map={face} /></mesh>
      <group ref={hour}><DialHand length={0.192} width={0.024} color="#143d45" z={0.063} /></group>
      <group ref={minute}><DialHand length={0.294} width={0.016} color="#143d45" z={0.074} /></group>
      <group ref={second}><DialHand length={0.34} width={0.007} color="#fa6227" z={0.084} /></group>
      <mesh position-z={0.091}><circleGeometry args={[0.018, 24]} /><meshStandardMaterial color="#f57140" /></mesh>
    </group>
  </group>;
}

function Camera({ view }: { view: number }) {
  const camera = useThree(state => state.camera) as THREE.PerspectiveCamera;
  const elapsed = useRef(0);
  useLayoutEffect(() => {
    camera.near = 0.05;
    camera.far = BIODOME_FAR;
    camera.updateProjectionMatrix();
  }, [camera]);
  useFrame((_, delta) => {
    elapsed.current += Math.min(delta, 0.1);
    const drift = reducedMotion ? 0 : Math.sin(elapsed.current * 0.066);
    const skybox = view === 1;
    const fov = (skybox ? 36 : 47) * Math.max(1, 1.65 / camera.aspect);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    if (skybox) camera.position.set(5.8 + drift * 0.22, 5.3, 4.6 + drift * 0.38);
    else camera.position.set(4.6, 2.29 + drift * 0.06, -3.42 + drift * 0.22);
    camera.lookAt(-0.35, skybox ? 0.76 : 1.12, -0.68);
  }, -1);
  return null;
}

export default function Rally({ view, clock }: { view: number; clock: boolean }) {
  return <>
    <Camera view={view} />
    <BiodomeArena><Players />{clock && <PavilionClock />}</BiodomeArena>
  </>;
}
