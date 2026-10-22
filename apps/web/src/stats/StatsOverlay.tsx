import { useEffect, useRef } from 'react';
import { addAfterEffect, addEffect, useThree } from '@react-three/fiber';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { PIXEL_CAP, drawPixelText, loadPixelFont, pixelTextWidth } from '../ui/pixelFont.ts';
import { RENDER_SIZE, displayModeFor } from '../display.ts';
import { getMixer } from '../audio/mixer.ts';
import { isPoseRecordEvent } from '../pose/PoseSource.ts';
import type { PoseSource } from '../pose/PoseSource.ts';
import type { GameSession } from '../game/GameSession.ts';
import type { StatsSetting } from '../menu/graphicsSettings.ts';
import { SampleWindow, count, fixed, gpuName, mean, rate, summariseFrames } from './frameStats.ts';

/**
 * Performance stats in the top left, for Settings → Graphics → Stats (or ?diag=stats): Basic is
 * the frame rate, frame times and pose tracking; Full adds CPU and GPU time, what the renderer
 * draws, the resolution and GPU, a frame-time graph, tracking details, the audio clock and memory.
 *
 * It is an overlay (ui/useCanvasUI.ts) laid out in render-buffer pixels (640x480), drawn last,
 * in Tiny5 with one font pixel to one canvas pixel (ui/pixelFont.ts), everything on whole
 * pixels. (In 16:9 the buffer is stretched like the rest of the picture, so the text is too.)
 *
 * Frames are timed around everything the canvas does in a frame (R3F's addEffect and
 * addAfterEffect): the interval between frames, the main thread's time in them (CPU) and, where
 * EXT_disjoint_timer_query_webgl2 is offered, the GPU's (not on Safari). The text and the
 * canvas's data-stats-* attributes (for scripts/play.ts and tests) update four times a second.
 *
 * <StatsOverlay mode="basic" source={poseSource} game={session} screen="menu/settings" />
 */

export interface StatsOverlayProps {
  mode: Exclude<StatsSetting, 'off'>;
  /** The pose source the game plays with. */
  source: PoseSource;
  /** The song being danced, if any. */
  game: GameSession | null;
  /** Where the app is, e.g. "menu/settings" or "game/playing". */
  screen: string;
}

// Baseline to baseline: 5px capitals, a 1px descender and 2px between lines.
const LINE = 8;
const PAD = 2;
const MARGIN = 2;
const UPDATE_S = 0.25;
const WINDOW_MS = 2000;
// The frame-time graph: one column per frame, 2ms per pixel, with a line at 60 fps.
const GRAPH = { frames: 120, h: 24, msPerPx: 2 };
const BUDGET_MS = 1000 / 60;

const BG = 'rgba(4, 20, 42, 0.8)';
const LABEL = '#6ff3d6';
const VALUE = '#ffffff';
const DIM = '#8fa9c4';
const WARN = '#ffd84a';
const BAD = '#ff7070';

/** A run of text; w makes it a field that wide (px), right-aligned, so changing digits don't shift what follows. */
interface Seg { text: string; color?: string; w?: number; }
type Line = Seg[];

const label = (text: string): Seg => ({ text: `${text} `, color: LABEL });
const value = (text: string, w = 0, color = VALUE): Seg => ({ text, w, color });
const unit = (text: string): Seg => ({ text, color: DIM });
const gap: Seg = { text: '  ' };
// Good, poor or bad by thresholds, lower being better unless higherIsBetter.
const grade = (v: number, ok: number, poor: number, higherIsBetter = false) => {
  if (!Number.isFinite(v)) return DIM;
  const [a, b] = higherIsBetter ? [-v, -ok] : [v, ok];
  if (a <= b) return VALUE;
  return (higherIsBetter ? v >= poor : v <= poor) ? WARN : BAD;
};
const frameColor = (ms: number) => grade(ms, BUDGET_MS * 1.1, BUDGET_MS * 2.1);

type MemoryPerformance = Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };

interface GpuTimer {
  begin(): void;
  end(): void;
  /** Hands over the GPU times (ms) of finished frames. */
  collect(add: (ms: number) => void): void;
  dispose(): void;
}

