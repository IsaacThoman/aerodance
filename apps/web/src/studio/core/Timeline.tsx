// The song laid out left to right: bars and beats, the music's waveform, the song's sections,
// and whatever lanes a station adds beneath (clips, fixes, a playtest's heat). Click or drag the
// ruler to move through the song; shift-drag to select a stretch (it snaps to beats; hold Alt
// for free); ctrl/⌘-wheel zooms about the pointer.
//
//   <Timeline>
//     <Lane label="Dancer 1"><Span start={a} end={b} className="clip">…</Span></Lane>
//   </Timeline>
//
// Lane children are positioned in song time: use <Span>, or useTimeline().toX(ms) for a left
// offset inside the lane.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { waveformPeaks } from '../../../../../packages/dance/beats.ts';
import { barBeat, beatMs, clock, snapToGrid } from './format.ts';
import { useProject, useSession, useTransport } from './hooks.ts';
import { useView, useViewStore } from './view.ts';

export interface TimelineApi {
  pxPerMs: number; durationMs: number;
  /** A song time's offset from the lanes' left edge, in pixels. */
  toX(ms: number): number;
  /** The song time under a pointer (clientX), clamped to the song. */
  toMs(clientX: number): number;
  /** The nearest beat (or half beat with `fine`); the time itself when the song has no tempo. */
  snap(ms: number, fine?: boolean): number;
}
const TimelineContext = createContext<TimelineApi | null>(null);
export function useTimeline(): TimelineApi {
  const api = useContext(TimelineContext);
  if (!api) throw Error('useTimeline needs a <Timeline> above it');
  return api;
}
const LABEL_WIDTH = 112, RULER_HEIGHT = 26, WAVE_HEIGHT = 44;
const SECTION_HUES = [205, 275, 150, 330, 35, 185, 95, 300];

