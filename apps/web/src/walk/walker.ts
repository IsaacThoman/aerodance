import * as THREE from 'three';
import type { Collider, Hit } from './collider.ts';

/** Held this frame: axes run -1..1. */
export interface WalkerInput {
  forward: number;
  right: number;
  /** Noclip only: up (+1) or down (-1). */
  up: number;
  jump: boolean;
  run: boolean;
  crouch: boolean;
}

export const NO_INPUT: WalkerInput = { forward: 0, right: 0, up: 0, jump: false, run: false, crouch: false };

export type WalkerMode = 'walk' | 'noclip';

export interface Walker {
  /** The feet. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Radians: yaw 0 looks down -z, turning left as it grows; pitch looks up as it grows. */
  yaw: number;
  pitch: number;
  mode: WalkerMode;
  grounded: boolean;
  /** 0 standing to 1 crouched, eased. */
  crouch: number;
  /** Seconds since last on the ground (or flying). */
  airTime: number;
  /** Noclip's speed, as a multiple of its default. */
  flySpeed: number;
  /** Head bob: distance walked on the ground, in metres. */
  stride: number;
}

/** A person, `scale` scene units to the metre. */
export interface Body {
  eye: number;
  crouchEye: number;
  radius: number;
  /** The highest ledge walked straight up onto. */
  step: number;
  walk: number;
  run: number;
  crouchWalk: number;
  jump: number;
  gravity: number;
  fly: number;
  scale: number;
}

export function bodyFor(scale: number): Body {
  return {
    eye: 1.65 * scale, crouchEye: 0.95 * scale, radius: 0.3 * scale, step: 0.45 * scale,
    walk: 4.5 * scale, run: 8.5 * scale, crouchWalk: 2 * scale,
    // A jump of about 1.1 m: games pull harder than the Earth for a snappier arc.
    jump: Math.sqrt(2 * 20 * 1.1) * scale, gravity: 20 * scale,
    fly: 9 * scale, scale,
  };
}

export function createWalker(): Walker {
  return {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), yaw: 0, pitch: 0,
    mode: 'walk', grounded: false, crouch: 0, airTime: 0, flySpeed: 1, stride: 0,
  };
}

/** How high the eyes are above the feet, crouching or not. */
export const eyeHeight = (walker: Walker, body: Body) => THREE.MathUtils.lerp(body.eye, body.crouchEye, walker.crouch);

// Surfaces facing up at least this much can be stood on (about 53°); anything steeper is a wall.
const WALKABLE = 0.6;
// How quickly the walker reaches the speed it's steering for, on the ground, in the air and flying.
const GROUND_GRIP = 14;
const AIR_GRIP = 2.5;
const FLY_GRIP = 6;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

