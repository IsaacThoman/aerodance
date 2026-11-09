import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import type { Vec3 } from '../../stages/catalog.ts';
import { TABLE } from './Table.tsx';
import { mergeAll } from './Table.tsx';

export interface PaddleProps {
  position?: Vec3;
  /** Euler angles (radians, XYZ). At [0, 0, 0] the blade faces +z with the handle pointing down. */
  rotation?: Vec3;
  /** The two rubbers: forehand (+z face) and backhand. */
  rubbers?: readonly [THREE.ColorRepresentation, THREE.ColorRepresentation];
  /** The blade's wood showing round its edge, and the handle. */
  wood?: THREE.ColorRepresentation;
  /** The handle's flare and cap. */
  handle?: THREE.ColorRepresentation;
  scale?: number;
}

// Blade 15 × 16 cm, 6 mm of wood under 2 mm rubbers, handle 10 cm.
const BLADE_W = 0.15, BLADE_H = 0.16, WOOD = 0.006, RUBBER = 0.0022, HANDLE = 0.1;

function bladeShape(grow = 0): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, BLADE_W / 2 + grow, BLADE_H / 2 + grow, 0, Math.PI * 2, false, 0);
  return shape;
}

/**
 * A paddle: a wooden blade with a rubber each side and a flared handle. Its origin is the
 * blade's middle.
 *
 * <Paddle position={[0.3, TABLE.height + PADDLE_REST, 1.1]} rotation={[-Math.PI / 2, 0, 0.4]} rubbers={['#e8323c', '#141a24']} />
 */
export function Paddle({ position = [0, 0, 0], rotation = [0, 0, 0], rubbers = ['#e8323c', '#161c26'], wood = '#d9b98c', handle = '#2a8cff', scale = 1 }: PaddleProps) {
  const key = JSON.stringify([rubbers, wood, handle]);
  const parts = useDisposable(() => {
    const wood_ = new THREE.ExtrudeGeometry(bladeShape(), { depth: WOOD, bevelEnabled: false, curveSegments: 40 }).translate(0, 0, -WOOD / 2);
    // The blade's neck, down into the handle.
    const neck = new THREE.BoxGeometry(0.03, 0.04, WOOD).translate(0, -BLADE_H / 2 + 0.005, 0);
    const blade = mergeAll([wood_, neck]);
    const rubber = new THREE.ExtrudeGeometry(bladeShape(-0.001), { depth: RUBBER, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 40 });
    const front = rubber.clone().translate(0, 0, WOOD / 2);
    const back = rubber.clone().translate(0, 0, -WOOD / 2 - RUBBER);
    rubber.dispose();
    // The handle: flared towards the blade and at its butt, slightly flattened.
    const profile = [[0, 0], [0.016, 0], [0.0175, 0.008], [0.0145, 0.03], [0.0135, 0.06], [0.015, 0.085], [0.02, HANDLE - 0.004], [0.02, HANDLE], [0, HANDLE]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const grip = new THREE.LatheGeometry(profile, 24).scale(1, 1, 0.78).translate(0, -BLADE_H / 2 - HANDLE + 0.012, 0);
    const cap = new THREE.CylinderGeometry(0.0175, 0.0175, 0.006, 24).scale(1, 1, 0.78).translate(0, -BLADE_H / 2 - HANDLE + 0.012, 0);
    return {
      blade, front, back, grip, cap,
      woodMaterial: new THREE.MeshPhysicalMaterial({ color: wood, roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.3 }),
      frontMaterial: new THREE.MeshPhysicalMaterial({ color: rubbers[0], roughness: 0.62, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(rubbers[0]).lerp(new THREE.Color('#ffffff'), 0.4) }),
      backMaterial: new THREE.MeshPhysicalMaterial({ color: rubbers[1], roughness: 0.62, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(rubbers[1]).lerp(new THREE.Color('#ffffff'), 0.4) }),
      handleMaterial: new THREE.MeshPhysicalMaterial({ color: handle, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 }),
    };
  }, [key]);
  return (
    <group position={[position[0], position[1], position[2]]} rotation={[rotation[0], rotation[1], rotation[2]]} scale={scale}>
      <mesh geometry={parts.blade} material={parts.woodMaterial} castShadow />
      <mesh geometry={parts.front} material={parts.frontMaterial} castShadow />
      <mesh geometry={parts.back} material={parts.backMaterial} castShadow />
      <mesh geometry={parts.grip} material={parts.woodMaterial} castShadow />
      <mesh geometry={parts.cap} material={parts.handleMaterial} castShadow />
    </group>
  );
}

/** How far a paddle lying flat sits above what it lies on (its middle, half its thickness). */
export const PADDLE_REST = WOOD / 2 + RUBBER + 0.0006;

export interface BallProps {
  position?: Vec3;
  color?: THREE.ColorRepresentation;
  /** Light of its own (emissive, × the colour), for a ball that glows. */
  glow?: number;
}

/**
 * A 40 mm ball. Its origin is its centre: on a surface at height y, put it at y + TABLE.ball / 2.
 *
 * <Ball position={[0.2, TABLE.height + TABLE.ball / 2, 0.6]} color="#ffffff" />
 */
export function Ball({ position = [0, TABLE.height + TABLE.ball / 2, 0], color = '#fbfbf7', glow = 0 }: BallProps) {
  const parts = useDisposable(() => ({
    geometry: new THREE.SphereGeometry(TABLE.ball / 2, 24, 16),
    material: new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 0.35, clearcoatRoughness: 0.25, emissive: color, emissiveIntensity: glow }),
  }), [String(color), glow]);
  return <mesh position={[position[0], position[1], position[2]]} geometry={parts.geometry} material={parts.material} castShadow />;
}

export interface TableSetProps {
  /** Rubbers of the paddle at each end: [+z end, -z end]. */
  paddles?: readonly [readonly [THREE.ColorRepresentation, THREE.ColorRepresentation], readonly [THREE.ColorRepresentation, THREE.ColorRepresentation]];
  handles?: readonly [THREE.ColorRepresentation, THREE.ColorRepresentation];
  ball?: THREE.ColorRepresentation;
}

/**
 * Two paddles left lying at the table's ends and a ball on it, as if a game just stopped: put
 * it inside <Table> (or anywhere sharing its origin).
 */
export function TableSet({ paddles = [['#e8323c', '#161c26'], ['#161c26', '#e8323c']], handles = ['#2a8cff', '#ff7a2a'], ball = '#fbfbf7' }: TableSetProps) {
  const y = TABLE.height + PADDLE_REST;
  return (
    <>
      <Paddle position={[0.36, y, 1.06]} rotation={[-Math.PI / 2, 0, 0.55]} rubbers={paddles[0]} handle={handles[0]} />
      <Paddle position={[-0.42, y, -1.02]} rotation={[-Math.PI / 2, 0, Math.PI - 0.35]} rubbers={paddles[1]} handle={handles[1]} />
      <Ball position={[0.18, TABLE.height + TABLE.ball / 2, 0.42]} color={ball} />
    </>
  );
}