export interface TimelineProps {
  children?: ReactNode;
  /** Leave the built-in sections row out (a station drawing its own). */
  sections?: boolean;
  className?: string;
}
export function Timeline({ children, sections = true, className = '' }: TimelineProps) {
  const session = useSession(), { transport } = session, { shown: dance } = useProject(), transportState = useTransport();
  const view = useView(), viewStore = useViewStore();
  const durationMs = Math.max(1, transportState.durationMs);
  const scroller = useRef<HTMLDivElement>(null), ruler = useRef<HTMLCanvasElement>(null), wave = useRef<HTMLCanvasElement>(null), playhead = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  // Zoom: null fits the whole song in the pane.
  const [zoom, setZoom] = useState<number | null>(null);
  const fit = Math.max(0.002, (width - LABEL_WIDTH - 8) / durationMs);
  const pxPerMs = zoom ?? fit;
  const contentWidth = Math.max(width - LABEL_WIDTH, Math.ceil(durationMs * pxPerMs));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const api = useMemo((): TimelineApi => ({
    pxPerMs, durationMs,
    toX: ms => ms * pxPerMs,
    toMs: clientX => {
      const el = scroller.current;
      if (!el) return 0;
      const x = clientX - el.getBoundingClientRect().left - LABEL_WIDTH + el.scrollLeft;
      return Math.max(0, Math.min(durationMs, x / pxPerMs));
    },
    snap: (ms, fine = false) => snapToGrid(dance, ms, fine ? 2 : 1),
  }), [pxPerMs, durationMs, dance]);

  // The waveform's peaks, a few per pixel at the deepest zoom worth drawing.
  const peaks = useMemo(() => {
    void transportState.ready;
    return transport.pcm ? waveformPeaks(transport.pcm, Math.min(60_000, Math.max(1000, Math.ceil(durationMs / 8)))) : null;
  }, [transport, transportState.ready, durationMs]);

  const draw = useCallback(() => {
    const el = scroller.current, r = ruler.current, w = wave.current;
    if (!el || !r || !w) return;
    const visible = el.clientWidth - LABEL_WIDTH, dpr = window.devicePixelRatio || 1, left = el.scrollLeft;
    for (const [canvas, height] of [[r, RULER_HEIGHT], [w, WAVE_HEIGHT]] as const) {
      if (canvas.width !== Math.round(visible * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(visible * dpr); canvas.height = Math.round(height * dpr); }
      canvas.style.width = `${visible}px`; canvas.style.height = `${height}px`;
    }
    const from = left / pxPerMs, to = (left + visible) / pxPerMs;
    const g = r.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, visible, RULER_HEIGHT);
    g.font = '600 10px Inter, sans-serif'; g.textBaseline = 'top';
    const beat = beatMs(dance);
    if (beat) {
      // Bars numbered; beats ticked while there's room for them.
      const bar = beat * 4, barPx = bar * pxPerMs, every = barPx >= 34 ? 1 : barPx >= 17 ? 2 : barPx >= 8 ? 4 : barPx >= 4 ? 8 : 16;
      const first = Math.floor((from - dance.song.beatOffsetMs) / bar);
      for (let n = first; dance.song.beatOffsetMs + n * bar <= to; n++) {
        const t = dance.song.beatOffsetMs + n * bar, x = t * pxPerMs - left;
        if (n % every === 0) {
          g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(Math.round(x), 12, 1, RULER_HEIGHT - 12);
          if (n >= 0) g.fillText(String(n + 1), x + 3, 2);
        } else { g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillRect(Math.round(x), 18, 1, RULER_HEIGHT - 18); }
        if (barPx >= 60) for (let b = 1; b < 4; b++) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(Math.round(x + b * beat * pxPerMs), 20, 1, RULER_HEIGHT - 20); }
      }
    } else {
      const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000], step = steps.find(s => s * pxPerMs >= 56) ?? 60_000;
      for (let t = Math.floor(from / step) * step; t <= to; t += step) {
        const x = t * pxPerMs - left;
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(Math.round(x), 14, 1, RULER_HEIGHT - 14);
        g.fillText(clock(t, step < 1000), x + 3, 2);
      }
    }
    const c = w.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, visible, WAVE_HEIGHT);
    // The playable range is lit; what's trimmed off either end is dimmed.
    const playable = [dance.song.playableStartMs * pxPerMs - left, dance.song.playableEndMs * pxPerMs - left];
    if (peaks) {
      const mid = WAVE_HEIGHT / 2, per = peaks.length / durationMs;
      for (let x = 0; x < visible; x++) {
        const a = Math.floor(((x + left) / pxPerMs) * per), b = Math.max(a + 1, Math.floor(((x + 1 + left) / pxPerMs) * per));
        if (a >= peaks.length) break;
        let peak = 0;
        for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
        const h = Math.max(1, peak * (WAVE_HEIGHT - 6));
        c.fillStyle = x >= playable[0] && x <= playable[1] ? 'rgba(160,232,255,0.9)' : 'rgba(160,232,255,0.3)';
        c.fillRect(x, mid - h / 2, 1, h);
      }
    } else {
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.font = '500 11px Inter, sans-serif'; c.textBaseline = 'middle';
      c.fillText(transportState.hasAudio ? 'Reading the music…' : 'No music yet', 10, WAVE_HEIGHT / 2);
    }
  }, [pxPerMs, dance, peaks, durationMs, transportState.hasAudio]);
  useLayoutEffect(() => { draw(); }, [draw, width]);

  // The playhead follows the song every frame, and the pane turns the page to keep up with it.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = scroller.current, head = playhead.current;
      if (!el || !head) return;
      const x = Math.max(0, transport.timeMs()) * pxPerMs;
      head.style.transform = `translateX(${x}px)`;
      if (transport.state.playing && !dragging.current) {
        const visible = el.clientWidth - LABEL_WIDTH;
        if (x > el.scrollLeft + visible * 0.92 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - visible * 0.1);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [transport, pxPerMs]);

  // Ctrl/⌘-wheel zooms about the pointer (a native listener: React's wheel events are passive).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect(), x = e.clientX - rect.left - LABEL_WIDTH, at = (x + el.scrollLeft) / pxPerMs;
      const next = Math.max(fit, Math.min(2, pxPerMs * Math.exp(-e.deltaY * 0.0022)));
      setZoom(next <= fit * 1.001 ? null : next);
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, at * next - x); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pxPerMs, fit]);

  const dragging = useRef(false);
  /** Ruler and waveform: drag to move through the song; shift-drag to select a stretch. */
  const onScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // React clears the event's currentTarget once this handler returns: keep the element.
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragging.current = true;
    const start = api.toMs(e.clientX), selecting = e.shiftKey;
    const point = (ev: { clientX: number; altKey: boolean }) => { const t = api.toMs(ev.clientX); return ev.altKey ? t : api.snap(t, true); };
    const anchor = selecting ? point(e) : start;
    if (!selecting) transport.seek(start);
    const move = (ev: PointerEvent) => {
      if (selecting) { const t = point(ev); viewStore.set({ selection: Math.abs(t - anchor) < 1 ? null : [Math.min(anchor, t), Math.max(anchor, t)] }); }
      else transport.seek(api.toMs(ev.clientX));
    };
    const up = () => { dragging.current = false; el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const zoomBy = (k: number) => { const next = Math.max(fit, Math.min(2, pxPerMs * k)); setZoom(next <= fit * 1.001 ? null : next); };
  const selection = view.selection;
  return (
    <TimelineContext.Provider value={api}>
      <div className={`timeline ${className}`}>
        <div className="tl-scroll" ref={scroller} onScroll={draw}>
          <div className="tl-content" style={{ width: LABEL_WIDTH + contentWidth }}>
            <div className="tl-row tl-ruler">
              <div className="tl-label tl-zoom">
                <button className="icon" onClick={() => zoomBy(1 / 1.5)} disabled={zoom === null} aria-label="Zoom out" title="Zoom out">−</button>
                <button className="icon" onClick={() => setZoom(null)} disabled={zoom === null} title="Show the whole song">Fit</button>
                <button className="icon" onClick={() => zoomBy(1.5)} aria-label="Zoom in" title="Zoom in (or ctrl/⌘ + scroll)">+</button>
              </div>
              <div className="tl-track tl-scrub" onPointerDown={onScrub} title="Drag to move through the song · shift-drag to select a stretch">
                <canvas ref={ruler} className="tl-canvas" />
              </div>
            </div>
            <div className="tl-row tl-wave">
              <div className="tl-label">Music</div>
              <div className="tl-track tl-scrub" onPointerDown={onScrub}><canvas ref={wave} className="tl-canvas" /></div>
            </div>
            {sections && dance.phrases.length > 0 && (
              <div className="tl-row tl-sections">
                <div className="tl-label">Sections</div>
                <div className="tl-track">
                  {dance.phrases.map((p, i) => {
                    const active = selection && Math.abs(selection[0] - p.startMs) < 1 && Math.abs(selection[1] - p.endMs) < 1;
                    return (
                      <button key={p.id} className={`tl-section${active ? ' active' : ''}`} title={`${p.label}: ${clock(p.startMs)}–${clock(p.endMs)}. Click to select it`}
                        style={{ left: api.toX(p.startMs), width: Math.max(2, api.toX(p.endMs - p.startMs) - 1), '--hue': SECTION_HUES[hueIndex(dance.phrases, i) % SECTION_HUES.length] } as CSSProperties}
                        onClick={() => { viewStore.set({ selection: active ? null : [p.startMs, p.endMs] }); if (!active && !transport.state.playing) transport.seek(p.startMs); }}>
                        <span>{p.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {children}
            <div className="tl-overlay" style={{ left: LABEL_WIDTH, width: contentWidth }}>
              {selection && <div className="tl-selection" style={{ left: api.toX(selection[0]), width: api.toX(selection[1] - selection[0]) }} />}
              <div className="tl-playhead" ref={playhead} />
            </div>
          </div>
        </div>
      </div>
    </TimelineContext.Provider>
  );
}
/** Sections with the same label share a colour. */
function hueIndex(phrases: readonly { label: string }[], i: number): number {
  const labels = [...new Set(phrases.map(p => p.label.replace(/\s*\d+$/, '')))];
  return labels.indexOf(phrases[i].label.replace(/\s*\d+$/, ''));
}

export interface LaneProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Shown in the left gutter (it stays put as the song scrolls). */
  label: ReactNode;
  /** Controls beside the label (mute, pick a dancer). */
  aside?: ReactNode;
  height?: number;
  selected?: boolean;
  /** Called when the label is clicked. */
  onPick?: () => void;
  children?: ReactNode;
}
/** A row of the timeline. Its children are positioned in song time (see Span). */
export function Lane({ label, aside, height = 40, selected = false, onPick, children, className = '', ...rest }: LaneProps) {
  return (
    <div className={`tl-row tl-lane${selected ? ' selected' : ''} ${className}`} style={{ height }}>
      <div className={`tl-label${onPick ? ' pick' : ''}`} onClick={onPick}><span className="tl-label-text">{label}</span>{aside}</div>
      <div className="tl-track" {...rest}>{children}</div>
    </div>
  );
}
export interface SpanProps extends HTMLAttributes<HTMLDivElement> { start: number; end: number; }
/** A block from `start` to `end` (song ms) inside a Lane. */
export function Span({ start, end, style, ...rest }: SpanProps) {
  const { toX } = useTimeline();
  return <div {...rest} style={{ position: 'absolute', left: toX(start), width: Math.max(1, toX(end - start)), top: 0, bottom: 0, ...style }} />;
}
/** The time and bar under the playhead, e.g. "0:12.4 · bar 7.2". */
export function timeLabel(dance: Parameters<typeof barBeat>[0], ms: number): string {
  const bar = barBeat(dance, ms);
  return bar ? `${clock(ms)} · bar ${bar}` : clock(ms);
}
