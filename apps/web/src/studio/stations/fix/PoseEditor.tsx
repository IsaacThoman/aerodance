// The pose editor: the dance's picture with every dancer's skeleton at the song time, over the
// project's video when it has one. Drag a joint of the selected dancer to move it at this moment
// (shift, or the toggle, moves the whole body). A drag previews through the session, so the
// coach beside it follows, and is saved as one edit on release; Escape drops it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createEvaluator } from '../../../../../../packages/dance/evaluate.ts';
import type { TakeLookup } from '../../../../../../packages/dance/evaluate.ts';
import { POINTS, roundTime } from '../../../../../../packages/dance/format.ts';
import type { Dance, PointControl } from '../../../../../../packages/dance/format.ts';
import type { Vec3 } from '../../../../../../packages/dance/rig.ts';
import { songToVideo } from '../../../../../../packages/dance/time.ts';
import { DANCER_COLORS } from '../../core/format.ts';
import { useEvaluators, useLatest, useProject, useSession } from '../../core/hooks.ts';
import { Button } from '../../core/ui.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { JOINT_WORDS } from './words.ts';

const BONES: readonly (readonly [PointControl, PointControl])[] = [
  ['leftShoulder', 'rightShoulder'], ['leftHip', 'rightHip'], ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
];
/** The joints a whole-body move shifts; elbows, knees and the head follow them. */
const BODY: readonly PointControl[] = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle'];
/** Hands, feet and the head get the larger handles; hands and feet say which side they are. */
const ENDS: Partial<Record<PointControl, string>> = { head: '', leftWrist: 'L', rightWrist: 'R', leftAnkle: 'L', rightAnkle: 'R' };
const GRAB_RADIUS = 16;

