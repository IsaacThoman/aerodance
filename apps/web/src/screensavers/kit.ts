import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ASPECT, cameraPilot } from '../../../../packages/stages/shared/hooks.ts';
import type { ScreensaverContext } from './types.ts';

/*
 * What a screensaver is built from, besides its scene:
 *
 *   <SaverWorld>        its own world ('custom' scene): the game's MinigameWorld, which takes the
 *                       screen while mounted, draws through the stages' post-processing, and whose
 *                       camera (useThree's, inside it) the screensaver flies from a useFrame
 *   useCameraViews()    flies a background's or stage's own camera through the screensaver's views
 *                       (packages/stages' cameraPilot, as walk mode does): each view a Shot
 *   dolly, orbit, hold  Shots: a camera moving slowly between two places, circling a point, or
 *                       standing still with a little drift
 *   aspectFov()         a 16:9 vertical field of view widened to keep the same width at 4:3
 *   shiftPicture()      pushes a camera's picture right (ctx.shift(): the preview covers the left)
 *   clockHands(),       an in-scene clock (a screensaver with `sceneClock`, while ctx.clock() is
 *   useClockTexture()   'scene'): an analog clock's hands, or a canvas texture redrawn each minute
 *   clockText()         (or second) to put on a screen, a sign or a scoreboard; the time in words
 *
 * Every Shot gets the seconds since its view began (ctx.viewTime()): Auto cuts to a view from its
 * start. Keep moves slow and smooth; a view should look good for a minute or more.
 */

export { MinigameWorld as SaverWorld } from '../minigames/scene.tsx';
export { clockText } from './clock.ts';

type V3 = readonly [number, number, number];

/** Where a view puts the camera at `t` seconds into it, and where it looks, with its field of view (16:9, degrees). */
export interface ShotFrame { position: V3; target: V3; fov?: number; roll?: number; }
export type Shot = (t: number) => ShotFrame;

/** A 16:9 vertical field of view, widened on a narrower display so the width seen stays the same. */
export const aspectFov = (fov: number, aspect: number) => THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.max(1, ASPECT / aspect)));

const ease = (u: number) => u * u * (3 - 2 * u);
const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/**
 * From one place to another over `seconds`, eased, and back again (a ping-pong, so it never jumps),
 * looking from `target` to `toTarget`.
 */
export function dolly(from: V3, to: V3, target: V3, { toTarget = target, seconds = 40, fov }: { toTarget?: V3; seconds?: number; fov?: number } = {}): Shot {
  return (t) => {
    const phase = (t / seconds) % 2, u = ease(phase < 1 ? phase : 2 - phase);
    return { position: mix(from, to, u), target: mix(target, toTarget, u), fov };
  };
}

/** Round `target` at `radius` and `height` above it, a full turn every `seconds` (negative: the other way), from `start` radians. */
export function orbit(target: V3, radius: number, height: number, { seconds = 90, start = 0, fov, bob = 0 }: { seconds?: number; start?: number; fov?: number; bob?: number } = {}): Shot {
  return (t) => {
    const a = start + (t / seconds) * Math.PI * 2;
    return { position: [target[0] + Math.sin(a) * radius, target[1] + height + Math.sin(t * 0.21) * bob, target[2] + Math.cos(a) * radius], target, fov };
  };
}

/** Still, with a slow drift of `sway` units each way. */
export function hold(position: V3, target: V3, { fov, sway = 0.15 }: { fov?: number; sway?: number } = {}): Shot {
  return (t) => ({ position: [position[0] + Math.sin(t * 0.13) * sway, position[1] + Math.sin(t * 0.11 + 1.3) * sway * 0.5, position[2] + Math.sin(t * 0.09 + 2.1) * sway * 0.5], target, fov });
}

/** Pushes the camera's picture right by `shift` of its width (a view offset: the camera stays put); 0 clears it. */
export function shiftPicture(camera: THREE.PerspectiveCamera, shift: number) {
  if (Math.abs(shift) < 1e-4) { if (camera.view?.enabled) camera.clearViewOffset(); return; }
  camera.setViewOffset(camera.aspect, 1, -shift * camera.aspect, 0, camera.aspect, 1);
}

