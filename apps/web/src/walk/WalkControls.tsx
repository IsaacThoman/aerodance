import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { cameraPilot } from '../../../../packages/stages/shared/hooks.ts';
import { SceneCollider } from './collider.ts';
import { bodyFor, createWalker, faceLike, groundUnder, look, placeCamera, stepWalker, toggleNoclip } from './walker.ts';
import type { Body, WalkerInput, WalkerMode } from './walker.ts';
import type { WalkScene } from './scenes.ts';

/** What walk mode is doing, shared by its controls, its overlay (WalkHud) and the page (WalkApp). */
export interface WalkStatus {
  scene: WalkScene;
  /** The scene is built and showing: the walker has the camera. */
  ready: boolean;
  failed: boolean;
  /** The menu is up: the walker stands still. */
  paused: boolean;
  /** The pointer is locked to the canvas (mouse look). */
  locked: boolean;
  hud: boolean;
  mode: WalkerMode;
  flySpeed: number;
  /** A line shown for a few seconds, from `at` (performance.now()). */
  toast: { text: string; at: number } | null;
}

export function createWalkStatus(scene: WalkScene): WalkStatus {
  return { scene, ready: false, failed: false, paused: true, locked: false, hud: true, mode: 'walk', flySpeed: 1, toast: null };
}

export const say = (status: WalkStatus, text: string) => { status.toast = { text, at: performance.now() }; };

/** Back to walking: the pointer locks to the canvas for mouse look, where the browser lets it. */
export function resume(status: WalkStatus, canvas: HTMLCanvasElement): void {
  status.paused = false;
  say(status, status.mode === 'noclip' ? 'Flying: Z to walk · Esc for the menu' : 'Esc for the menu · Z to noclip');
  if (document.pointerLockElement === canvas) return;
  try {
    // Without a lock (it was refused, or there's no mouse), dragging looks around instead.
    canvas.requestPointerLock()?.catch?.(() => {});
  } catch {
    // As above.
  }
}

export function pause(status: WalkStatus): void {
  status.paused = true;
  if (document.pointerLockElement) document.exitPointerLock();
}

// Radians a pixel of mouse movement turns the view.
const LOOK_PER_PX = 0.0022;
// The vertical field of view at 16:9; 4:3 widens it to keep the same horizontal view.
const FOV = 64;
// How far below the scene's own camera the walker looks for somewhere to stand, in metres.
const SPAWN_DROP = 300;
// How far ahead of the camera (in metres) it looks for ground when there's none under it.
const SPAWN_AHEAD = [0, 2, 4, 8, 16, 32, 64, 128];
// Falling this long with nothing below, the walker goes back to the start.
const FALL_S = 4;
// How often the collider looks for meshes added or hidden since (ms).
const REFRESH_MS = 1000;

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyQ', 'KeyE']);
const held = (keys: Set<string>, ...codes: string[]) => (codes.some((code) => keys.has(code)) ? 1 : 0);

function readInput(keys: Set<string>): WalkerInput {
  return {
    forward: held(keys, 'KeyW', 'ArrowUp') - held(keys, 'KeyS', 'ArrowDown'),
    right: held(keys, 'KeyD', 'ArrowRight') - held(keys, 'KeyA', 'ArrowLeft'),
    up: held(keys, 'Space', 'KeyE') - held(keys, 'KeyC', 'KeyQ'),
    jump: keys.has('Space'),
    run: held(keys, 'ShiftLeft', 'ShiftRight') === 1,
    crouch: keys.has('KeyC'),
  };
}

interface Spawn { position: THREE.Vector3; yaw: number; pitch: number; mode: WalkerMode }

