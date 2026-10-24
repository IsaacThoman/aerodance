// The source video with every dancer's skeleton over it, at the song clock. Drag a joint to key
// it at the playhead (the drag previews; releasing saves one key op). Wheel zooms around the
// pointer, drag the background to pan, double-click the background to fit.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createEvaluator, keyTimes } from '../evaluate.ts';
import { isMidJoint, roundTime } from '../format.ts';
import type { Control, Dance, PointControl } from '../format.ts';
import { LANDMARK_OF } from '../rig.ts';
import { songToVideo } from '../time.ts';
import type { TrackingData } from '../tracking.ts';
import type { SongClock } from './clock.ts';
import { DANCER_COLORS, REFERENCE_COLOR, drawSkeleton, stretchedBones, toCanvas, toFrame } from './skeleton.ts';
import type { Viewport } from './skeleton.ts';

export interface Selection { dancer: string; control: Control | null; }
const HANDLES: readonly PointControl[] = ['head', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];
export interface VideoPaneProps {
  dance: Dance;
  clock: SongClock;
  selection: Selection;
  onSelect(selection: Selection): void;
  /** A drag in progress (ops to preview), or null when it ends without a change. */
  onPreview(ops: unknown[] | null): void;
  onCommit(ops: unknown[], label: string): void;
  tracking: Map<string, { data: TrackingData; slot: number }>;
  showReference: boolean;
  showGhosts: boolean;
  /** Only the selected dancer can be dragged; the others are drawn fainter. */
  soloSelected: boolean;
}
export default function VideoPane({ dance, clock, selection, onSelect, onPreview, onCommit, tracking, showReference, showGhosts, soloSelected }: VideoPaneProps) {
  const box = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [view, setView] = useState({ zoom: 1, cx: 0.5, cy: 0.5 });
  const evaluators = useMemo(() => dance.dancers.map(d => createEvaluator(dance, d)), [dance]);
  const drag = useRef<{ dancer: string; control: PointControl; pointer: number } | { pan: true; x: number; y: number; cx: number; cy: number; pointer: number } | null>(null);
  const latest = useRef({ dance, evaluators, selection, showReference, showGhosts, view, size, soloSelected, tracking });
  latest.current = { dance, evaluators, selection, showReference, showGhosts, view, size, soloSelected, tracking };
  const frameAspect = dance.frame.width / dance.frame.height;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.max(50, entry.contentRect.width), h: Math.max(50, entry.contentRect.height) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The frame, fitted to the pane, then zoomed about (cx, cy).
  const viewport = (s = size, v = view): Viewport => {
    const fit = Math.min(s.w / frameAspect, s.h);
    const h = fit * v.zoom, w = h * frameAspect;
    const crop = { x: 0, y: 0, w: 1, h: 1 };
    return { x: s.w / 2 - v.cx * w, y: s.h / 2 - v.cy * h, w, h, crop };
  };

  // Draw every frame: the video follows the clock and the skeletons are redrawn.
  useEffect(() => {
    let frame = 0, lastSeek = -1;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const { dance, evaluators, selection, showReference, showGhosts, size, soloSelected, tracking } = latest.current;
      const t = clock.now(), el = video.current, c = canvas.current;
      if (el && dance.sources.video && el.readyState >= 1) {
        const target = songToVideo(dance, t) / 1000, rate = clock.rate * dance.sources.video.rate;
        if (clock.playing) {
          if (el.paused) void el.play().catch(() => {});
          if (el.playbackRate !== rate) el.playbackRate = rate;
          if (Math.abs(el.currentTime - target) > 0.12) el.currentTime = Math.max(0, target);
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(target - lastSeek) > 1e-4 && Math.abs(el.currentTime - target) > 1e-3) { el.currentTime = Math.max(0, target); lastSeek = target; }
        }
      }
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) { c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr); }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.w, size.h);
      const v = viewport(size, latest.current.view);
      if (!dance.sources.video) {
        g.fillStyle = '#0d2733'; g.fillRect(v.x, v.y, v.w, v.h);
        g.strokeStyle = 'rgba(120,190,210,0.12)';
        for (let k = 1; k < 10; k++) {
          g.beginPath(); g.moveTo(v.x + v.w * k / 10, v.y); g.lineTo(v.x + v.w * k / 10, v.y + v.h);
          g.moveTo(v.x, v.y + v.h * k / 10); g.lineTo(v.x + v.w, v.y + v.h * k / 10); g.stroke();
        }
      }
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1; g.strokeRect(v.x, v.y, v.w, v.h);
      dance.dancers.forEach((dancer, i) => {
        const color = DANCER_COLORS[i % DANCER_COLORS.length], selected = dancer.id === selection.dancer;
        if (showGhosts && selected) {
          const times = keyTimes(dancer), local = t - dancer.timeOffsetMs;
          const prev = [...times].reverse().find(k => k < local - 1), next = times.find(k => k > local + 1);
          for (const k of [prev, next]) if (k !== undefined) drawSkeleton(g, v, evaluators[i].landmarks(k + dancer.timeOffsetMs), { color, alpha: 0.25, scale: 0.8 });
        }
        const reference = showReference ? tracking.get(dancer.id) : undefined;
        const live = reference?.data.poseAt(reference.slot, songToVideo(dance, t));
        if (live) drawSkeleton(g, v, live, { color: REFERENCE_COLOR, dashed: true, alpha: 0.85, scale: 0.8 });
        const control = selected && selection.control && LANDMARK_OF[selection.control as Exclude<PointControl, 'head'>];
        const hollow = Object.entries(LANDMARK_OF).filter(([c]) => isMidJoint(c) && !(dancer.layers[0].channels[c]?.length)).map(([, j]) => j);
        const landmarks = evaluators[i].landmarks(t);
        drawSkeleton(g, v, landmarks, { color, label: dancer.id, alpha: soloSelected && !selected ? 0.4 : 1, hollow,
          warn: stretchedBones(landmarks, dancer.body, dance.frame.width / dance.frame.height),
          highlight: selection.control === 'head' && selected ? [] : control ? [control] : [], scale: selected ? 1.1 : 0.9 });
        if (selected && selection.control === 'head') {
          const head = toCanvas(v, { x: evaluators[i].rig(t).points.head[0], y: evaluators[i].rig(t).points.head[1] });
          g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(head.x, head.y, 9, 0, Math.PI * 2); g.stroke();
        }
      });
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [clock]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where a joint is on the page now, for scripted tests and tools (play.ts drag).
  useEffect(() => {
    const w = window as unknown as { danceStudio?: { jointOnPage(dancer: string, control: PointControl): { x: number; y: number } | null } };
    w.danceStudio = {
      jointOnPage(dancerId, control) {
        const { dance, evaluators, size, view } = latest.current, i = dance.dancers.findIndex(d => d.id === dancerId), c = canvas.current;
        if (i < 0 || !c) return null;
        const p = evaluators[i].rig(clock.now()).points[control], r = c.getBoundingClientRect();
        const at = toCanvas(viewport(size, view), { x: p[0], y: p[1] });
        return { x: Math.round(r.left + at.x), y: Math.round(r.top + at.y) };
      },
    };
    return () => { delete w.danceStudio; };
  }, [clock]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (px: number, py: number) => {
    const v = viewport();
    let best: { dancer: string; control: PointControl; d: number } | null = null;
    dance.dancers.forEach((dancer, i) => {
      if (soloSelected && dancer.id !== selection.dancer) return;
      const rig = evaluators[i].rig(clock.now());
      for (const control of HANDLES) {
        const p = toCanvas(v, { x: rig.points[control][0], y: rig.points[control][1] });
        const d = Math.hypot(p.x - px, p.y - py) - (dancer.id === selection.dancer ? 3 : 0);
        if (d < 14 && (!best || d < best.d)) best = { dancer: dancer.id, control, d };
      }
    });
    return best as { dancer: string; control: PointControl; d: number } | null;
  };
  const local = (e: ReactPointerEvent | React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const keyOp = (dancer: string, control: PointControl, px: number, py: number) => {
    const p = toFrame(viewport(), px, py);
    return { op: 'key', dancer, t: roundTime(clock.now()), set: { [control]: { x: Math.round(p.x * 1e5) / 1e5, y: Math.round(p.y * 1e5) / 1e5 } } };
  };
  return (
    <div className="video-pane" ref={box} aria-label="Video with the dance's skeletons">
      {dance.sources.video && (() => {
        const v = viewport();
        return <video ref={video} src="/api/media/proxy" muted playsInline preload="auto"
          style={{ left: v.x, top: v.y, width: v.w, height: v.h }} />;
      })()}
      <canvas ref={canvas} style={{ width: size.w, height: size.h }}
        onPointerDown={e => {
          const p = local(e), hit = pick(p.x, p.y);
          e.currentTarget.setPointerCapture(e.pointerId);
          if (hit) {
            if (clock.playing) clock.pause();
            onSelect({ dancer: hit.dancer, control: hit.control });
            drag.current = { dancer: hit.dancer, control: hit.control, pointer: e.pointerId };
          } else drag.current = { pan: true, x: p.x, y: p.y, cx: view.cx, cy: view.cy, pointer: e.pointerId };
        }}
        onPointerMove={e => {
          const d = drag.current, p = local(e);
          if (!d) { canvas.current!.style.cursor = pick(p.x, p.y) ? 'grab' : 'default'; return; }
          if ('pan' in d) {
            const v = viewport();
            setView(view => ({ ...view, cx: d.cx - (p.x - d.x) / v.w, cy: d.cy - (p.y - d.y) / v.h }));
            return;
          }
          canvas.current!.style.cursor = 'grabbing';
          onPreview([keyOp(d.dancer, d.control, p.x, p.y)]);
        }}
        onPointerUp={e => {
          const d = drag.current;
          drag.current = null;
          if (!d || 'pan' in d) return;
          const p = local(e), op = keyOp(d.dancer, d.control, p.x, p.y);
          onCommit([op], `move ${d.control}`);
        }}
        onPointerCancel={() => { drag.current = null; onPreview(null); }}
        onDoubleClick={e => { const p = local(e); if (!pick(p.x, p.y)) setView({ zoom: 1, cx: 0.5, cy: 0.5 }); }}
        onWheel={e => {
          const p = local(e), v = viewport(), before = toFrame(v, p.x, p.y);
          const zoom = Math.min(8, Math.max(1, view.zoom * Math.exp(-e.deltaY * 0.0015)));
          // Keep the point under the pointer where it is.
          const h = Math.min(size.w / frameAspect, size.h) * zoom, w = h * frameAspect;
          setView({ zoom, cx: before.x - (p.x - size.w / 2) / w, cy: before.y - (p.y - size.h / 2) / h });
        }} />
      {view.zoom > 1.01 && <div className="zoom-badge">{view.zoom.toFixed(1)}× · double-click to fit</div>}
      {!dance.sources.video && <div className="pane-note">No video: attach one with <code>dance attach &lt;project&gt; --video file</code></div>}
    </div>
  );
}
