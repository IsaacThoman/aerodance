// The headless renderer behind `dance frames`, `dance render` and `dance track` (server.ts drives
// it through window.danceRender):
//   render(spec)          a contact sheet (or one clip frame) as a base64 PNG: a row per time,
//                         a cell per view (renderSpec.ts)
//   detect(frames, n)     MediaPipe Lite poses for RGBA video frames, with the game's own worker
import '@fontsource/nunito/700.css';
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, advance } from '@react-three/fiber';
import { PCFShadowMap } from 'three';
import type { Landmark, Pose, TrackCalibration } from '../../../packages/pose/choreography.ts';
import type { SongBundle } from '../../../packages/pose/song.ts';
import { ASSET_PATH, MODELS } from '../../../packages/pose/browser/models.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from '../../../packages/pose/browser/pose.worker.ts';
import { detectedConfidence } from '../../../packages/pose/browser/slots.ts';
import type { Tile } from '../../../packages/pose/browser/tiles.ts';
import { compileDance, previewCalibrations } from '../compile.ts';
import { createEvaluator, keyTimes } from '../evaluate.ts';
import type { DancerEvaluator } from '../evaluate.ts';
import { expandControls, isMidJoint, isPointControl } from '../format.ts';
import type { Dance, Dancer } from '../format.ts';
import { LANDMARKS_OF, LANDMARK_OF } from '../rig.ts';
import { gameBundle } from '../score.ts';
import { formatTime, songToVideo } from '../time.ts';
import type { TrackingData } from '../tracking.ts';
import { fetchDance, fetchTracking, frameUrl } from './data.ts';
import type { RenderSpec, View } from './renderSpec.ts';
import { CharacterScene, GameScene } from './scenes.tsx';
import { DANCER_COLORS, REFERENCE_COLOR, drawSkeleton, drawTag, stretchedBones } from './skeleton.ts';
import type { Viewport } from './skeleton.ts';

interface Loaded {
  dance: Dance;
  evaluators: DancerEvaluator[];
  calibrations: TrackCalibration[];
  bundle: SongBundle | null;
  tracking: Map<string, { data: TrackingData; slot: number }>;
}
let loaded: (Loaded & { stamp: string }) | null = null;
/** The dance as the request saw it: reloaded when the revision or the file's content (a hand edit) moved on. */
async function load(revision: number, stamp: string): Promise<Loaded> {
  if (loaded && loaded.dance.revision === revision && loaded.stamp === stamp) return loaded;
  const dance = await fetchDance();
  const tracking = new Map<string, { data: TrackingData; slot: number }>();
  for (const source of [...dance.sources.tracking].reverse()) for (const [slot, id] of source.dancers.entries())
    if (id && !tracking.has(id)) tracking.set(id, { data: await fetchTracking(dance, source.id), slot });
  loaded = { dance, evaluators: dance.dancers.map(d => createEvaluator(dance, d)), calibrations: previewCalibrations(dance), bundle: null, tracking, stamp };
  return loaded;
}

// The 3D canvas: mounted with the scene a view needs, then stepped by hand (frameloop "never").
type SceneRequest =
  | { kind: 'character'; calibrations: TrackCalibration[]; mirror: boolean; focus: number | null; width: number; height: number }
  | { kind: 'stage'; bundle: SongBundle; stage: Dance['song']['stage']; width: number; height: number };