interface Size { w: number; h: number; }
interface Spot { x: number; y: number; }
/** Where the dance's frame sits in the pane, in pixels. */
interface Framing { x: number; y: number; w: number; h: number; }
/** A frame x a dancer is flipped left to right about, or null drawn as filmed. */
type Axis = number | null;
/** The room each dancer takes up across the frame over the song, how high and low they all go, and the floor (frame coordinates). */
interface Extent { spans: (readonly [number, number])[]; y0: number; y1: number; floor: number; }
/** A dancer's joints in pane pixels. */
type Joints = Record<PointControl, Spot>;
interface Drag {
  pointer: number; dancer: string; control: PointControl; whole: boolean; axis: Axis;
  /** What a drag edits here: a touch-up over recorded motion, or the pose itself where none plays. */
  kind: 'fix' | 'key';
  /** The dancer's own time being edited. */
  t: number;
  /** Where the joint was (frame), where the pointer went down (pane), and the pointer's offset from the joint. */
  from: readonly [number, number]; down: Spot; grab: Spot;
  moved: boolean;
  /** The edit to show on the next frame. */
  pending: unknown;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const flipped = (x: number, axis: Axis) => axis === null ? x : 2 * axis - x;
const toPane = (f: Framing, p: readonly number[], axis: Axis): Spot => ({ x: f.x + flipped(p[0], axis) * f.w, y: f.y + p[1] * f.h });
const toFrame = (f: Framing, x: number, y: number, axis: Axis): [number, number] => [flipped((x - f.x) / f.w, axis), (y - f.y) / f.h];
const jointsOf = (f: Framing, points: Record<PointControl, Vec3>, axis: Axis) => Object.fromEntries(POINTS.map(c => [c, toPane(f, points[c], axis)])) as Joints;
/**
 * What each dancer flips about when the picture is mirrored. The coach stands the first dancer on
 * the left and mirrors each where they stand; flipping the whole picture does the same when the
 * first dancer was filmed on the right (and is all a video can do), flipping each dancer in place
 * when they stand left to right.
 */
function mirrorAxes(dance: Dance, mirror: boolean): Axis[] {
  const inPlace = !dance.sources.video && dance.dancers.length > 1 && dance.dancers.every((d, i) => i === 0 || d.home[0] > dance.dancers[i - 1].home[0]);
  return dance.dancers.map(d => !mirror ? null : inPlace ? d.home[0] : 0.5);
}

/** Samples the saved dance for the room its dancers take up. */
function danceExtent(dance: Dance, takes: TakeLookup): Extent {
  const { playableStartMs: start, playableEndMs: end } = dance.song, step = Math.max(200, (end - start) / 240), feet: number[] = [];
  let y0 = Infinity, y1 = -Infinity;
  const spans = dance.dancers.map(dancer => {
    const evaluator = createEvaluator(dance, dancer, { style: false, takes });
    let x0 = Infinity, x1 = -Infinity;
    for (let t = start; t <= end; t += step) {
      const p = evaluator.rig(t).points;
      for (const c of POINTS) { x0 = Math.min(x0, p[c][0]); x1 = Math.max(x1, p[c][0]); y0 = Math.min(y0, p[c][1]); y1 = Math.max(y1, p[c][1]); }
      feet.push(Math.max(p.leftAnkle[1], p.rightAnkle[1]));
    }
    return [x0, x1] as const;
  });
  feet.sort((a, b) => a - b);
  const floor = (feet[feet.length >> 1] ?? 0.9) + 0.03;
  return { spans, y0, y1: Math.max(y1, floor), floor };
}
/** Fits the whole frame in the pane, or (`close`) closes in on the dancers as they're shown, clear of the pane's controls. */
function frameIn(size: Size, aspect: number, extent: Extent, axes: readonly Axis[], close: boolean): Framing {
  const whole = Math.min(size.w / aspect, size.h);
  const shown = extent.spans.map(([a, b], i) => [flipped(a, axes[i] ?? null), flipped(b, axes[i] ?? null)]);
  // Room for heads and hands, snapped outward to a coarse grid.
  const pad = 0.07, grid = 0.05;
  const low = (v: number, by: number) => Math.max(-0.25, Math.floor((v - by) / grid) * grid), high = (v: number, by: number) => Math.min(1.25, Math.ceil((v + by) / grid) * grid);
  const x0 = low(Math.min(...shown.flat()), pad / aspect), x1 = high(Math.max(...shown.flat()), pad / aspect), y0 = low(extent.y0, pad), y1 = high(extent.y1, pad);
  if (!close || !(x1 > x0 && y1 > y0)) { const h = whole, w = h * aspect; return { x: (size.w - w) / 2, y: (size.h - h) / 2, w, h }; }
  const top = 40, bottom = 54, side = 12, roomW = Math.max(40, size.w - side * 2), roomH = Math.max(40, size.h - top - bottom);
  const h = clamp(Math.min(roomW / ((x1 - x0) * aspect), roomH / (y1 - y0)), Math.min(whole, roomH), whole * 4), w = h * aspect;
  return { x: size.w / 2 - (x0 + x1) / 2 * w, y: top + roomH / 2 - (y0 + y1) / 2 * h, w, h };
}

const lighten = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${[n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * k)).join(',')})`;
};
function drawBody(g: CanvasRenderingContext2D, at: Joints, headRadius: number, color: string, bold: boolean) {
  const head = at.head, ls = at.leftShoulder, rs = at.rightShoulder, neck = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const reach = Math.hypot(head.x - neck.x, head.y - neck.y) || 1, k = Math.max(0, 1 - headRadius / reach);
  const lines = (side: 'left' | 'right') => {
    g.beginPath();
    for (const [a, b] of BONES) {
      if ((a.startsWith('right') && b.startsWith('right')) !== (side === 'right')) continue;
      g.moveTo(at[a].x, at[a].y); g.lineTo(at[b].x, at[b].y);
    }
    if (side === 'left') {
      g.moveTo(neck.x, neck.y); g.lineTo(neck.x + (head.x - neck.x) * k, neck.y + (head.y - neck.y) * k);
      g.moveTo(head.x + headRadius, head.y); g.arc(head.x, head.y, headRadius, 0, Math.PI * 2);
    }
    g.stroke();
  };
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.globalAlpha = bold ? 1 : 0.5;
  if (bold) {
    // A soft fill for the torso and a dark edge under each line keep the body readable over video.
    g.fillStyle = color; g.globalAlpha = 0.22;
    g.beginPath(); g.moveTo(ls.x, ls.y); g.lineTo(rs.x, rs.y); g.lineTo(at.rightHip.x, at.rightHip.y); g.lineTo(at.leftHip.x, at.leftHip.y); g.closePath(); g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(0, 16, 44, 0.6)'; g.lineWidth = 9;
    lines('left'); lines('right');
  }
  // The dancer's left side is drawn lighter than their right, so crossed limbs read apart.
  g.lineWidth = bold ? 5 : 3;
  g.strokeStyle = lighten(color, bold ? 0.45 : 0.3); lines('left');
  g.strokeStyle = lighten(color, bold ? 0.12 : 0.3); lines('right');
  g.restore();
}
function drawHandles(g: CanvasRenderingContext2D, at: Joints, color: string, hot: PointControl | null, all: boolean) {
  g.save();
  g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const c of POINTS) {
    const p = at[c], end = ENDS[c], lit = all || c === hot, r = (end === undefined ? 5.5 : 7.5) + (c === hot ? 2 : 0);
    g.beginPath(); g.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2); g.fillStyle = 'rgba(0, 16, 44, 0.55)'; g.fill();
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = lit ? lighten(color, 0.55) : '#fff'; g.fill();
    g.strokeStyle = color; g.lineWidth = 2; g.stroke();
    if (end) { g.fillStyle = '#0b3f80'; g.fillText(end, p.x, p.y + 0.5); }
  }
  g.restore();
}
/** A short label on a dark pill, centred above a point (below it near the top, clear of the pane's chip). */
function drawLabel(g: CanvasRenderingContext2D, size: Size, text: string, { x, y }: Spot) {
  g.save();
  g.font = '600 12px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = g.measureText(text).width + 16, h = 22, cx = clamp(x, w / 2 + 4, size.w - w / 2 - 4), cy = y < 74 ? y + 26 : y - 24;
  g.fillStyle = 'rgba(4, 26, 62, 0.88)';
  g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2); g.fill();
  g.fillStyle = '#fff'; g.fillText(text, cx, cy + 0.5);
  g.restore();
}

export default function PoseEditor() {
  const session = useSession(), { transport } = session, { dance, shown, takes } = useProject(), view = useView(), viewStore = useViewStore();
  // The pose as danced (no style), to line up with the video and to drag against.
  const evaluators = useEvaluators({ style: false });
  const pane = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), video = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState<Size>({ w: 400, h: 400 });
  const [whole, setWhole] = useState(false), [picture, setPicture] = useState(false), [dragging, setDragging] = useState(false);
  const aspect = shown.frame.width / shown.frame.height, mirror = view.mirror, selected = Math.min(view.dancer, shown.dancers.length - 1);
  // The picture is framed on the recordings as placed, and stays put while poses are touched up.
  const placed = useMemo(() => JSON.stringify([dance.frame, dance.song.playableStartMs, dance.song.playableEndMs, dance.dancers.map(d => [d.id, d.home, d.body, d.clips])]), [dance]);
  const framed = useRef<{ placed: string; takes: TakeLookup; extent: Extent } | null>(null);
  if (framed.current?.placed !== placed || framed.current.takes !== takes) framed.current = { placed, takes, extent: danceExtent(dance, takes) };
  const extent = framed.current.extent;
  const axes = useMemo(() => mirrorAxes(dance, mirror), [dance, mirror]);
  const frame = useMemo(() => frameIn(size, aspect, extent, axes, !picture), [size, aspect, extent, axes, picture]);

  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.max(40, entry.contentRect.width), h: Math.max(40, entry.contentRect.height) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The project's video, playing beneath the skeletons.
  const videoHash = dance.sources.video?.sha256 ?? null;
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!videoHash) return;
    let live = true, url: string | null = null;
    void session.videoBlob().then(blob => { if (live && blob) setVideoUrl(url = URL.createObjectURL(blob)); }, () => {});
    return () => { live = false; setVideoUrl(null); if (url) URL.revokeObjectURL(url); };
  }, [session, videoHash]);

  const drag = useRef<Drag | null>(null), hover = useRef<{ dancer: number; control: PointControl } | null>(null), stale = useRef(true);
  const latest = useLatest({ shown, evaluators, selected, frame, axes, size, whole, picture, floor: extent.floor, video: videoUrl !== null });
  useEffect(() => { stale.current = true; }, [shown, evaluators, selected, frame, axes, size, whole, picture, extent, videoUrl]);

  // One loop: shows a drag's edit (at most once a frame), keeps the video in step with the song,
  // and redraws whenever the song time or anything shown has changed.
  useEffect(() => {
    let raf = 0, drawnAt = NaN, sought = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = drag.current;
      if (d?.pending) { session.preview([d.pending]); d.pending = null; }
      const now = latest.current, t = Math.max(0, transport.timeMs()), { playing, rate } = transport.state;
      const el = video.current, source = now.shown.sources.video;
      if (el && source && el.readyState >= 1) {
        const target = clamp(songToVideo(now.shown, t) / 1000, 0, Math.max(0, (el.duration || Infinity) - 0.05));
        if (playing) {
          if (el.paused) void el.play().catch(() => {});
          if (el.playbackRate !== rate * source.rate) el.playbackRate = rate * source.rate;
          if (Math.abs(el.currentTime - target) > 0.12) el.currentTime = target;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(target - sought) > 1e-4 && Math.abs(el.currentTime - target) > 1e-3) { el.currentTime = target; sought = target; }
        }
      }
      const c = canvas.current;
      if (!c || (t === drawnAt && !stale.current)) return;
      drawnAt = t; stale.current = false;
      const dpr = window.devicePixelRatio || 1, { size, frame: f } = now;
      if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) { c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr); }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.w, size.h);
      if (!now.video) {
        // No video: a quiet floor to stand on and, with the whole picture showing, its edge.
        const y = f.y + now.floor * f.h;
        g.fillStyle = 'rgba(143, 227, 255, 0.09)'; g.fillRect(0, y, size.w, size.h - y);
        g.fillStyle = 'rgba(191, 233, 255, 0.45)'; g.fillRect(0, Math.round(y), size.w, 1);
        if (now.picture) {
          g.strokeStyle = 'rgba(255, 255, 255, 0.3)'; g.lineWidth = 1; g.setLineDash([5, 5]);
          g.strokeRect(Math.round(f.x) + 0.5, Math.round(f.y) + 0.5, Math.round(f.w) - 1, Math.round(f.h) - 1); g.setLineDash([]);
        }
      }
      const bodies = now.evaluators.map((e, i) => jointsOf(f, e.rig(t).points, now.axes[i] ?? null));
      const headRadius = (i: number) => now.shown.dancers[i].body.head * 0.6 * f.h;
      bodies.forEach((joints, i) => { if (i !== now.selected) drawBody(g, joints, headRadius(i), DANCER_COLORS[i % 4], false); });
      const joints = bodies[now.selected], color = DANCER_COLORS[now.selected % 4];
      if (!joints) return;
      if (d?.moved) {
        // Where the joint was, while it's being moved.
        const was = toPane(f, d.from, d.axis), is = joints[d.control];
        g.save();
        g.strokeStyle = 'rgba(255, 255, 255, 0.7)'; g.lineWidth = 1.5; g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(was.x, was.y); g.lineTo(is.x, is.y); g.stroke(); g.setLineDash([]);
        g.beginPath(); g.arc(was.x, was.y, 5, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
      drawBody(g, joints, headRadius(now.selected), color, true);
      const over = hover.current, hot = d ? d.control : over?.dancer === now.selected ? over.control : null;
      drawHandles(g, joints, color, hot, d ? d.whole : now.whole && hot !== null);
      if (hot) drawLabel(g, size, (d ? d.whole : now.whole) ? 'whole body' : JOINT_WORDS[hot], joints[hot]);
      else if (over && bodies[over.dancer]) drawLabel(g, size, now.shown.dancers[over.dancer].label, bodies[over.dancer][over.control]);
      // Where each handle is on the page, for scripts driving a drag.
      if (!playing && pane.current) {
        const r = c.getBoundingClientRect();
        pane.current.dataset.joints = JSON.stringify(Object.fromEntries(POINTS.map(p => [p, [Math.round(r.left + joints[p].x), Math.round(r.top + joints[p].y)]])));
        pane.current.dataset.time = String(Math.round(t));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, transport, latest]);

  const local = (e: { clientX: number; clientY: number }): Spot => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  /** The joint under a point of the pane: the selected dancer's handles first, then another dancer's body. */
  const pick = ({ x, y }: Spot): { dancer: number; control: PointControl } | null => {
    const t = Math.max(0, transport.timeMs());
    for (const i of [selected, ...evaluators.map((_, i) => i).filter(i => i !== selected)]) {
      const points = evaluators[i]?.rig(t).points;
      if (!points) continue;
      const near = POINTS.map(control => { const p = toPane(frame, points[control], axes[i] ?? null); return { dancer: i, control, d: Math.hypot(p.x - x, p.y - y) }; })
        .filter(hit => hit.d <= GRAB_RADIUS).sort((a, b) => a.d - b.d)[0];
      if (near) return near;
    }
    return null;
  };
  const editOf = (d: Drag, at: Spot) => {
    const to = toFrame(frame, at.x - d.grab.x, at.y - d.grab.y, d.axis), r = (v: number) => Math.round(clamp(v, -1, 2) * 1e5) / 1e5;
    const set = d.whole ? Object.fromEntries(BODY.map(c => [c, { dx: r(to[0] - d.from[0]), dy: r(to[1] - d.from[1]) }])) : { [d.control]: [r(to[0]), r(to[1])] };
    return { op: d.kind, dancer: d.dancer, t: d.t, set };
  };
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || drag.current) return;
    const p = local(e), hit = pick(p);
    if (!hit) return;
    if (hit.dancer !== selected) { viewStore.set({ dancer: hit.dancer }); return; }
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer that can't be captured still drags inside the pane */ }
    if (transport.state.playing) transport.pause();
    const songMs = Math.max(0, transport.timeMs()), dancer = shown.dancers[selected], evaluator = evaluators[selected], axis = axes[selected] ?? null;
    const at = evaluator.rig(songMs).points[hit.control], on = toPane(frame, at, axis);
    drag.current = { pointer: e.pointerId, dancer: dancer.id, control: hit.control, whole: whole || e.shiftKey, axis, kind: dancer.clips.length ? 'fix' : 'key',
      t: roundTime(songMs - dancer.timeOffsetMs), from: [at[0], at[1]], down: p, grab: { x: p.x - on.x, y: p.y - on.y }, moved: false, pending: null };
    setDragging(true);
    stale.current = true;
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = local(e), d = drag.current;
    if (!d) {
      const hit = pick(p), was = hover.current;
      if (hit?.dancer !== was?.dancer || hit?.control !== was?.control) { hover.current = hit; stale.current = true; }
      e.currentTarget.style.cursor = !hit ? 'default' : hit.dancer === selected ? 'grab' : 'pointer';
      return;
    }
    // A click does nothing; only a real drag moves the joint.
    if (!d.moved && Math.hypot(p.x - d.down.x, p.y - d.down.y) < 3) return;
    d.moved = true;
    d.pending = editOf(d, p);
    e.currentTarget.style.cursor = 'grabbing';
  };
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.style.cursor = 'grab';
    stale.current = true;
    if (d.moved) void session.apply([editOf(d, local(e))], d.whole ? 'move the whole body' : `move the ${JOINT_WORDS[d.control]}`);
  };
  const cancel = useLatest(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    session.preview(null);
    try { canvas.current?.releasePointerCapture(d.pointer); } catch { /* already released */ }
  });
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragging, cancel]);
  // Leaving mid-drag drops the edit rather than leaving its preview showing.
  useEffect(() => () => { if (drag.current) { drag.current = null; session.preview(null); } }, [session]);

  const dancer = shown.dancers[selected];
  return (
    <div className={`viewport pose-editor${videoUrl ? ' has-video' : ''}`} ref={pane} data-dancer={dancer?.id} data-mirror={mirror} data-whole={whole} data-dragging={dragging}>
      {videoUrl && <video ref={video} src={videoUrl} muted playsInline preload="auto"
        style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, transform: mirror ? 'scaleX(-1)' : undefined }} />}
      <canvas ref={canvas} aria-label={`${dancer?.label ?? 'The dancer'}'s pose at this moment: drag a joint to move it`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => cancel.current()}
        onPointerLeave={() => { if (!drag.current && hover.current) { hover.current = null; stale.current = true; } }} />
      <div className="viewport-chip" title={mirror ? 'Flipped left to right, so it faces the same way as the coach' : 'The picture as the camera saw it'}>
        {mirror ? 'Mirrored, like the coach' : 'As filmed: the dancer\'s left is on the right'}
      </div>
      <div className="pose-tools">
        <Button icon="mirror" on={mirror} title="Flip the picture left to right, to match the coach" onClick={() => viewStore.set({ mirror: !mirror })}>Mirror</Button>
        <Button icon="person" on={whole} title="Drag any joint to move every joint together (or hold Shift while you drag)" onClick={() => setWhole(v => !v)}>
          <span className="full">Move the whole body</span><span className="brief">Whole body</span>
        </Button>
        <Button on={picture} className="pose-picture" aria-label="Show the whole picture" title={picture ? 'Close in on the dancers' : 'Show the whole picture'} onClick={() => setPicture(v => !v)}>
          <svg className="icon-svg" width={16} height={16} viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z" /></svg>
        </Button>
      </div>
    </div>
  );
}