/** Puts a camera where a shot says, its field of view fitted to its aspect (the camera's own `base` when the shot names none). */
export function placeCamera(camera: THREE.PerspectiveCamera, frame: ShotFrame, baseFov: number) {
  camera.position.set(...frame.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(...frame.target);
  if (frame.roll) camera.rotateZ(frame.roll);
  const fov = frame.fov ? aspectFov(frame.fov, camera.aspect) : baseFov;
  if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
  // Whatever reads the camera later this frame (the Aero world's culling, a sun flare) sees it where it now is.
  camera.updateMatrixWorld();
}

/**
 * Flies the scene's own camera (a backdrop's, a stage's, or the skyline flight's drone) through
 * the screensaver's views while it's mounted. A view the map hasn't is left to the scene's camera.
 *
 *   useCameraViews(ctx, { wide: hold([0, 3, 20], [0, 2, 0]), low: dolly([-6, 0.6, 9], [6, 0.6, 9], [0, 1.2, 0]) });
 */
export function useCameraViews(ctx: ScreensaverContext, views: Readonly<Record<string, Shot>>) {
  const viewsRef = useRef(views);
  viewsRef.current = views;
  useEffect(() => {
    // The camera's own field of view, to go back to for views without one (and when it's left).
    let own: { camera: THREE.PerspectiveCamera; fov: number } | null = null;
    const previous = cameraPilot.fly;
    cameraPilot.fly = (camera) => {
      if (own?.camera !== camera) own = { camera, fov: camera.fov };
      const shot = viewsRef.current[ctx.view()];
      if (shot) placeCamera(camera, shot(ctx.viewTime()), own.fov);
      else if (Math.abs(camera.fov - own.fov) > 1e-3) { camera.fov = own.fov; camera.updateProjectionMatrix(); }
      shiftPicture(camera, ctx.shift());
    };
    return () => {
      cameraPilot.fly = previous;
      if (!own) return;
      if (Math.abs(own.camera.fov - own.fov) > 1e-3) own.camera.fov = own.fov;
      own.camera.clearViewOffset();
      own.camera.updateProjectionMatrix();
    };
  }, [ctx]);
}

/**
 * An analog clock's hands at `date`, in radians clockwise from 12: the hour hand creeping with the
 * minutes, the minute hand with the seconds, and the second hand sweeping smoothly.
 */
export function clockHands(date: Date): { hour: number; minute: number; second: number } {
  const s = date.getSeconds() + date.getMilliseconds() / 1000, m = date.getMinutes() + s / 60, h = (date.getHours() % 12) + m / 60;
  return { hour: (h / 12) * Math.PI * 2, minute: (m / 60) * Math.PI * 2, second: (s / 60) * Math.PI * 2 };
}

/**
 * A canvas texture for an in-scene clock face, a screen or a sign: `draw` paints it (`width` ×
 * `height` pixels) whenever the minute changes (each second with `seconds`), and when `key`
 * changes (say, ctx.clock() switching the scoreboard between the time and the score; a function
 * is asked each frame, so it can read refs rather than React state). Keep it
 * small: it's uploaded whole each time it's drawn.
 *
 *   const face = useClockTexture(256, 128, (g, now) => { g.clearRect(0, 0, 256, 128); g.fillText(clockText(now).time, 128, 70); });
 *   <mesh><planeGeometry args={[1, 0.5]} /><meshBasicMaterial map={face} toneMapped={false} /></mesh>
 */
export function useClockTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D, now: Date) => void, { seconds = false, key = '' }: { seconds?: boolean; key?: string | (() => string) } = {}) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [width, height]);
  useEffect(() => () => texture.dispose(), [texture]);
  const drawn = useRef({ unit: -1, key: '' });
  useFrame(() => {
    const ms = Date.now(), unit = Math.floor(ms / (seconds ? 1000 : 60000)), k = typeof key === 'function' ? key() : key;
    if (unit === drawn.current.unit && k === drawn.current.key) return;
    drawn.current = { unit, key: k };
    const g = (texture.image as HTMLCanvasElement).getContext('2d');
    if (!g) return;
    drawRef.current(g, new Date(ms));
    texture.needsUpdate = true;
  });
  return texture;
}
