import { useMemo } from 'react';
import * as THREE from 'three';
import TorvenArm from '../../../../../packages/robots/arms/sixaxis/Arm.tsx';
import { ARM_METAS, stationOf } from '../../../../../packages/robots/layout.ts';
import { makeTarget } from '../../../../../packages/robots/shared/rally.ts';
import type { StationDriver } from '../../../../../packages/robots/shared/station.ts';
import { TABLE } from './ball.ts';
import { carriageFor, toStation } from './robot.ts';
import type { ArmPose } from './robot.ts';

/*
 * Table Tennis's opponent: the Torven TR-30 six-axis arm on its floor track (from the robot hall,
 * packages/robots), at the far end of the table. Each frame the game says where the paddle is
 * (robot.ts, in the table's frame); the arm's own inverse kinematics put it there.
 */

/** The arm's driver: its station (the hall's centre table's far end, the frame it's drawn in) and the paddle's target. */
export function createRobotDriver(): StationDriver {
  const target = makeTarget();
  const meta = ARM_METAS.find((arm) => arm.id === 'sixaxis') ?? ARM_METAS[0];
  return {
    station: stationOf('sixaxis'), meta, target, time: 0, ball: new THREE.Vector3(), next: [],
    // Not known ahead: the arm is given its carriage's place instead of planning it (see Arm).
    sample: (_t, out = makeTarget()) => {
      out.position.copy(target.position); out.normal.copy(target.normal); out.quaternion.copy(target.quaternion);
      return out;
    },
    paddle: null, frame: null,
    stats: { position: 0, angle: 0, maxPosition: 0, maxAngle: 0, hitPosition: 0, hitAngle: 0, frames: 0 },
  };
}

/** Puts the driver's target on a paddle pose in the table's frame (robot.ts toStation). */
export function aimRobot(driver: StationDriver, pose: ArmPose): void {
  const p = toStation(pose.pos), n = toStation(pose.normal, false);
  driver.target.position.set(p.x, p.y, p.z);
  driver.target.normal.set(n.x, n.y, n.z).normalize();
}

/** The arm at the far end of the table (its middle at `tableZ` in the world), following its driver's target. */
export function RobotOpponent({ driver, tableZ }: { driver: StationDriver; tableZ: number }) {
  // The carriage: under the paddle's way across (robot.ts carriageFor).
  const carriage = useMemo(() => () => carriageFor(driver.target.position.z), [driver]);
  return (
    <group position={[0, 0, tableZ - TABLE.halfLength]} rotation-y={-Math.PI / 2}>
      <TorvenArm driver={driver} trackAt={carriage} />
    </group>
  );
}