const poses: { current: (Pose | null)[] } = { current: [] };
let sceneTime = 0;
let sceneRoot: import('three').Scene | null = null;
const rigCount = () => sceneRoot?.getObjectsByProperty('name', 'Root').filter(o => 'isBone' in o).length ?? 0;
let mountScene: (request: SceneRequest | null, ready: () => void) => void = () => { throw Error('Renderer not mounted'); };
function SceneHost() {
  const [scene, setScene] = useState<{ request: SceneRequest; ready: () => void; key: number } | null>(null);
  mountScene = (request, ready) => setScene(request ? { request, ready, key: Math.random() } : null);
  const onReady = useCallback(() => scene?.ready(), [scene]);
  if (!scene) return null;
  const r = scene.request;
  return (
    <div style={{ width: r.width, height: r.height }}>
      <Canvas key={scene.key} frameloop="never" dpr={1} shadows={{ type: PCFShadowMap }} style={{ width: r.width, height: r.height }}
        onCreated={({ scene }) => { sceneRoot = scene; }}
        gl={{ antialias: true, preserveDrawingBuffer: true, alpha: false }}>
        {r.kind === 'character'
          ? <CharacterScene poses={poses} calibrations={r.calibrations} mirror={r.mirror} focus={r.focus} onReady={onReady} />
          : <GameScene stage={r.stage} bundle={r.bundle} timeMs={() => sceneTime} width={r.width} height={r.height} onReady={onReady} />}
      </Canvas>
    </div>
  );
}
const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
/** The scene mounted last, kept for the next render that asks for the same one (clip frames). */
let mounted: { key: string; canvas: HTMLCanvasElement } | null = null;
const sceneKey = (r: SceneRequest, revision: string) => JSON.stringify({ ...r, bundle: undefined, calibrations: undefined, revision });
/** Mounts a scene and waits until it and every dancer's rig have loaded; returns its canvas. */
async function showScene(request: SceneRequest, dancers: number, revision: string): Promise<HTMLCanvasElement> {
  const key = sceneKey(request, revision);
  if (mounted && mounted.key === key && mounted.canvas.isConnected) return mounted.canvas;
  mounted = null;
  sceneRoot = null;
  const deadline = performance.now() + 60000;
  await Promise.race([new Promise<void>(resolve => mountScene(request, resolve)),
    new Promise((_, reject) => setTimeout(() => reject(Error('The 3D view did not mount')), 60000))]);
  for (;;) {
    await nextFrame();
    const canvas = document.querySelector('canvas');
    if (canvas && rigCount() >= dancers) { mounted = { key, canvas }; return canvas; }
    if (performance.now() > deadline) throw Error('The 3D view did not load');
  }
}

// ---- Sheets ----

