import * as THREE from 'three';
import type { WorldRandom } from './random.ts';
import type { AeroZone } from './types.ts';
import { TAU, clamp, sstep } from './util.ts';

/* ----------------------------------------------------------- flight path */
type Point = [number, number, number];
const P: Point[] = [[60, 3, 800], [32, 2.2, 700], [28, 2.6, 580], [33, 7, 450], [35, 19, 330], [35, 29, 240], [35, 34, 140], [35, 37, 40], [35, 39, -12], [30, 41, -30], [15, 42, -35], [-40, 44, -35], [-85, 46, -36], [-101, 48, -48], [-105, 51, -100], [-105, 56, -170], [-103, 66, -235], [-85, 90, -310], [-40, 140, -400], [60, 215, -480], [220, 280, -460], [380, 300, -300], [440, 282, -60], [420, 222, 180], [330, 130, 380], [230, 50, 560], [140, 12, 740]];

export interface FlightPath {
  readonly curve: THREE.CatmullRomCurve3;
  /** Loop length in metres. */
  readonly length: number;
  /** 1400 evenly spaced points along the loop. */
  readonly points: THREE.Vector3[];
  /** True if a sphere of radius r at (x, y, z) stays clear of the drone's path. */
  clearOfPath(x: number, y: number, z: number, r: number): boolean;
  /** A random spot near the low meadow pass: [x, z, nearest path point]. */
  nearMeadow(spread: number): [number, number, THREE.Vector3];
}

export function createFlightPath(random: WorldRandom): FlightPath {
  const curve = new THREE.CatmullRomCurve3(P.map((p) => new THREE.Vector3(...p)), true, 'centripetal');
  curve.arcLengthDivisions = 4000;
  const length = curve.getLength();
  const points = curve.getSpacedPoints(1400);
  const meadowPts = curve.getSpacedPoints(4000).filter((p) => p.y < 12 && p.z > 300);
  return {
    curve, length, points,
    clearOfPath(x, y, z, r) {
      const r2 = r * r;
      for (const p of points) { const dx = p.x - x, dy = p.y - y, dz = p.z - z; if (dx * dx + dy * dy + dz * dz < r2) return false; }
      return true;
    },
    nearMeadow(spread) { const p = random.pick(meadowPts); return [p.x + random.gauss() * spread, p.z + random.gauss() * spread, p]; },
  };
}

export function zoneName(p: THREE.Vector3): AeroZone {
  if (p.y > 262) return 'Above the clouds';
  if (p.y > 175) return 'Cloud layer';
  if (Math.abs(p.x) < 250 && Math.abs(p.z) < 250) return 'Downtown';
  if (p.z < -255 && p.z > -500) return 'The lake';
  if (p.z > 280 && p.y < 25) return 'Flower meadow';
  return 'Skyline';
}

/* ----------------------------------------------------------- drone camera */
export interface FlightFrame {
  /** Drone position on the path (before camera shake). */
  position: THREE.Vector3;
  /** 0..1 around the loop. */
  progress: number;
  /** Metres per second. */
  speed: number;
}

export interface DroneFlight {
  /** Advances along the path and moves the camera; t is the world clock. */
  update(dt: number, t: number): FlightFrame;
  setSpeed(n: number): void;
  readonly progress: number;
}

export interface DroneFlightOptions {
  start: number;
  speed: number;
  motionMul: number;
}

export function createDroneFlight(camera: THREE.PerspectiveCamera, path: FlightPath, { start, speed, motionMul }: DroneFlightOptions): DroneFlight {
  const { curve, length: LEN } = path;
  let s = clamp(start, 0, 0.999) * LEN, roll = 0, v = 10;
  let speedMul = speed;
  return {
    update(dt, t) {
      const p0 = curve.getPointAt(s / LEN);
      const vt = (9 + 26 * sstep(15, 260, p0.y)) * speedMul * motionMul;
      v += (vt - v) * Math.min(1, dt * 1.2);
      s = (((s + v * dt) % LEN) + LEN) % LEN;
      const u = s / LEN, p = curve.getPointAt(u); p.y = Math.max(p.y, 1.7);
      const look = curve.getPointAt(((s + 22) % LEN) / LEN); look.y = Math.max(look.y, 1.4);
      const sk = 0.35 + 0.65 * sstep(3, 40, p.y);
      camera.position.set(p.x + (Math.sin(t * 1.1) * 0.25 + Math.sin(t * 3.1) * 0.04) * sk, p.y + (Math.sin(t * 1.4) * 0.18 + Math.sin(t * 3.7) * 0.03) * sk, p.z + Math.cos(t * 0.9) * 0.2 * sk);
      camera.lookAt(look);
      const t1 = curve.getTangentAt(u), t2 = curve.getTangentAt(((s + 35) % LEN) / LEN);
      let dy = Math.atan2(t2.x, t2.z) - Math.atan2(t1.x, t1.z); if (dy > Math.PI) dy -= TAU; if (dy < -Math.PI) dy += TAU;
      roll += (clamp(dy * 1.3, -0.5, 0.5) - roll) * Math.min(1, dt * 1.8);
      camera.rotateZ(roll + Math.sin(t * 0.8) * 0.01 * sk);
      camera.updateMatrixWorld();
      return { position: p, progress: u, speed: v };
    },
    setSpeed(n) { speedMul = Math.max(0, +n || 0); },
    get progress() { return s / LEN; },
  };
}
