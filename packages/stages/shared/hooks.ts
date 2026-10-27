import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { DependencyList } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec2, Vec3 } from '../catalog.ts';
import { damp } from './random.ts';

// The default stage shape; the camera follows the displayed canvas in either mode.
export const ASPECT = 16 / 9;

// Create something disposable (geometry, material, texture, render target) once
// and dispose of it when the component unmounts or deps change.
export function useDisposable<T>(factory: () => T, deps: DependencyList = []): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(factory, deps);
  useEffect(() => () => disposeDeep(value), [value]);
  return value;
}

// Disposes of anything with dispose(), and of the contents of arrays and plain objects.
export function disposeDeep(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(disposeDeep);
  if ('dispose' in value && typeof value.dispose === 'function') return value.dispose();
  if (value.constructor === Object) Object.values(value).forEach(disposeDeep);
}

// Extra yaw (radians) around every stage camera's target, on top of its own swing, and lift: the
// picture raised by this share of its height (a view offset, so the camera itself stays put).
// The game turns the yaw to circle the dancers in Song Select's preview and back to 0 for the
// song, and lifts the dancers clear of the players' pills on its dancers screen.
export const stageOrbit: { yaw: number; lift: number } = { yaw: 0, lift: 0 };

// What the game is showing on the stage, so stages can tone down their busiest effects:
// `dancing` during Song Select's preview and the song, `celebrating` on the song's results.
export const stagePlay: { dancing: boolean; celebrating: boolean } = { dancing: false, celebrating: false };

// How far every stage camera's picture is pushed right, as a fraction of its width (a view
// offset: the camera itself doesn't move). The game's results screen eases it in so the stage
// and its winner sit right of its scoreboard.
export const stageShift: { x: number } = { x: 0 };

// Where each of a song's dancers stands on screen (0..1 from the top left, the floor under them),
// kept by Dancers while it dances a routine: Song Select's dancers screen names them there.
export const dancerFeet: { x: number; y: number }[] = [];

/**
 * Walk mode (apps/web/src/walk) flies whichever scene camera is live: each frame every
 * StageCamera, BackdropCamera and the Aero world's drone moves its camera as usual, then hands
 * it to `fly` with its scene, which may put it anywhere.
 */
export const cameraPilot: { fly: ((camera: THREE.PerspectiveCamera, scene: THREE.Object3D) => void) | null } = { fly: null };

export interface StageCameraProps {
  position?: Vec3;
  target?: Vec3;
  fov?: number;
  near?: number;
  far?: number;
  /** [yawAmplitude, pitchAmplitude] radians of slow swing around the target. */
  orbit?: Vec2;
  /** Swing speed multiplier. */
  orbitSpeed?: number;
  /** [x, y, z] world-unit idle drift. */
  sway?: Vec3;
  /** [x, y] world-unit offset from the pointer. */
  parallax?: Vec2;
  /** Custom control after the rig. */
  onFrame?: (camera: THREE.PerspectiveCamera, state: RootState, delta: number) => void;
}

/**
 * Stage camera that becomes the default camera while mounted.
 *
 *   position, target, fov, near, far
 *   orbit: [yawAmplitude, pitchAmplitude] radians of slow swing around the target
 *   orbitSpeed: swing speed multiplier
 *   sway: [x, y, z] world-unit idle drift
 *   parallax: [x, y] world-unit offset from the pointer
 *   onFrame(camera, state, delta): custom control after the rig
 */
