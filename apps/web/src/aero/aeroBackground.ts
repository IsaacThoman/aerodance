/*
 * Aero Skyline: a looping Frutiger Aero drone flight rendered with three.js.
 *
 * Two ways to use it:
 *
 * 1) Inside an existing renderer (e.g. React Three Fiber):
 *      const world = createAeroWorld({ renderer, scene, camera, speed: 1 });
 *      each frame:  world.update(deltaSeconds); world.render();
 *      cleanup:     world.dispose();
 *    It takes over the camera, adds its objects under one group in `scene`,
 *    and restores the renderer/scene settings it changed on dispose.
 *
 * 2) Standalone on a <canvas>:
 *      const aero = createAeroBackground(canvas, { speed: 1 });
 *      aero.setPaused(true); aero.setSpeed(0.5); aero.destroy();
 *
 * Options: speed (multiplier), start (0..1 loop position),
 *          (default start 0.08: low over the meadow, facing the skyline)
 *          onTelemetry(({ altitude, speedKmh, zone, progress }) => ...) called ~4x per second,
 *          hide (diagnostics: parts left out, e.g. ['clouds', 'shadows'], see AeroPart).
 *
 * The world is assembled from one module per feature. Builders draw from one seeded random
 * stream, so the order of the build steps below decides the layout: keep it.
 */
import * as THREE from 'three';
import { buildBalloons } from './balloons.ts';
import { buildBirds } from './birds.ts';
import { buildBubbles, type BubbleSpec } from './bubbles.ts';
import { buildCity } from './city.ts';
import { CityBuilder } from './cityBuilder.ts';
import { createAeroContext } from './context.ts';
import { createCityMaterials } from './facades.ts';
import { createDroneFlight, createFlightPath, zoneName } from './flight.ts';
import { buildGround } from './ground.ts';
import { UNREFLECTED, buildLake, buildLakeShore } from './lake.ts';
import { buildLensFlare } from './lensFlare.ts';
import { mergeStatic } from './mergeStatic.ts';
import { buildButterflies, buildFlowers, buildMeadowGrass, buildSparkles, buildTulips, buildWindmills } from './meadow.ts';
import { buildClouds, buildJet, buildLights, buildSky } from './sky.ts';
import { buildStreetLamps, buildTraffic } from './streets.ts';
import { buildTrees, type TreeSpec } from './trees.ts';
import type { AeroBackgroundHandle, AeroBackgroundOptions, AeroPart, AeroWorldHandle, AeroWorldOptions } from './types.ts';
import { clamp } from './util.ts';

export type {
  AeroBackgroundHandle, AeroBackgroundOptions, AeroPart, AeroSettings, AeroTelemetry, AeroWorldHandle, AeroWorldOptions, AeroZone,
} from './types.ts';