const imageCache = new Map<string, Promise<ImageBitmap>>();
function frameImage(t: number, width: number, video: Dance['sources']['video']): Promise<ImageBitmap> {
  const url = frameUrl(t, width, video);
  let found = imageCache.get(url);
  if (!found) {
    found = fetch(url).then(async r => { if (!r.ok) throw Error(`Frame at ${t} ms: HTTP ${r.status}`); return createImageBitmap(await r.blob()); });
    imageCache.set(url, found);
    if (imageCache.size > 400) imageCache.delete(imageCache.keys().next().value!);
  }
  return found;
}
function eligibleAt(dancer: Dancer, t: number): boolean[] | null {
  const out = Array<boolean>(33).fill(false);
  let any = false;
  for (const x of dancer.exclusions) {
    if (t < x.startMs || t >= x.endMs) continue;
    any = true;
    if (!x.controls) out.fill(true);
    else for (const c of expandControls(x.controls)) if (isPointControl(c)) for (const j of LANDMARKS_OF[c]) out[j] = true;
  }
  return any ? out : null;
}
const beforeCache = new Map<number, { dance: Dance; evaluators: DancerEvaluator[] }>();
async function loadBefore(revision: number) {
  let found = beforeCache.get(revision);
  if (!found) {
    const dance = await fetchDance(revision);
    found = { dance, evaluators: dance.dancers.map(d => createEvaluator(dance, d)) };
    beforeCache.set(revision, found);
  }
  return found;
}
function drawDancers(g: CanvasRenderingContext2D, v: Viewport, data: Loaded, spec: RenderSpec, t: number, before: Awaited<ReturnType<typeof loadBefore>> | null) {
  const { dance } = data;
  if (before) before.dance.dancers.forEach((dancer, i) => {
    if (spec.dancers && !spec.dancers.includes(dancer.id)) return;
    drawSkeleton(g, v, before.evaluators[i].landmarks(t), { color: '#c4ccd0', dashed: true, alpha: 0.85, scale: 0.85 });
  });
  dance.dancers.forEach((dancer, i) => {
    if (spec.dancers && !spec.dancers.includes(dancer.id)) return;
    const color = DANCER_COLORS[i % DANCER_COLORS.length], faded = spec.focus !== null && spec.focus !== dancer.id;
    if (spec.ghosts) {
      const times = keyTimes(dancer), local = t - dancer.timeOffsetMs;
      const prev = [...times].reverse().find(k => k < local - 1), next = times.find(k => k > local + 1);
      for (const k of [prev, next]) if (k !== undefined)
        drawSkeleton(g, v, data.evaluators[i].landmarks(k + dancer.timeOffsetMs), { color, alpha: 0.22, scale: 0.8 });
    }
    const reference = spec.reference ? data.tracking.get(dancer.id) : undefined;
    if (reference) {
      const live = reference.data.poseAt(reference.slot, songToVideo(dance, t));
      if (live) drawSkeleton(g, v, live, { color: REFERENCE_COLOR, dashed: true, alpha: 0.9, scale: 0.75 });
    }
    const hollow = Object.entries(LANDMARK_OF).filter(([c]) => isMidJoint(c) && !(dancer.layers[0].channels[c]?.length)).map(([, i]) => i);
    if (spec.trails) {
      // Where the head, hands and feet travel either side of t: older is fainter.
      const span = spec.trails, step = Math.max(10, span / 24);
      for (const control of ['head', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle'] as const) {
        let last: { x: number; y: number } | null = null;
        for (let at = t - span; at <= t + span + 1e-6; at += step) {
          const p = data.evaluators[i].rig(at).points[control], c = { x: v.x + (p[0] - v.crop.x) / v.crop.w * v.w, y: v.y + (p[1] - v.crop.y) / v.crop.h * v.h };
          if (last) {
            g.strokeStyle = at <= t ? color : '#ffffff';
            g.globalAlpha = 0.25 + 0.6 * (1 - Math.abs(at - t) / span);
            g.lineWidth = 2; g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(c.x, c.y); g.stroke();
          }
          last = c;
        }
        g.globalAlpha = 1;
      }
    }
    const landmarks = data.evaluators[i].landmarks(t);
    drawSkeleton(g, v, landmarks, { color, alpha: faded ? 0.45 : 1, ineligible: eligibleAt(dancer, t - dancer.timeOffsetMs),
      label: dancer.id, hollow, warn: stretchedBones(landmarks, dancer.body, dance.frame.width / dance.frame.height) });
  });
}
/** Frame-coordinate gridlines, finer when zoomed in, labelled along the top and left edges. */
function drawGrid(g: CanvasRenderingContext2D, v: Viewport) {
  const span = Math.min(v.crop.w, v.crop.h), step = span <= 0.25 ? 0.01 : span <= 0.5 ? 0.02 : 0.05;
  const major = step * 5;
  g.save();
  g.font = '600 10px Nunito, sans-serif';
  g.textBaseline = 'top';
  for (const axis of ['x', 'y'] as const) {
    const lo = axis === 'x' ? v.crop.x : v.crop.y, hi = lo + (axis === 'x' ? v.crop.w : v.crop.h);
    for (let n = Math.ceil(lo / step - 1e-9); n * step <= hi + 1e-9; n++) {
      const value = Math.round(n * step * 1000) / 1000, isMajor = Math.abs(value / major - Math.round(value / major)) < 1e-6;
      const p = axis === 'x' ? v.x + (value - v.crop.x) / v.crop.w * v.w : v.y + (value - v.crop.y) / v.crop.h * v.h;
      g.strokeStyle = isMajor ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.16)';
      g.lineWidth = 1;
      g.beginPath();
      if (axis === 'x') { g.moveTo(p, v.y); g.lineTo(p, v.y + v.h); } else { g.moveTo(v.x, p); g.lineTo(v.x + v.w, p); }
      g.stroke();
      if (!isMajor && (axis === 'x' ? v.w : v.h) / ((hi - lo) / step) < 26) continue;
      const text = value.toFixed(step < 0.05 ? 2 : 2).replace(/^0/, '');
      g.fillStyle = 'rgba(4,16,28,0.75)';
      const w = g.measureText(text).width + 4;
      if (axis === 'x') { g.fillRect(p + 1, v.y + 1, w, 12); g.fillStyle = '#fff3b0'; g.fillText(text, p + 3, v.y + 2); }
      else { g.fillRect(v.x + 1, p + 1, w, 12); g.fillStyle = '#fff3b0'; g.fillText(text, v.x + 3, p + 2); }
    }
  }
  g.restore();
}
async function renderNow(spec: RenderSpec): Promise<string> {
  const data = await load(spec.revision, spec.stamp ?? ''), { dance } = data, version = `${dance.revision}:${spec.stamp ?? ''}`;
  const aspect = dance.frame.width / dance.frame.height;
  const crop = spec.zoom ?? { x: 0, y: 0, w: 1, h: 1 };
  const cellW = Math.round(spec.cellWidth), cellH = Math.round(cellW * crop.h / (crop.w * aspect));
  // 3D views keep at least the game's 4:3, whatever crop the video cells show.
  const is3d = (view: View) => view === 'character' || view === 'stage';
  const gap = spec.labels ? 6 : 0, headerH = spec.labels ? 40 : 0;
  const widths = spec.views.map(view => is3d(view) ? Math.max(cellW, Math.round(cellH * 4 / 3)) : cellW);
  // One view: times wrap into a grid, each labelled in its corner. Several: a row per time.
  const wrap = spec.views.length === 1 && spec.times.length > 1;
  const columns = wrap ? Math.max(1, Math.min(spec.times.length, Math.floor(1900 / (widths[0] + gap)))) : 1;
  const labelW = spec.labels && !wrap ? 132 : spec.labels ? gap : 0;
  const lefts = widths.map((_, i) => labelW + widths.slice(0, i).reduce((a, w) => a + w + gap, 0));
  const rows = wrap ? Math.ceil(spec.times.length / columns) : spec.times.length;
  const names: Record<View, string> = { source: 'video', overlay: 'video + dance', skeleton: 'skeleton (heavy = scored)', character: spec.mirror ? 'character (mirrored, as the game)' : 'character (as filmed)', stage: 'game stage (mirrored)' };
  const notes = [spec.before !== undefined && spec.before !== null ? `dashed grey: revision ${spec.before}` : '', spec.trails ? `trails ±${spec.trails} ms (white: ahead)` : ''].filter(Boolean);
  // One view: its name goes in the title line; several: each over its column.
  const header = [spec.title, ...(wrap ? [names[spec.views[0]]] : []), ...notes].join('  ·  ');
  await document.fonts.load('700 15px Nunito');
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = '700 15px Nunito, system-ui, sans-serif';
  const sheet = document.createElement('canvas');
  // At least as wide as its header.
  sheet.width = Math.max(spec.labels ? Math.ceil(measure.measureText(header).width) + 24 : 0,
    wrap ? labelW + columns * (widths[0] + gap) : labelW + widths.reduce((a, w) => a + w + gap, 0) - gap + (spec.labels ? gap : 0));
  sheet.height = headerH + rows * (cellH + gap) - gap + (spec.labels ? gap : 0);
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#071820';
  g.fillRect(0, 0, sheet.width, sheet.height);
  await document.fonts.load('700 13px Nunito');
  if (spec.labels) {
    drawTag(g, header, 6, 8, { size: 15 });
    if (!wrap) spec.views.forEach((view, c) => drawTag(g, names[view], lefts[c] + widths[c] - 4, 10, { size: 12, align: 'right', color: '#9fd8ef' }));
  }
  const cell = (i: number, col: number): Viewport => wrap
    ? { x: labelW + (i % columns) * (widths[0] + gap), y: headerH + Math.floor(i / columns) * (cellH + gap), w: widths[0], h: cellH, crop }
    : { x: lefts[col], y: headerH + i * (cellH + gap), w: widths[col], h: cellH, crop };
  const timeLabel = (t: number) => {
    const beat = dance.song.bpm ? (t - dance.song.beatOffsetMs) * dance.song.bpm / 60000 + 1 : null;
    return { time: `${(t / 1000).toFixed(3)}s`, beat: beat === null ? null : `beat ${beat.toFixed(2)}` };
  };
  const before = spec.before !== undefined && spec.before !== null ? await loadBefore(spec.before) : null;
  // 2D views.
  const frameWidth = Math.min(dance.frame.width, Math.round(cellW / crop.w));
  for (const [row, t] of spec.times.entries()) {
    if (spec.labels && !wrap) {
      const label = timeLabel(t);
      drawTag(g, label.time, 6, headerH + row * (cellH + gap) + 4, { size: 15 });
      if (label.beat) drawTag(g, label.beat, 6, headerH + row * (cellH + gap) + 30, { size: 12, color: '#9fd8ef' });
    }
    for (const [col, view] of spec.views.entries()) {
      if (view === 'character' || view === 'stage') continue;
      const v = cell(row, col);
      g.save(); g.beginPath(); g.rect(v.x, v.y, v.w, v.h); g.clip();
      if (view === 'skeleton') {
        g.fillStyle = '#0d2733'; g.fillRect(v.x, v.y, v.w, v.h);
        g.strokeStyle = 'rgba(120,190,210,0.12)'; g.lineWidth = 1;
        for (let k = 1; k < 10; k++) {
          const x = v.x + ((k / 10 - crop.x) / crop.w) * v.w, y = v.y + ((k / 10 - crop.y) / crop.h) * v.h;
          g.beginPath(); g.moveTo(x, v.y); g.lineTo(x, v.y + v.h); g.moveTo(v.x, y); g.lineTo(v.x + v.w, y); g.stroke();
        }
      } else if (dance.sources.video) {
        const image = await frameImage(t, frameWidth, dance.sources.video);
        g.drawImage(image, crop.x * image.width, crop.y * image.height, crop.w * image.width, crop.h * image.height, v.x, v.y, v.w, v.h);
      } else { g.fillStyle = '#10242c'; g.fillRect(v.x, v.y, v.w, v.h); drawTag(g, 'no video', v.x + 8, v.y + 8); }
      if (spec.grid) drawGrid(g, v);
      if (view !== 'source') drawDancers(g, v, data, spec, t, before);
      if (spec.labels && wrap) { const label = timeLabel(t); drawTag(g, label.beat ? `${label.time} · ${label.beat}` : label.time, v.x + 4, v.y + v.h - 24, { size: 12 }); }
      g.restore();
    }
  }
  // 3D views, one scene per view, stepped to each time.
  for (const [col, view] of spec.views.entries()) {
    if (view !== 'character' && view !== 'stage') continue;
    let canvas: HTMLCanvasElement;
    if (view === 'character') {
      const focus = spec.focus ? dance.dancers.findIndex(d => d.id === spec.focus) : null;
      canvas = await showScene({ kind: 'character', calibrations: data.calibrations, mirror: spec.mirror, focus: focus !== null && focus >= 0 ? focus : null,
        width: widths[col], height: cellH }, dance.dancers.length, version);
    } else {
      data.bundle ??= gameBundle(dance, compileDance(dance));
      canvas = await showScene({ kind: 'stage', bundle: data.bundle, stage: dance.song.stage, width: widths[col], height: cellH }, dance.dancers.length, version);
    }
    for (const [row, t] of spec.times.entries()) {
      sceneTime = t;
      poses.current = data.evaluators.map((e, i) => ({ playerId: i, landmarks: e.landmarks(t) }) as Pose)
        .map((p, i) => spec.dancers && !spec.dancers.includes(dance.dancers[i].id) ? null : p);
      // A couple of steps, so smoothing that depends on the last frame settles.
      advance(t / 1000 - 1 / 30); advance(t / 1000);
      const v = cell(row, col);
      g.drawImage(canvas, v.x, v.y, v.w, v.h);
      if (spec.labels && (row === 0 || wrap)) dance.dancers.forEach((d, i) => drawTag(g, d.id, v.x + 6 + i * 38, v.y + 6, { size: 11, color: DANCER_COLORS[i] }));
      if (spec.labels && wrap) { const label = timeLabel(t); drawTag(g, label.beat ? `${label.time} · ${label.beat}` : label.time, v.x + 4, v.y + v.h - 24, { size: 12 }); }
    }
  }
  if (spec.labels && !dance.sources.video && spec.views.some(v => v === 'source' || v === 'overlay')) drawTag(g, 'this dance has no video', 6, sheet.height - 28);
  const blob = await new Promise<Blob>((resolve, reject) => sheet.toBlob(b => b ? resolve(b) : reject(Error('Could not encode the sheet')), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ---- Tracking ----

let worker: Worker | null = null, lastTimestamp = -Infinity, ready: Promise<void> | null = null, posesWanted = 0, tilesWanted = '';
const pending = new Map<number, (landmarks: Landmark[][]) => void>();
function startWorker(numPoses: number, tiles: Tile[] | null) {
  worker?.terminate();
  pending.clear();
  worker = new Worker(new URL('../../../packages/pose/browser/pose.worker.ts', import.meta.url), { type: 'module' });
  posesWanted = numPoses;
  tilesWanted = JSON.stringify(tiles);
  lastTimestamp = -Infinity;
  const base = new URL(`/${ASSET_PATH}/`, location.origin), model = MODELS[0];
  ready = new Promise((resolve, reject) => {
    worker!.onmessage = ({ data }: MessageEvent<PoseWorkerResponse>) => {
      if (data.type === 'ready') resolve();
      else if (data.type === 'error') { reject(Error(data.message)); for (const [, done] of pending) done([]); }
      else if (data.type === 'result') {
        const done = pending.get(data.seq);
        pending.delete(data.seq);
        done?.(data.landmarks.map(points => points.map(p => ({ x: p.x, y: p.y, z: p.z, confidence: detectedConfidence(p) }))));
      }
    };
    worker!.onerror = e => reject(Error(e.message || 'The pose worker failed'));
  });
  const init: PoseWorkerRequest = { type: 'initialize', sessionId: 'dance-track', playerCount: numPoses, runningMode: 'VIDEO',
    modelUrl: new URL(model.file, base).href, modelHash: model.sha256, wasmUrl: new URL('wasm', base).href, ...(tiles ? { tiles } : {}) };
  worker.postMessage(init);
}
let seq = 0;
/**
 * Pose landmarks in each frame. With tiles (several dancers, a GPU), each dancer gets a strip of
 * the picture to follow, as the game does for three and four players: the whole-picture search
 * finds only some of several people, and small ones seldom.
 */
async function detect(frames: { width: number; height: number; timestampMs: number; rgba: string }[], numPoses: number, tiles: Tile[] | null = null): Promise<Landmark[][][]> {
  if (!worker || numPoses !== posesWanted || JSON.stringify(tiles) !== tilesWanted || frames[0] && frames[0].timestampMs <= lastTimestamp) startWorker(numPoses, tiles);
  await ready;
  const out: Landmark[][][] = [];
  for (const f of frames) {
    const raw = atob(f.rgba), pixels = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i++) pixels[i] = raw.charCodeAt(i);
    const bitmap = await createImageBitmap(new ImageData(pixels, f.width, f.height));
    const id = ++seq;
    lastTimestamp = f.timestampMs;
    out.push(await new Promise<Landmark[][]>(resolve => {
      pending.set(id, resolve);
      const message: PoseWorkerRequest = { type: 'frame', bitmap, seq: id, timestampMs: f.timestampMs, ...(tiles ? { players: tiles.length } : {}) };
      worker!.postMessage(message, [bitmap]);
    }));
  }
  return out;
}

// One request at a time: they share the page's 3D canvas and the pose worker.
let line: Promise<unknown> = Promise.resolve();
function queued<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return (...args: A): Promise<R> => {
    const run = line.then(() => fn(...args));
    line = run.catch(() => {});
    return run;
  };
}
const render = queued(renderNow);
Object.assign(window, { danceRender: { render, detect: queued(detect), formatTime } });
createRoot(document.getElementById('root')!).render(<SceneHost />);