export function StageCamera({
  position = [0, 4.2, 13.5],
  target = [0, 1.7, 0],
  fov = 40,
  near = 0.1,
  far = 2000,
  orbit = [0.12, 0.03],
  orbitSpeed = 1,
  sway = [0.08, 0.05, 0],
  parallax = [0.35, 0.2],
  onFrame,
}: StageCameraProps): null {
  const set = useThree((s) => s.set);
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const get = useThree((s) => s.get);
  const camera = useMemo(() => {
    // R3F's `manual` flag keeps it from fitting the projection to the canvas.
    const cam: THREE.PerspectiveCamera & { manual?: boolean } = new THREE.PerspectiveCamera(fov, ASPECT, near, far);
    cam.manual = true;
    return cam;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const base = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  const smooth = useRef(new THREE.Vector2());
  const offset = useRef(new THREE.Vector3());
  const spherical = useRef(new THREE.Spherical());
  // The shift, lift and aspect the view offset was set for.
  const viewed = useRef('0');

  useLayoutEffect(() => {
    // Preserve the wide composition's horizontal field of view on a 4:3 display,
    // leaving both dancers and their extended arms inside the frame.
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.max(1, ASPECT / aspect)));
    camera.near = near;
    camera.far = far;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    base.current.set(...position);
    look.current.set(...target);
    camera.position.copy(base.current);
    camera.lookAt(look.current);
  }, [camera, fov, near, far, aspect, ...position, ...target]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const previous = get().camera;
    set({ camera });
    return () => set({ camera: previous });
  }, [camera, get, set]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    smooth.current.x = damp(smooth.current.x, state.pointer.x, 2.5, delta);
    smooth.current.y = damp(smooth.current.y, state.pointer.y, 2.5, delta);
    // Slow orbit around the target, like a crane drifting around the dancers.
    offset.current.subVectors(base.current, look.current);
    const s = spherical.current.setFromVector3(offset.current);
    s.theta += Math.sin(t * 0.11 * orbitSpeed) * orbit[0] + stageOrbit.yaw;
    s.phi = THREE.MathUtils.clamp(s.phi + Math.sin(t * 0.07 * orbitSpeed + 1.1) * orbit[1], 0.05, Math.PI - 0.05);
    offset.current.setFromSpherical(s);
    camera.position.copy(look.current).add(offset.current);
    camera.position.x += Math.sin(t * 0.21) * sway[0] + smooth.current.x * parallax[0];
    camera.position.y += Math.sin(t * 0.17 + 1.3) * sway[1] + smooth.current.y * parallax[1];
    camera.position.z += Math.sin(t * 0.13 + 2.1) * sway[2];
    camera.lookAt(look.current);
    // Shifted or lifted, the picture is drawn from elsewhere in the view, so everything sits
    // further right or higher on screen. (setViewOffset takes the aspect from its full size, so
    // that's the camera's own: a 1x1 full size would squash the picture to square.)
    const { x: shift } = stageShift, { lift } = stageOrbit;
    const key = shift || lift ? `${shift}|${lift}|${camera.aspect}` : '0';
    if (key !== viewed.current) {
      viewed.current = key;
      if (key === '0') camera.clearViewOffset();
      else camera.setViewOffset(camera.aspect, 1, -shift * camera.aspect, lift, camera.aspect, 1);
    }
    onFrame?.(camera, state, delta);
    cameraPilot.fly?.(camera, state.scene);
  });

  return null;
}

// Shared music clock so beat-reactive lights stay in sync across a stage.
// The capture is silent, so this is a steady 118 bpm pulse.
export interface BeatClock {
  bpm: number;
  /** Seconds. */
  time: number;
  /** Whole beats so far. */
  beat: number;
  /** 0..1 through the current beat. */
  phase: number;
  /** 1 on the beat, decaying quickly. */
  pulse: number;
  /** Whole bars (4 beats) so far. */
  bar: number;
}

export const beat: BeatClock = { bpm: 118, time: 0, beat: 0, phase: 0, pulse: 0, bar: 0 };

export function tickBeat(delta: number): void {
  beat.time += delta;
  const b = (beat.time * beat.bpm) / 60;
  beat.beat = Math.floor(b);
  beat.phase = b - beat.beat;
  beat.bar = Math.floor(beat.beat / 4);
  // 1 on the beat, decaying quickly.
  beat.pulse = Math.exp(-beat.phase * 6);
}

// Respect reduced motion for big ambient movement (dancers pause separately).
export const reducedMotion: boolean =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