// GPU time per frame with timer queries, read back a few frames later.
function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const free: WebGLQuery[] = [];
  const pending: WebGLQuery[] = [];
  let open: WebGLQuery | null = null;
  return {
    begin() {
      // Results that never come back (a lost context) don't pile up.
      if (open || pending.length > 8) return;
      open = free.pop() ?? gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, open);
    },
    end() {
      if (!open) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(open);
      open = null;
    },
    collect(add) {
      // A disjoint (the GPU was interrupted) spoils every result in flight.
      const disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const query = pending.shift();
        if (!query) break;
        if (!disjoint) add(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        free.push(query);
      }
    },
    dispose() {
      if (open) gl.endQuery(ext.TIME_ELAPSED_EXT);
      for (const query of [...free, ...pending, ...(open ? [open] : [])]) gl.deleteQuery(query);
    },
  };
}

/** What the overlay measures between its redraws. */
interface Meters {
  frames: SampleWindow;
  cpu: SampleWindow;
  gpu: SampleWindow;
  poseArrivals: SampleWindow;
  longTasks: SampleWindow;
  gpuTimer: GpuTimer | null;
  gpuSupported: boolean;
  lastFrame: number;
  frameStart: number;
  draws: number;
  triangles: number;
}

const newMeters = (): Meters => ({
  frames: new SampleWindow(WINDOW_MS), cpu: new SampleWindow(WINDOW_MS), gpu: new SampleWindow(WINDOW_MS),
  poseArrivals: new SampleWindow(WINDOW_MS), longTasks: new SampleWindow(10_000),
  gpuTimer: null, gpuSupported: false, lastFrame: 0, frameStart: 0, draws: 0, triangles: 0,
});

