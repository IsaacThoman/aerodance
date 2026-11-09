import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { PADDLE } from '../layout.ts';
import { extrude, loft, merge } from './geometry.ts';
import type { StationDriver } from './station.ts';

// The blade's outline, around its own centre: a classic round-shouldered blade, a little
// wider than tall at the top, narrowing into the handle's shoulder.
function bladeShape(inset = 0): THREE.Shape {
  const w = PADDLE.bladeWidth / 2 - inset;
  const h = PADDLE.bladeHeight / 2 - inset;
  const s = new THREE.Shape();
  s.moveTo(0, -h);
  s.bezierCurveTo(w * 0.62, -h, w, -h * 0.55, w, h * 0.02);
  s.bezierCurveTo(w, h * 0.62, w * 0.58, h, 0, h);
  s.bezierCurveTo(-w * 0.58, h, -w, h * 0.62, -w, h * 0.02);
  s.bezierCurveTo(-w, -h * 0.55, -w * 0.62, -h, 0, -h);
  return s;
}

const WOOD = 0.0058;
const RUBBER = (PADDLE.thickness - WOOD) / 2;

/** The paddle's parts, built once and shared by every paddle in the hall. */
function makePaddle() {
  const lift = PADDLE.bladeLift;
  const wood = extrude(bladeShape(), WOOD, 0.0008, 40, { position: [0, lift, 0] });
  const rubber = (face: 1 | -1) => extrude(bladeShape(0.0012), RUBBER, 0.0004, 40, { position: [0, lift, face * (WOOD / 2 + RUBBER / 2)] });
  // The handle: a flared shakehand handle, a rounded section that swells towards the butt.
  const top = PADDLE.handleTop;
  const end = PADDLE.handleEnd;
  const length = top - end;
  const handle = loft([0, 0.12, 0.45, 0.8, 0.94, 1].map((f, i) => {
    const swell = [0.82, 0.86, 0.92, 1, 1.02, 0.9][i];
    return { y: top - f * length, w: PADDLE.handleWidth * swell, d: PADDLE.handleDepth * (i === 0 ? 0.4 : swell), r: 0.009 * swell };
  }), 5);
  // A cork-and-wood shoulder where the handle meets the blade, and a butt cap.
  const shoulder = loft([
    { y: top + 0.024, w: 0.046, d: WOOD + 0.0006, r: 0.002 },
    { y: top + 0.006, w: 0.036, d: PADDLE.handleDepth * 0.5, r: 0.006 },
    { y: top - 0.004, w: PADDLE.handleWidth * 0.84, d: PADDLE.handleDepth * 0.72, r: 0.008 },
  ], 4);
  const handleWood = merge([handle, shoulder]);
  handle.dispose();
  shoulder.dispose();
  const red = rubber(1);
  const black = rubber(-1);
  return {
    wood, red, black, handle: handleWood,
    materials: {
      // Blade ply: the edge shows the laminations.
      wood: new THREE.MeshStandardMaterial({ color: '#c99a62', roughness: 0.62 }),
      red: new THREE.MeshPhysicalMaterial({ color: '#c3141c', roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.5 }),
      black: new THREE.MeshPhysicalMaterial({ color: '#141416', roughness: 0.44, clearcoat: 0.35, clearcoatRoughness: 0.5 }),
      handle: new THREE.MeshPhysicalMaterial({ color: '#b98a55', roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
    },
  };
}

let shared: ReturnType<typeof makePaddle> | null = null;
const parts = () => (shared ??= makePaddle());

export interface PaddleProps {
  /** Registers the paddle with the arm's driver, so the hall can check it follows its target. */
  driver?: StationDriver;
  /** Where the paddle's frame (PADDLE) sits in its parent. */
  position?: THREE.Vector3Tuple;
  quaternion?: THREE.Quaternion;
  children?: ReactNode;
}

/**
 * A table tennis paddle, red rubber on +Z, black on -Z, the handle down -Y to PADDLE.handleEnd.
 * Put it in an arm's tool frame where the gripper holds it: its own origin is the hitting
 * centre, the point that has to land on the driver's target.
 *
 *   <group ref={toolFlange}><Paddle driver={driver} position={[0, 0.175, 0]} /></group>
 */
export function Paddle({ driver, position, quaternion, children }: PaddleProps) {
  const ref = useRef<THREE.Group>(null);
  const p = useMemo(parts, []);
  useLayoutEffect(() => {
    const group = ref.current;
    if (!driver || !group) return undefined;
    driver.paddle = group;
    return () => {
      if (driver.paddle === group) driver.paddle = null;
    };
  }, [driver]);
  return (
    <group ref={ref} position={position} quaternion={quaternion}>
      <mesh geometry={p.wood} material={p.materials.wood} castShadow receiveShadow />
      <mesh geometry={p.red} material={p.materials.red} castShadow receiveShadow />
      <mesh geometry={p.black} material={p.materials.black} castShadow receiveShadow />
      <mesh geometry={p.handle} material={p.materials.handle} castShadow receiveShadow />
      {children}
    </group>
  );
}
