import * as THREE from 'three';
import type { ArmMeta, StationSpec } from '../layout.ts';
import { makeTarget } from './rally.ts';
import type { Contact, PaddleTarget, Rally } from './rally.ts';
import { toStation } from './rally.ts';

/** How closely an arm's paddle has followed its target. Distances in metres, angles in degrees. */
export interface TrackingStats {
  /** This frame. */
  position: number;
  angle: number;
  /** The worst over the last WINDOW_S seconds. */
  maxPosition: number;
  maxAngle: number;
  /** The worst on the frames the ball was struck, over the same window. */
  hitPosition: number;
  hitAngle: number;
  /** Frames measured so far. */
  frames: number;
}

/**
 * What an arm gets: its station, and each frame the paddle target it has to put the paddle on.
 * Everything here is in the station's frame (layout.ts), the space the arm is drawn in.
 *
 * Arms read `target` in a useRobotFrame callback (priority 0): the rally (-1) has moved it on by
 * then. `sample(t)` looks ahead or behind; `next` lists the coming strikes.
 */
export interface StationDriver {
  readonly station: StationSpec;
  readonly meta: ArmMeta;
  /** Where the paddle should be this frame. */
  readonly target: PaddleTarget;
  /** The robots' clock this frame. */
  time: number;
  /** The ball's centre this frame. */
  readonly ball: THREE.Vector3;
  /** This arm's next two strikes, the nearest first. */
  next: Contact[];
  /** Where the paddle should be at any time (a fresh target unless `out` is given). */
  sample(t: number, out?: PaddleTarget): PaddleTarget;
  /** Set by <Paddle driver>: the hall measures how closely it follows the target. */
  paddle: THREE.Object3D | null;
  /** Set by the hall: the station's frame (the group the arm is drawn in). */
  frame: THREE.Object3D | null;
  readonly stats: TrackingStats;
}

export function createDriver(station: StationSpec, meta: ArmMeta, rally: Rally): StationDriver {
  const target = makeTarget();
  return {
    station, meta, target, time: 0, ball: new THREE.Vector3(), next: [],
    sample: (t, out = makeTarget()) => rally.paddle(station.end, t, out),
    paddle: null, frame: null,
    stats: { position: 0, angle: 0, maxPosition: 0, maxAngle: 0, hitPosition: 0, hitAngle: 0, frames: 0 },
  };
}

/** Moves a driver on to `time`: the target, the ball and the coming strikes. */
export function updateDriver(driver: StationDriver, rally: Rally, time: number, ballInTable: THREE.Vector3): void {
  driver.time = time;
  rally.paddle(driver.station.end, time, driver.target);
  toStation(driver.station.end, ballInTable, driver.ball);
  driver.next = rally.contacts(driver.station.end, time, 2);
}

const WINDOW_S = 10;

interface Sample { t: number; position: number; angle: number; hit: boolean }

// Each driver's recent measurements, and the strike it was waiting for last frame.
const history = new WeakMap<StationDriver, { samples: Sample[]; last: number; waiting: number }>();
const _inverse = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3();

/**
 * Measures where the arm put its paddle against where it should be: run after the arms have
 * moved (priority between 0 and the render's 1). Either face counts for the angle.
 */
export function measureDriver(driver: StationDriver): void {
  const { paddle, frame, target, stats } = driver;
  if (!paddle || !frame) return;
  paddle.updateWorldMatrix(true, false);
  _inverse.copy(frame.matrixWorld).invert();
  _m.multiplyMatrices(_inverse, paddle.matrixWorld).decompose(_p, _q, _s);
  const position = _p.distanceTo(target.position);
  _z.set(0, 0, 1).applyQuaternion(_q);
  const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(_z.dot(target.normal)))));
  let h = history.get(driver);
  if (!h) history.set(driver, (h = { samples: [], last: driver.time, waiting: Infinity }));
  // Wound back (a dev time jump): start again.
  if (driver.time < h.last) h.samples = [];
  // The strike it was waiting for came since the last frame: this is the frame of it.
  const hit = h.waiting > h.last && h.waiting <= driver.time;
  h.last = driver.time;
  h.waiting = driver.next[0]?.time ?? Infinity;
  h.samples.push({ t: driver.time, position, angle, hit });
  while (h.samples.length && h.samples[0].t < driver.time - WINDOW_S) h.samples.shift();
  stats.position = position;
  stats.angle = angle;
  stats.maxPosition = stats.maxAngle = stats.hitPosition = stats.hitAngle = 0;
  for (const sample of h.samples) {
    stats.maxPosition = Math.max(stats.maxPosition, sample.position);
    stats.maxAngle = Math.max(stats.maxAngle, sample.angle);
    if (sample.hit) {
      stats.hitPosition = Math.max(stats.hitPosition, sample.position);
      stats.hitAngle = Math.max(stats.hitAngle, sample.angle);
    }
  }
  stats.frames++;
}