/**
 * Walk mode's first-person controls: WASD and the mouse walk the scene showing, through
 * cameraPilot, which every scene's camera hands itself to each frame. Until the scene is ready
 * its camera shows what it normally would; then the walker starts where it was, looking the same
 * way, and drops to whatever is under it (or flies, with nothing there).
 *
 * Walking collides with the scene's solid meshes (SceneCollider); Z switches to noclip, flying
 * through everything (Space up, C down, the wheel for speed). R goes back to the start, [ and ]
 * change scene, H hides the overlay, and Esc (or losing the pointer lock) brings up the menu.
 *
 * The canvas reports data-walk-* (scene, ready, mode, paused, grounded, position, look in degrees)
 * for tests.
 *
 * <WalkControls status={status} onStep={(step) => ...} />
 */
export default function WalkControls({ status, onStep }: { status: WalkStatus; onStep: (step: -1 | 1) => void }) {
  const gl = useThree((state) => state.gl);
  const step = useRef(onStep);
  step.current = onStep;
  const st = useRef({
    walker: createWalker(),
    keys: new Set<string>(),
    root: null as THREE.Object3D | null,
    collider: null as SceneCollider | null,
    spawn: null as Spawn | null,
    near: 0.1,
    refreshAt: 0,
    fallCheckAt: 0,
    last: 0,
    turn: { x: 0, y: 0 },
    drag: null as { x: number; y: number } | null,
    reported: '',
  }).current;

  useEffect(() => {
    const { walker } = st;
    const respawn = () => {
      if (!st.spawn) return;
      walker.position.copy(st.spawn.position);
      walker.velocity.set(0, 0, 0);
      Object.assign(walker, { yaw: st.spawn.yaw, pitch: st.spawn.pitch, mode: st.spawn.mode, grounded: false, airTime: 0 });
      status.mode = walker.mode;
    };

    // Starts the walker where the scene's camera is, and finds what it can stand on.
    const spawn = (camera: THREE.PerspectiveCamera, root: THREE.Object3D, body: Body) => {
      const collider = new SceneCollider(root);
      st.root = root;
      st.collider = collider;
      st.refreshAt = performance.now() + REFRESH_MS;
      st.near = Math.min(camera.near, 0.18 * body.scale);
      faceLike(walker, body, camera);
      // Somewhere to stand under the camera, or a little way ahead: some scenes only have ground
      // in front of where the camera stands.
      const drop = SPAWN_DROP * body.scale;
      collider.focus(walker.position, drop + Math.max(...SPAWN_AHEAD) * body.scale);
      const ahead = new THREE.Vector3(-Math.sin(walker.yaw), 0, -Math.cos(walker.yaw));
      const ground = !status.scene.fly && SPAWN_AHEAD.some((d) => {
        const { x, y, z } = walker.position.clone().addScaledVector(ahead, d * body.scale);
        if (groundUnder(collider, x, y, z, body.eye, drop) === null) return false;
        walker.position.set(x, y, z);
        return true;
      });
      walker.mode = ground ? 'walk' : 'noclip';
      walker.flySpeed = status.flySpeed;
      status.mode = walker.mode;
      st.spawn = { position: walker.position.clone(), yaw: walker.yaw, pitch: walker.pitch, mode: walker.mode };
    };

    cameraPilot.fly = (camera, root) => {
      if (!status.ready) return;
      const now = performance.now();
      const dt = st.last ? Math.min(0.1, (now - st.last) / 1000) : 0;
      st.last = now;
      const body = bodyFor(status.scene.scale);
      if (st.root !== root) spawn(camera, root, body);
      const collider = st.collider;
      if (!collider) return;
      if (now >= st.refreshAt) {
        collider.refresh();
        st.refreshAt = now + REFRESH_MS;
      }

      look(walker, -st.turn.x * LOOK_PER_PX, -st.turn.y * LOOK_PER_PX);
      st.turn.x = st.turn.y = 0;
      walker.flySpeed = status.flySpeed;
      const speed = walker.velocity.length() * dt;
      collider.focus(walker.position, Math.max(3 * body.scale, speed * 2 + body.eye + body.step));
      // The menu stops the walker where they are.
      if (!status.paused) stepWalker(walker, readInput(st.keys), dt, collider, body);

      // Fallen a long way with nothing below: back to the start.
      if (walker.mode === 'walk' && walker.airTime > FALL_S && now >= st.fallCheckAt) {
        st.fallCheckAt = now + 1000;
        collider.focus(walker.position, SPAWN_DROP * body.scale);
        if (groundUnder(collider, walker.position.x, walker.position.y, walker.position.z, 0, SPAWN_DROP * body.scale) === null) {
          respawn();
          say(status, 'Fell out of the world, so back to the start');
        }
      }

      placeCamera(walker, body, camera);
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * Math.max(1, 16 / 9 / camera.aspect)));
      if (camera.fov !== fov || camera.near !== st.near) {
        camera.fov = fov;
        camera.near = st.near;
        camera.updateProjectionMatrix();
      }

      const p = walker.position;
      const position = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
      const facing = `${Math.round(THREE.MathUtils.radToDeg(walker.yaw))},${Math.round(THREE.MathUtils.radToDeg(walker.pitch))}`;
      const report = [walker.mode, walker.grounded, position, facing, collider.size].join('|');
      if (report !== st.reported) {
        st.reported = report;
        Object.assign(gl.domElement.dataset, {
          walkMode: walker.mode, walkGrounded: String(walker.grounded), walkPosition: position, walkLook: facing, walkSolids: String(collider.size),
        });
      }
    };

    const el = gl.domElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (MOVE_KEYS.has(e.code)) {
        if (status.paused) return;
        st.keys.add(e.code);
        e.preventDefault();
        return;
      }
      if (e.repeat) return;
      if (e.code === 'KeyZ') {
        status.mode = toggleNoclip(walker);
        say(status, status.mode === 'noclip' ? 'Noclip: Space up, C down, wheel for speed' : 'Walking');
      } else if (e.code === 'KeyR') {
        respawn();
      } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        step.current(e.code === 'BracketLeft' ? -1 : 1);
      } else if (e.code === 'KeyH') {
        status.hud = !status.hud;
      } else if (e.code === 'Escape' && !status.paused) {
        // With the pointer locked, the browser takes Esc and unlocks it (onLockChange).
        pause(status);
      } else {
        return;
      }
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { st.keys.delete(e.code); };
    const onBlur = () => { st.keys.clear(); st.drag = null; };
    const onMove = (e: PointerEvent) => {
      if (status.paused) return;
      if (status.locked) {
        st.turn.x += e.movementX;
        st.turn.y += e.movementY;
      } else if (st.drag) {
        st.turn.x += e.clientX - st.drag.x;
        st.turn.y += e.clientY - st.drag.y;
        st.drag = { x: e.clientX, y: e.clientY };
      }
    };
    const onDown = (e: PointerEvent) => {
      if (status.paused || status.locked || e.button !== 0) return;
      st.drag = { x: e.clientX, y: e.clientY };
      resume(status, el);
    };
    const onUp = () => { st.drag = null; };
    const onWheel = (e: WheelEvent) => {
      if (status.paused || walker.mode !== 'noclip' || !e.deltaY) return;
      status.flySpeed = THREE.MathUtils.clamp(status.flySpeed * (e.deltaY < 0 ? 1.25 : 0.8), 0.05, 40);
      say(status, `Fly speed ×${status.flySpeed < 1 ? status.flySpeed.toFixed(2) : status.flySpeed.toFixed(1)}`);
    };
    const onLockChange = () => {
      const locked = document.pointerLockElement === el;
      if (status.locked && !locked) pause(status);
      status.locked = locked;
      el.dataset.walkLocked = String(locked);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('wheel', onWheel, { passive: true });
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      cameraPilot.fly = null;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onLockChange);
    };
  }, [gl, st, status]);

  return null;
}