export function createAeroWorld({ renderer, scene, camera, speed = 1, start = 0.08, onTelemetry = null, hide = [] }: AeroWorldOptions): AeroWorldHandle {
  const ctx = createAeroContext({ renderer, scene, camera });

  // Each part's objects, so diagnostics can leave parts out (options.hide) without changing
  // the random stream: everything is still built, hidden parts just aren't drawn or animated.
  const parts = new Map<AeroPart, THREE.Object3D[]>();
  const part = <T>(name: AeroPart, build: () => T): T => {
    const before = ctx.root.children.length;
    const result = build();
    parts.set(name, [...(parts.get(name) ?? []), ...ctx.root.children.slice(before)]);
    return result;
  };
  const sky = part('sky', () => buildSky(ctx));
  buildLights(ctx);
  const path = createFlightPath(ctx.random);
  const ground = part('ground', () => buildGround(ctx));

  // Static city: towers, parks, quays and the bridge are merged into one mesh per material.
  const materials = createCityMaterials(ctx, ground.grassCanvas);
  const cityTrees: TreeSpec[] = [], districtTrees: TreeSpec[] = [];
  const bubbleSpecs: BubbleSpec[] = [];
  const builder = new CityBuilder(ctx.random, cityTrees);
  const pondNormals = part('city', () => {
    const city = buildCity(ctx, builder, { grassTex: ground.grassTex, path, bubbles: bubbleSpecs, districtTrees });
    const pondNormals = buildLakeShore(ctx, builder, city.pondMat);
    builder.merge(ctx.root, materials);
    return pondNormals;
  });

  const lake = part('lake', () => buildLake(ctx, pondNormals, materials.capglass));
  const lamps = part('lamps', () => buildStreetLamps(ctx));
  const trees = part('trees', () => buildTrees(ctx, path, { city: cityTrees, district: districtTrees }));
  part('traffic', () => buildTraffic(ctx));
  const grass = part('grass', () => buildMeadowGrass(ctx, path));
  const flowers = part('flowers', () => buildFlowers(ctx, path));
  const tulips = part('tulips', () => buildTulips(ctx));
  const mills = part('windmills', () => buildWindmills(ctx));
  part('butterflies', () => buildButterflies(ctx, path));
  part('birds', () => buildBirds(ctx));
  const balloons = part('balloons', () => buildBalloons(ctx, path));
  const clouds = part('clouds', () => buildClouds(ctx, path));
  const bubbles = part('bubbles', () => buildBubbles(ctx, path, bubbleSpecs));
  const sparkles = part('sparkles', () => buildSparkles(ctx, path));
  const jet = part('jet', () => buildJet(ctx));
  const flare = buildLensFlare(ctx, builder.occluders);
  parts.set('flare', [flare.scene]);
  // Only what moves keeps recomposing its matrix every frame.
  const moving = new Set(ctx.moving);
  ctx.root.updateMatrixWorld(true);
  ctx.root.traverse((o) => { if (!moving.has(o)) o.matrixAutoUpdate = false; });
  // ...and what doesn't move is drawn in as few meshes as possible.
  for (const [name, objects] of parts) if (name !== 'flare') parts.set(name, mergeStatic(ctx.root, objects));

  const off = new Set(hide);
  for (const name of off) for (const o of parts.get(name) ?? []) o.visible = false;
  if (off.has('shadows')) renderer.shadowMap.enabled = false;
  lake.reflect = !off.has('reflection');
  lake.unreflected = UNREFLECTED.flatMap((name) => parts.get(name) ?? []);

  // Compile every shader now, for the screen and for the reflection's render target, instead of
  // stalling for seconds the first time each thing (or the lake) comes into view.
  renderer.compile(scene, camera);
  {
    const probe = new THREE.WebGLRenderTarget(1, 1), target = renderer.getRenderTarget();
    renderer.setRenderTarget(probe); renderer.compile(scene, camera); renderer.setRenderTarget(target);
    renderer.compile(flare.scene, flare.camera);
    probe.dispose();
  }
  const on = (name: AeroPart) => !off.has(name);

  /* ------------------------------------------------------------------- loop */
  // Half speed with prefers-reduced-motion.
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const flight = createDroneFlight(camera, path, { start, speed, motionMul: reduceMotion ? 0.5 : 1 });
  let teleT = 0, frameN = 0, elapsed = 0, disposed = false;
  renderer.shadowMap.needsUpdate = true;

  const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();

  function update(delta: number) {
    if (disposed) return;
    const dt = clamp(delta || 0, 0, 0.05);
    elapsed += dt; const t = elapsed; ctx.time.value = t; frameN++;

    const { position: p, progress: u, speed: v } = flight.update(dt, t);
    frustum.setFromProjectionMatrix(viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (on('lamps')) lamps.update(frustum, renderer.shadowMap.enabled && renderer.shadowMap.needsUpdate);
    if (on('grass')) grass.update(frustum);
    if (on('flowers')) flowers.update(frustum);
    if (on('tulips')) tulips.update(frustum);
    sky.follow(camera);
    clouds.update(dt, camera);
    lake.update(t, dt, camera);
    if (on('trees')) trees.update(camera);
    if (on('balloons')) balloons.update(t, dt);
    if (on('bubbles')) bubbles.update(t, dt, camera, frustum);
    if (on('sparkles')) sparkles.update(t);
    if (on('windmills')) mills.update(dt);
    if (on('jet')) jet.update(t);
    if (on('flare')) flare.update(dt, frameN, camera, clouds.amount);

    if (onTelemetry && (teleT -= dt) <= 0) { teleT = 0.25; onTelemetry({ altitude: Math.round(p.y), speedKmh: Math.round(v * 3.6), zone: zoneName(p), progress: u }); }
  }

  function render() {
    if (disposed) return;
    const oCam = flare.camera;
    oCam.left = -camera.aspect; oCam.right = camera.aspect; oCam.updateProjectionMatrix();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    trees.beforeRender(renderer);
    renderer.clear(); renderer.render(scene, camera); renderer.clearDepth(); renderer.render(flare.scene, oCam);
    renderer.autoClear = ac;
  }

  function dispose() {
    if (disposed) return; disposed = true;
    ctx.dispose([flare.scene]);
  }

  return {
    update,
    render,
    dispose,
    setSpeed: flight.setSpeed,
    get progress() { return flight.progress; },
  };
}

/* Standalone version: owns its renderer, loop and resizing. */
export function createAeroBackground(canvas: HTMLCanvasElement, options: AeroBackgroundOptions = {}): AeroBackgroundHandle {
  const { maxPixelRatio = 1.75, ...rest } = options;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, maxPixelRatio));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(66, 1, 0.3, 6500);
  const world = createAeroWorld({ renderer, scene, camera, ...rest });

  let width = 0, height = 0;
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.fov = w / h < 0.8 ? 78 : 66; camera.updateProjectionMatrix();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas); else addEventListener('resize', resize);
  resize();

  let paused = false, raf = 0, last = performance.now(), frames = 0, destroyed = false;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.max(0, (now - last) / 1000); last = now;
    if (paused) return;
    world.update(dt); world.render();
    if (++frames === 2) canvas.style.opacity = '1';
  }
  canvas.style.transition = 'opacity 1.6s ease';
  canvas.style.opacity = '0';
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      if (destroyed) return; destroyed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); else removeEventListener('resize', resize);
      world.dispose(); renderer.dispose(); renderer.forceContextLoss();
    },
    setPaused(b) { paused = !!b; last = performance.now(); },
    setSpeed: world.setSpeed,
    get progress() { return world.progress; },
  };
}