export default function StatsOverlay({ mode, source, game, screen }: StatsOverlayProps) {
  const gl = useThree((state) => state.gl);
  const meters = useRef<Meters>(null);
  meters.current ??= newMeters();
  const m = meters.current;
  const props = useRef({ mode, source, game, screen });
  props.current = { mode, source, game, screen };
  const shown = useRef<{ lines: Line[]; graph: number[] | null; at: number }>({ lines: [], graph: null, at: -Infinity });
  const gpu = useRef('');

  // Time every frame of the canvas, from before its first useFrame to after its last render.
  useEffect(() => {
    const { info } = gl;
    const autoReset = info.autoReset;
    const context = gl.getContext();
    m.gpuTimer = mode === 'full' && context instanceof WebGL2RenderingContext ? createGpuTimer(context) : null;
    m.gpuSupported = !!m.gpuTimer;
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    gpu.current = gpuName(String(context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER) ?? ''));
    m.lastFrame = 0;
    const offBefore = addEffect((timestamp) => {
      const interval = timestamp - m.lastFrame;
      // A hidden page stops the frames: the gap after it isn't a frame.
      if (m.lastFrame && interval > 0 && interval < 1000) m.frames.add(timestamp, interval);
      m.lastFrame = timestamp;
      m.frameStart = performance.now();
      m.gpuTimer?.collect((ms) => m.gpu.add(performance.now(), ms));
      m.gpuTimer?.begin();
      // Count this frame's draws across all its renders (a stage's post pass resets them once more).
      info.autoReset = false;
      info.reset();
    });
    const offAfter = addAfterEffect(() => {
      m.gpuTimer?.end();
      const now = performance.now();
      m.cpu.add(now, now - m.frameStart);
      m.draws = info.render.calls;
      m.triangles = info.render.triangles;
    });
    return () => {
      offBefore();
      offAfter();
      m.gpuTimer?.dispose();
      m.gpuTimer = null;
      m.gpu.clear();
      info.autoReset = autoReset;
    };
  }, [gl, mode, m]);

  // Poses as they arrive from the source, and how long after their camera frame.
  const poseAges = useRef(new SampleWindow(WINDOW_MS)).current;
  useEffect(() => source.subscribeRecords((event) => {
    if (!isPoseRecordEvent(event)) return;
    m.poseArrivals.add(event.receivedBrowserTimeMs, 1);
    poseAges.add(event.receivedBrowserTimeMs, event.receivedBrowserTimeMs - event.captureBrowserTimeMs);
  }), [source, m, poseAges]);

  // Main-thread tasks over 50ms (Chromium only).
  useEffect(() => {
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return undefined;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) m.longTasks.add(entry.startTime + entry.duration, entry.duration);
    });
    observer.observe({ type: 'longtask' });
    return () => observer.disconnect();
  }, [m]);

  const fontReady = useRef(false);
  // The canvas's data-stats-* attributes go when the overlay does.
  useEffect(() => () => {
    for (const key of Object.keys(gl.domElement.dataset)) if (key.startsWith('stats')) delete gl.domElement.dataset[key];
  }, [gl]);

  const measure = (now: number) => {
    const { mode: full, source: src, game: session, screen: where } = props.current;
    for (const w of [m.frames, m.cpu, m.gpu, m.poseArrivals, poseAges, m.longTasks]) w.prune(now);
    const frame = summariseFrames(m.frames.values);
    const cpuMs = mean(m.cpu.values);
    const gpuMs = mean(m.gpu.values);
    const view = src.view;
    const tracking = !['disconnected', 'error'].includes(view.status) || m.poseArrivals.size > 0;
    const poseHz = rate(m.poseArrivals.times);
    const poseAge = mean(poseAges.values);

    const { dataset } = gl.domElement;
    Object.assign(dataset, {
      statsMode: full, statsFps: fixed(frame.fps, 1), statsFrameMs: fixed(frame.avgMs, 1), statsP99Ms: fixed(frame.p99Ms, 1),
      statsMaxMs: fixed(frame.maxMs, 1), statsCpuMs: fixed(cpuMs, 1), statsGpuMs: fixed(gpuMs, 1), statsDrawCalls: String(m.draws),
      statsTriangles: String(m.triangles), statsPoseHz: fixed(poseHz, 1), statsPoseAgeMs: fixed(poseAge, 0),
    });

    const lines: Line[] = [
      [label('FPS'), value(fixed(frame.fps), 12, grade(frame.fps, 55, 30, true)), gap, value(fixed(frame.avgMs, 1), 18, frameColor(frame.avgMs)), unit('MS')],
      [label('P99'), value(fixed(frame.p99Ms, 1), 18, frameColor(frame.p99Ms)), gap, label('MAX'), value(fixed(frame.maxMs, 1), 18, frameColor(frame.maxMs))],
      tracking
        ? [label('POSE'), value(fixed(poseHz), 8, grade(poseHz, 24, 15, true)), unit('HZ'), gap, label('AGE'), value(fixed(poseAge), 12, grade(poseAge, 100, 250)), unit('MS')]
        : [label('POSE'), unit('OFF')],
    ];
    if (full === 'full') {
      const el = gl.domElement;
      const dpr = devicePixelRatio || 1;
      const { info } = gl;
      lines.push(
        [label('CPU'), value(fixed(cpuMs, 1), 18, frameColor(cpuMs)), unit('MS'), gap, label('GPU'),
          m.gpuSupported ? value(fixed(gpuMs, 1), 18, frameColor(gpuMs)) : value('N/A', 0, DIM), ...(m.gpuSupported ? [unit('MS')] : [])],
        [label('DRAWS'), value(count(m.draws), 12), gap, label('TRIS'), value(count(m.triangles), 18)],
        [label('GEO'), value(count(info.memory.geometries), 12), gap, label('TEX'), value(count(info.memory.textures), 12), gap,
          label('SHADERS'), value(count(info.programs?.length ?? NaN), 8)],
        [value(`${RENDER_SIZE.w}X${RENDER_SIZE.h}`), unit(' > '), value(`${Math.round(el.clientWidth * dpr)}X${Math.round(el.clientHeight * dpr)}`), gap,
          value(displayModeFor(el.clientWidth, el.clientHeight) === 'widescreen' ? '16:9' : '4:3', 0, DIM)],
        [value(gpu.current.toUpperCase(), 0, DIM)],
      );
      const trackingLine: Line = [label(view.sourceKind.toUpperCase()), value(view.model.toUpperCase(), 0, VALUE)];
      if (view.delegate) trackingLine.push(unit(` ${view.delegate.toUpperCase()}`));
      if (view.status !== 'connected') trackingLine.push(value(` ${view.status.toUpperCase()}`, 0, view.status === 'error' ? BAD : DIM));
      const stats = view.stats;
      if (stats?.inferenceMs != null) trackingLine.push(gap, label('INF'), value(fixed(stats.inferenceMs), 8), unit('MS'));
      if (stats?.droppedFrames != null) trackingLine.push(gap, label('DROP'), value(String(stats.droppedFrames), 0, stats.droppedFrames ? WARN : VALUE));
      if (stats?.clockUncertaintyMs != null) trackingLine.push(gap, label('SYNC'), value(fixed(stats.clockUncertaintyMs), 0), unit('MS'));
      lines.push(trackingLine);
      const { ctx } = getMixer();
      lines.push([label('AUDIO OUT'), value(fixed((ctx.outputLatency || 0) * 1000), 12), unit('MS'), gap, label('BASE'),
        value(fixed((ctx.baseLatency || 0) * 1000), 8), unit('MS'), gap, value(ctx.state.toUpperCase(), 0, ctx.state === 'running' ? DIM : WARN)]);
      // The song's drawn position and how far it runs ahead of the heard one (on a TV: the output latency).
      const player = session?.player;
      if (player && session && ['countdown', 'playing', 'paused', 'finishing'].includes(session.phase)) {
        const ahead = player.timeMs() - player.songTimeAt(performance.now());
        lines.push([label('SONG'), value(fixed(player.timeMs() / 1000, 1), 0), unit('S'), gap, label('DRAW'), value(`${ahead >= 0 ? '+' : ''}${fixed(ahead)}`, 0), unit('MS')]);
      }
      const memory = (performance as MemoryPerformance).memory;
      const longest = m.longTasks.size ? Math.max(...m.longTasks.values) : 0;
      lines.push([
        ...(memory ? [label('HEAP'), value(fixed(memory.usedJSHeapSize / 2 ** 20)), unit(`/${fixed(memory.jsHeapSizeLimit / 2 ** 20)}MB`), gap] : []),
        label('LONG'), value(String(m.longTasks.size), 0, m.longTasks.size ? WARN : VALUE),
        ...(m.longTasks.size ? [unit(` ${fixed(longest)}MS`)] : []), unit(' /10S'),
      ]);
      lines.push([value(where.toUpperCase(), 0, DIM)]);
    }
    shown.current = { lines, graph: full === 'full' ? m.frames.values.slice(-GRAPH.frames) : null, at: now };
  };

  const ui = useCanvasUI({
    priority: 4,
    // One design unit is one render-buffer pixel.
    design: () => RENDER_SIZE,
    update: () => {
      const now = performance.now();
      if (now - shown.current.at < UPDATE_S * 1000) return;
      measure(now);
      ui.invalidate();
    },
    draw: (g) => {
      if (!fontReady.current) return;
      const { lines, graph } = shown.current;
      const segWidth = (seg: Seg) => Math.max(seg.w ?? 0, pixelTextWidth(seg.text));
      const widths = lines.map((line) => line.reduce((w, seg) => w + segWidth(seg), 0));
      // 8n + 2 tall for n lines: capitals start PAD below the top, descenders end PAD above the bottom.
      const textH = lines.length * LINE + 2;
      const graphH = graph ? GRAPH.h + PAD : 0;
      const w = Math.max(...widths, graph ? GRAPH.frames : 0) + PAD * 2;
      // The graph goes under the frame times.
      const splitAt = 2;
      g.fillStyle = BG;
      g.fillRect(MARGIN, MARGIN, w, textH + graphH);

      let y = MARGIN + PAD + PIXEL_CAP;
      lines.forEach((line, i) => {
        if (i === splitAt && graph) {
          drawGraph(g, graph, MARGIN + PAD, y - PIXEL_CAP);
          y += graphH;
        }
        let x = MARGIN + PAD;
        for (const seg of line) {
          const sw = segWidth(seg);
          drawPixelText(g, seg.text, x + (seg.w ? sw - pixelTextWidth(seg.text) : 0), y, seg.color ?? VALUE);
          x += sw;
        }
        y += LINE;
      });
    },
  });

  // Fonts load lazily: draw once Tiny5 is in.
  useEffect(() => {
    let cancelled = false;
    loadPixelFont().then((ok) => { if (ok && !cancelled) { fontReady.current = true; ui.invalidate(); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [ui]);

  return null;
}

// The last frames' intervals as columns, 1px each, against a line at the 60 fps budget.
function drawGraph(g: CanvasRenderingContext2D, intervals: readonly number[], x: number, y: number) {
  const { frames, h, msPerPx } = GRAPH;
  g.fillStyle = 'rgba(0, 0, 0, 0.35)';
  g.fillRect(x, y, frames, h);
  const x0 = x + frames - intervals.length;
  intervals.forEach((ms, i) => {
    const bar = Math.max(1, Math.min(h, Math.floor(ms / msPerPx)));
    g.fillStyle = frameColor(ms) === VALUE ? LABEL : frameColor(ms);
    g.fillRect(x0 + i, y + h - bar, 1, bar);
  });
  g.fillStyle = 'rgba(255, 255, 255, 0.45)';
  // Just above the bars of frames on budget.
  g.fillRect(x, y + h - Math.ceil(BUDGET_MS / msPerPx), frames, 1);
}