const _wish = new THREE.Vector3();
const _move = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _push = new THREE.Vector3();
const _flat = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** Turns the view by mouse movement, in radians. */
export function look(walker: Walker, yaw: number, pitch: number): void {
  walker.yaw = (walker.yaw + yaw) % (Math.PI * 2);
  walker.pitch = THREE.MathUtils.clamp(walker.pitch + pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

/** Puts the camera at the walker's eyes, looking where they look. */
export function placeCamera(walker: Walker, body: Body, camera: THREE.Camera): void {
  const bob = walker.mode === 'walk' && walker.grounded ? Math.sin(walker.stride * 2.4) * 0.025 * body.scale : 0;
  camera.position.copy(walker.position).addScaledVector(UP, eyeHeight(walker, body) + bob);
  camera.rotation.set(walker.pitch, walker.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
}

/** Points the walker the way `camera` looks and stands them under its eyes. */
export function faceLike(walker: Walker, body: Body, camera: THREE.Camera): void {
  const dir = camera.getWorldDirection(_dir);
  walker.yaw = Math.atan2(-dir.x, -dir.z);
  walker.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT);
  walker.position.copy(camera.getWorldPosition(_origin)).addScaledVector(UP, -eyeHeight(walker, body));
  walker.velocity.set(0, 0, 0);
  walker.grounded = false;
  walker.airTime = 0;
}

/** The ground under the feet (feet are at `y`): the highest walkable surface within `below`, if any. */
export function groundUnder(collider: Collider, x: number, y: number, z: number, above: number, below: number, radius = 0): number | null {
  let ground: number | null = null;
  // The middle, and four points round the edge of the feet, so a ledge holds them until it's under their middle.
  const probes = radius ? [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]] : [[0, 0]];
  for (const [dx, dz] of probes) {
    _origin.set(x + dx, y + above, z + dz);
    const hit = collider.cast(_origin, DOWN, above + below);
    if (!hit || hit.normal.y < WALKABLE) continue;
    const top = _origin.y - hit.distance;
    if (ground === null || top > ground) ground = top;
  }
  return ground;
}

// The heights (above the feet) that look for walls: just over a step, the middle and the head.
const wallHeights = (walker: Walker, body: Body) => [body.step + 0.05 * body.scale, eyeHeight(walker, body) * 0.55, eyeHeight(walker, body) + 0.1 * body.scale];

// The nearest wall ahead along `dir` from any of the heights.
function wallAhead(collider: Collider, walker: Walker, body: Body, dir: THREE.Vector3, far: number): Hit | null {
  let nearest: Hit | null = null;
  for (const h of wallHeights(walker, body)) {
    _origin.copy(walker.position).addScaledVector(UP, h);
    const hit = collider.cast(_origin, dir, far);
    if (hit && Math.abs(hit.normal.y) < WALKABLE && (!nearest || hit.distance < nearest.distance)) nearest = hit;
  }
  return nearest;
}

// Moves the feet by `move` (flat), sliding along the walls in the way.
function slide(collider: Collider, walker: Walker, body: Body, move: THREE.Vector3) {
  for (let i = 0; i < 3; i++) {
    const length = move.length();
    if (length < 1e-6) return;
    _dir.copy(move).divideScalar(length);
    const wall = wallAhead(collider, walker, body, _dir, length + body.radius);
    if (!wall) {
      walker.position.add(move);
      return;
    }
    const travel = Math.max(0, wall.distance - body.radius);
    walker.position.addScaledVector(_dir, travel);
    // What's left of the move, less the part into the wall.
    move.multiplyScalar(1 - travel / length);
    _flat.set(wall.normal.x, 0, wall.normal.z).normalize();
    move.addScaledVector(_flat, -move.dot(_flat));
  }
}

// Pushes the body back out of anything it's closer to than its radius (corners, things moving into it).
function unstick(collider: Collider, walker: Walker, body: Body) {
  _push.set(0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    _dir.set(Math.sin(a), 0, Math.cos(a));
    const wall = wallAhead(collider, walker, body, _dir, body.radius);
    if (wall) _push.addScaledVector(_dir, -(body.radius - wall.distance) / 2);
  }
  walker.position.add(_push);
}

/**
 * Moves the walker one step of `dt` seconds by `input`, against `collider` (null: nothing to hit).
 *
 * Walking, they run on the ground, slide along walls, step up ledges under body.step, fall,
 * and jump while on the ground. Flying (noclip) they go where they look, through everything.
 */
export function stepWalker(walker: Walker, input: WalkerInput, dt: number, collider: Collider | null, body: Body): void {
  if (dt <= 0) return;
  const { velocity: v } = walker;
  const sinYaw = Math.sin(walker.yaw), cosYaw = Math.cos(walker.yaw);

  if (walker.mode === 'noclip' || !collider) {
    const cosPitch = Math.cos(walker.pitch);
    _wish.set(-sinYaw * cosPitch, Math.sin(walker.pitch), -cosYaw * cosPitch).multiplyScalar(input.forward);
    _wish.x += cosYaw * input.right;
    _wish.z -= sinYaw * input.right;
    _wish.y += input.up;
    if (_wish.lengthSq() > 1) _wish.normalize();
    _wish.multiplyScalar(body.fly * walker.flySpeed * (input.run ? 3 : 1));
    v.lerp(_wish, 1 - Math.exp(-FLY_GRIP * dt));
    walker.position.addScaledVector(v, dt);
    walker.grounded = false;
    walker.airTime = 0;
    walker.crouch = Math.max(0, walker.crouch - dt * 6);
    return;
  }

  walker.crouch = THREE.MathUtils.clamp(walker.crouch + (input.crouch ? dt : -dt) * 6, 0, 1);
  const speed = input.crouch ? body.crouchWalk : input.run ? body.run : body.walk;
  _wish.set(-sinYaw * input.forward + cosYaw * input.right, 0, -cosYaw * input.forward - sinYaw * input.right);
  if (_wish.lengthSq() > 1) _wish.normalize();
  _wish.multiplyScalar(speed);
  const grip = 1 - Math.exp(-(walker.grounded ? GROUND_GRIP : AIR_GRIP) * dt);
  v.x += (_wish.x - v.x) * grip;
  v.z += (_wish.z - v.z) * grip;

  if (walker.grounded && input.jump) {
    v.y = body.jump;
    walker.grounded = false;
  }
  if (!walker.grounded) v.y -= body.gravity * dt;

  // Across, sliding along walls; the speed is what the walker managed.
  const x0 = walker.position.x, z0 = walker.position.z;
  _move.set(v.x * dt, 0, v.z * dt);
  slide(collider, walker, body, _move);
  unstick(collider, walker, body);
  v.x = (walker.position.x - x0) / dt;
  v.z = (walker.position.z - z0) / dt;
  if (walker.grounded) walker.stride += Math.hypot(v.x, v.z) * dt / body.scale;

  // Up or down, stopping under ceilings and on the ground.
  let dy = v.y * dt;
  if (dy > 0) {
    _origin.copy(walker.position).addScaledVector(UP, eyeHeight(walker, body));
    const ceiling = collider.cast(_origin, UP, dy + 0.1 * body.scale);
    if (ceiling) {
      dy = Math.max(0, ceiling.distance - 0.1 * body.scale);
      v.y = 0;
    }
  }
  walker.position.y += dy;
  // On the ground, it follows slopes and steps down; in the air, it lands on what it fell onto.
  const snap = walker.grounded ? body.step : 0;
  const ground = v.y > 0 ? null : groundUnder(collider, walker.position.x, walker.position.y - dy, walker.position.z, body.step, body.step + Math.max(0, -dy) + snap, body.radius * 0.6);
  if (ground !== null && walker.position.y <= ground + snap + 1e-4) {
    walker.position.y = ground;
    v.y = 0;
    walker.grounded = true;
    walker.airTime = 0;
  } else {
    walker.grounded = false;
    walker.airTime += dt;
  }
}

/** Switches between walking and flying through everything. */
export function toggleNoclip(walker: Walker): WalkerMode {
  walker.mode = walker.mode === 'walk' ? 'noclip' : 'walk';
  walker.grounded = false;
  walker.airTime = 0;
  if (walker.mode === 'walk') walker.velocity.set(0, 0, 0);
  return walker.mode;
}
