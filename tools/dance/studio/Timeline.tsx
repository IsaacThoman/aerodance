// The timeline: a ruler with seconds, beats, markers and phrases; a row per dancer with every
// key time, its contacts and unscored spans; and, for the selected dancer, a row per channel.
//
//   click the ruler or a row      seek (drag to scrub); a row also selects its dancer/channel
//   click a key                   select it (shift adds); drag to retime; Delete removes it
//   double-click a channel row    key that channel's current value there
//   wheel                         scroll in time; ctrl/⌘ + wheel zooms around the pointer
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { keyTimes } from '../evaluate.ts';
import { CONTROLS, roundTime } from '../format.ts';
import type { AnyKey, Dance, Dancer } from '../format.ts';
import { channelNames } from '../ops.ts';
import type { SongClock } from './clock.ts';
import { DANCER_COLORS } from './skeleton.ts';
import type { Selection } from './VideoPane.tsx';

const GUTTER = 138, RULER = 34, DANCER_ROW = 28, CHANNEL_ROW = 17;
const CONTACT_TAGS: Record<string, string> = { leftAnkle: 'L foot', rightAnkle: 'R foot', leftWrist: 'L hand', rightWrist: 'R hand' };
export interface KeySelection { dancer: string; times: number[]; channel: string | null; layer: number; }
interface Row { kind: 'dancer' | 'channel'; dancer: Dancer; index: number; channel: string | null; layer: number; y: number; h: number; label: string; }

export interface TimelineProps {
  dance: Dance;
  clock: SongClock;
  selection: Selection;
  onSelect(selection: Selection): void;
  keys: KeySelection | null;
  onKeys(keys: KeySelection | null): void;
  onPreview(ops: unknown[] | null): void;
  onCommit(ops: unknown[], label: string): void;
}
export default function Timeline({ dance, clock, selection, onSelect, keys, onKeys, onPreview, onCommit }: TimelineProps) {
  const box = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState(() => ({ start: dance.song.playableStartMs - 200, msPerPx: Math.max(2, (dance.song.playableEndMs - dance.song.playableStartMs) / 900) }));
  const rows = useMemo(() => {
    const out: Row[] = [];
    let y = RULER;
    dance.dancers.forEach((dancer, index) => {
      out.push({ kind: 'dancer', dancer, index, channel: null, layer: 0, y, h: DANCER_ROW, label: `${dancer.id} ${dancer.label}` });
      y += DANCER_ROW;
      if (dancer.id !== selection.dancer) return;
      dancer.layers.forEach((layer, li) => {
        const names = channelNames(layer);
        if (li === 0 && selection.control && !names.includes(selection.control)) names.push(selection.control);
        names.sort((a, b) => CONTROLS.indexOf(a as never) - CONTROLS.indexOf(b as never));
        for (const name of names) {
          out.push({ kind: 'channel', dancer, index, channel: name, layer: li, y, h: CHANNEL_ROW, label: li ? `${layer.id}: ${name}` : name });
          y += CHANNEL_ROW;
        }
      });
    });
    return out;
  }, [dance, selection.dancer, selection.control]);
  const height = (rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : RULER) + 8;
  const drag = useRef<{ kind: 'seek' } | { kind: 'keys'; x: number; moved: boolean; base: KeySelection } | null>(null);
  const latest = useRef({ dance, rows, view, width, selection, keys, height });
  const dirty = useRef(true);
  latest.current = { dance, rows, view, width, selection, keys, height };
  const toX = (t: number, v = view) => GUTTER + (t - v.start) / v.msPerPx;
  const toT = (x: number, v = view) => v.start + (x - GUTTER) * v.msPerPx;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let frame = 0, last = '';
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const { dance, rows, view, width, selection, keys, height } = latest.current, t = clock.now();
      // Keep the playhead in view while playing.
      if (clock.playing) {
        const x = GUTTER + (t - view.start) / view.msPerPx;
        if (x > width - 40 || x < GUTTER) { setView(v => ({ ...v, start: t - (width - GUTTER) * 0.15 * v.msPerPx })); return; }
      }
      const stamp = `${t}|${width}|${height}|${view.start}|${view.msPerPx}`;
      if (stamp === last && !dirty.current) return;
      last = stamp;
      dirty.current = false;
      const c = canvas.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) { c.width = Math.round(width * dpr); c.height = Math.round(height * dpr); }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(g, { dance, rows, view, width, height, selection, keys, t });
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [clock]);
  useEffect(() => { dirty.current = true; }, [dance, rows, selection, keys]);

  // Where a key's diamond is on the page, for scripted tests and tools.
  useEffect(() => {
    const w = window as unknown as { danceTimeline?: { keyOnPage(dancer: string, channel: string | null, t: number): { x: number; y: number } | null } };
    w.danceTimeline = {
      keyOnPage(dancerId, channel, t) {
        const { rows, view } = latest.current, c = canvas.current;
        const row = rows.find(r => r.dancer.id === dancerId && (channel ? r.channel === channel && r.layer === 0 : r.kind === 'dancer'));
        if (!row || !c) return null;
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.left + GUTTER + (t + row.dancer.timeOffsetMs - view.start) / view.msPerPx), y: Math.round(r.top + row.y + row.h / 2) };
      },
    };
    return () => { delete w.danceTimeline; };
  }, []);
  const local = (e: ReactPointerEvent | React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const rowAt = (y: number) => rows.find(r => y >= r.y && y < r.y + r.h) ?? null;
  const keyAt = (row: Row, x: number): number | null => {
    const times = row.kind === 'dancer' ? keyTimes(row.dancer) : (row.dancer.layers[row.layer].channels[row.channel!] ?? []).map(k => k.t);
    let best: number | null = null, bestD = 7;
    for (const k of times) { const d = Math.abs(toX(k + row.dancer.timeOffsetMs) - x); if (d < bestD) { bestD = d; best = k; } }
    return best;
  };
  const retimeOps = (sel: KeySelection, shift: number) => {
    const dancer = dance.dancers.find(d => d.id === sel.dancer)!;
    const ordered = [...sel.times].sort((a, b) => shift > 0 ? b - a : a - b);
    return ordered.map(t => ({ op: 'retime', dancer: dancer.id, range: [t - 0.4, t + 0.4], shift,
      ...(sel.channel ? { controls: [sel.channel] } : {}) }));
  };
  return (
    <div className="timeline" ref={box}>
      <canvas ref={canvas} style={{ width, height }} aria-label="Timeline"
        onPointerDown={e => {
          const p = local(e);
          e.currentTarget.setPointerCapture(e.pointerId);
          const row = p.y >= RULER ? rowAt(p.y) : null;
          if (row && p.x > GUTTER) {
            const k = keyAt(row, p.x);
            if (k !== null) {
              const channel = row.kind === 'channel' ? row.channel : null;
              const same = keys && keys.dancer === row.dancer.id && keys.channel === channel && keys.layer === row.layer;
              const times = e.shiftKey && same ? [...new Set([...keys.times, k])] : same && keys.times.includes(k) ? keys.times : [k];
              const next = { dancer: row.dancer.id, times, channel, layer: row.layer };
              onKeys(next);
              onSelect({ dancer: row.dancer.id, control: (channel && (CONTROLS as readonly string[]).includes(channel) ? channel : selection.control) as Selection['control'] });
              if (row.layer === 0) drag.current = { kind: 'keys', x: p.x, moved: false, base: next };
              clock.seek(k + row.dancer.timeOffsetMs);
              return;
            }
          }
          if (row) onSelect({ dancer: row.dancer.id, control: row.kind === 'channel' && (CONTROLS as readonly string[]).includes(row.channel!) ? row.channel as Selection['control'] : row.kind === 'dancer' ? selection.control : selection.control });
          onKeys(null);
          if (p.x > GUTTER) { clock.pause(); clock.seek(Math.max(0, toT(p.x))); drag.current = { kind: 'seek' }; }
        }}
        onPointerMove={e => {
          const d = drag.current, p = local(e);
          if (!d) return;
          if (d.kind === 'seek') { clock.seek(Math.max(0, toT(p.x))); return; }
          const shift = roundTime((p.x - d.x) * view.msPerPx);
          if (Math.abs(p.x - d.x) < 3 && !d.moved) return;
          d.moved = true;
          onPreview(retimeOps(d.base, shift));
        }}
        onPointerUp={e => {
          const d = drag.current, p = local(e);
          drag.current = null;
          if (!d || d.kind !== 'keys' || !d.moved) return;
          const shift = roundTime((p.x - d.x) * view.msPerPx);
          if (!shift) { onPreview(null); return; }
          onCommit(retimeOps(d.base, shift), 'retime keys');
          onKeys({ ...d.base, times: d.base.times.map(t => roundTime(t + shift)) });
        }}
        onDoubleClick={e => {
          const p = local(e), row = rowAt(p.y);
          if (!row || row.kind !== 'channel' || row.layer !== 0 || p.x <= GUTTER) return;
          const t = roundTime(toT(p.x) - row.dancer.timeOffsetMs);
          onCommit([{ op: 'pose', dancer: row.dancer.id, t, controls: [row.channel] }], `key ${row.channel}`);
        }}
        onWheel={e => {
          const p = local(e);
          if (e.ctrlKey || e.metaKey) {
            const at = toT(p.x), msPerPx = Math.min(200, Math.max(0.25, view.msPerPx * Math.exp(e.deltaY * 0.004)));
            setView({ msPerPx, start: at - (p.x - GUTTER) * msPerPx });
          } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
            setView(v => ({ ...v, start: v.start + (e.deltaX || e.deltaY) * v.msPerPx }));
          }
        }} />
    </div>
  );
}

// ---- Painting ----

interface Paint { dance: Dance; rows: Row[]; view: { start: number; msPerPx: number }; width: number; height: number; selection: Selection; keys: KeySelection | null; t: number; }
function niceStep(msPerPx: number) {
  for (const step of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000]) if (step / msPerPx >= 70) return step;
  return 120000;
}
function paint(g: CanvasRenderingContext2D, { dance, rows, view, width, height, selection, keys, t }: Paint) {
  const toX = (ms: number) => GUTTER + (ms - view.start) / view.msPerPx;
  g.clearRect(0, 0, width, height);
  g.fillStyle = '#0f252c'; g.fillRect(0, 0, width, height);
  // Outside the playable range.
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(GUTTER, 0, Math.max(0, toX(dance.song.playableStartMs) - GUTTER), height);
  g.fillRect(Math.max(GUTTER, toX(dance.song.playableEndMs)), 0, width, height);
  // Beats and bars.
  const { bpm, beatOffsetMs } = dance.song;
  g.font = '600 10px Nunito, sans-serif';
  if (bpm) {
    const beatMs = 60000 / bpm, every = beatMs / view.msPerPx < 6 ? 4 : 1;
    const first = Math.ceil((view.start - beatOffsetMs) / beatMs);
    for (let n = first; ; n += 1) {
      const ms = beatOffsetMs + n * beatMs, x = toX(ms);
      if (x > width) break;
      if (x < GUTTER || n % every) continue;
      const bar = n % 4 === 0;
      g.fillStyle = bar ? 'rgba(180,233,193,0.16)' : 'rgba(180,233,193,0.07)';
      g.fillRect(x, RULER - 12, 1, height);
      if (bar && 4 * beatMs / view.msPerPx > 26) { g.fillStyle = '#9fd3b0'; g.fillText(`b${n + 1}`, x + 3, RULER - 3); }
    }
  }
  // Seconds.
  const step = niceStep(view.msPerPx);
  g.fillStyle = '#9fb9bd'; g.font = '600 10px Nunito, sans-serif';
  for (let ms = Math.ceil(view.start / step) * step; toX(ms) < width; ms += step) {
    const x = toX(ms);
    if (x < GUTTER) continue;
    g.fillStyle = 'rgba(160,200,210,0.22)'; g.fillRect(x, 0, 1, RULER);
    g.fillStyle = '#a6c3c7'; g.fillText(step < 1000 ? `${(ms / 1000).toFixed(step < 100 ? 2 : 1)}s` : `${Math.round(ms / 1000)}s`, x + 3, 11);
  }
  // Phrases and markers.
  for (const p of dance.phrases) {
    const a = Math.max(GUTTER, toX(p.startMs)), b = Math.min(width, toX(p.endMs));
    if (b <= a) continue;
    g.fillStyle = 'rgba(190,156,255,0.22)'; g.fillRect(a, 13, b - a, 8);
    g.fillStyle = '#d9c8ff'; g.fillText(p.label, a + 3, 20);
  }
  for (const m of dance.markers) {
    const x = toX(m.timeMs);
    if (x < GUTTER || x > width) continue;
    g.fillStyle = m.kind === 'phrase' ? '#d9c8ff' : m.kind === 'beat' ? '#b4e9c1' : '#ffd38a';
    g.beginPath(); g.moveTo(x - 4, 22); g.lineTo(x + 4, 22); g.lineTo(x, 28); g.fill();
  }
  g.fillStyle = '#15323a'; g.fillRect(0, 0, GUTTER, height);
  g.fillStyle = '#7f9ea3'; g.fillText(dance.song.bpm ? `${dance.song.bpm} bpm` : 'no bpm', 10, 20);
  // Rows.
  for (const row of rows) {
    const color = DANCER_COLORS[row.index % DANCER_COLORS.length];
    const selectedRow = row.dancer.id === selection.dancer && (row.kind === 'dancer' ? !selection.control : row.channel === selection.control);
    g.fillStyle = row.kind === 'dancer' ? '#163a44' : selectedRow ? '#1d4955' : '#122f37';
    g.fillRect(0, row.y, width, row.h - 1);
    if (selectedRow) { g.fillStyle = 'rgba(81,218,240,0.10)'; g.fillRect(GUTTER, row.y, width, row.h - 1); }
    g.fillStyle = row.kind === 'dancer' ? color : selectedRow ? '#e6fbff' : '#a9c2c6';
    g.font = row.kind === 'dancer' ? '700 12px Nunito, sans-serif' : '600 11px Nunito, sans-serif';
    g.fillText(row.label, row.kind === 'dancer' ? 10 : 22, row.y + row.h / 2 + 4, GUTTER - 26);
    const off = row.dancer.timeOffsetMs;
    if (row.kind === 'dancer') {
      for (const x of row.dancer.exclusions) {
        const a = Math.max(GUTTER, toX(x.startMs + off)), b = Math.min(width, toX(x.endMs + off));
        if (b <= a) continue;
        g.fillStyle = 'rgba(255,120,120,0.16)'; g.fillRect(a, row.y, b - a, row.h - 1);
      }
      row.dancer.contacts.forEach(c => {
        const a = Math.max(GUTTER, toX(c.startMs + off)), b = Math.min(width, toX(c.endMs + off));
        if (b <= a) return;
        const lane = ['leftAnkle', 'rightAnkle', 'leftWrist', 'rightWrist'].indexOf(c.control);
        g.fillStyle = lane % 2 ? 'rgba(255,211,138,0.55)' : 'rgba(180,233,193,0.55)';
        g.fillRect(a, row.y + row.h - 6 - (lane > 1 ? 4 : 0), b - a, 3);
        if (b - a > 40) { g.fillStyle = '#f5e6c8'; g.font = '600 9px Nunito, sans-serif'; g.fillText(CONTACT_TAGS[c.control], a + 2, row.y + 9); }
      });
      const times = keyTimes(row.dancer);
      const selected = keys && keys.dancer === row.dancer.id && !keys.channel ? keys.times : [];
      for (const k of times) diamond(g, toX(k + off), row.y + row.h / 2 - 1, 5, color, selected.includes(k) ? 'selected' : 'auto', 'smooth');
    } else {
      const list: AnyKey[] = row.dancer.layers[row.layer].channels[row.channel!] ?? [];
      const selected = keys && keys.dancer === row.dancer.id && keys.channel === row.channel && keys.layer === row.layer ? keys.times : [];
      // The segments between keys: a line, dashed where held.
      for (let i = 0; i + 1 < list.length; i++) {
        const a = toX(list[i].t + off), b = toX(list[i + 1].t + off);
        if (b < GUTTER || a > width) continue;
        g.strokeStyle = list[i].interp === 'hold' ? 'rgba(255,211,138,0.55)' : list[i].interp === 'linear' ? 'rgba(200,220,230,0.45)' : 'rgba(81,218,240,0.35)';
        g.setLineDash(list[i].interp === 'hold' ? [3, 3] : []);
        g.beginPath(); g.moveTo(Math.max(GUTTER, a), row.y + row.h / 2); g.lineTo(Math.min(width, b), row.y + row.h / 2); g.stroke();
        g.setLineDash([]);
      }
      for (const k of list) diamond(g, toX(k.t + off), row.y + row.h / 2, 4.2, row.layer ? '#ffd38a' : color, selected.includes(k.t) ? 'selected' : k.ease ?? 'auto', k.interp ?? 'smooth');
    }
  }
  // Playhead.
  const x = toX(t);
  if (x >= GUTTER && x <= width) {
    g.fillStyle = '#ffffff'; g.fillRect(x - 0.5, 0, 1.5, height);
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 6, 0); g.lineTo(x + 0.5, 7); g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(GUTTER - 1, 0, 1, height);
}
function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, ease: string, interp: string) {
  if (x < GUTTER - r || x > g.canvas.width) return;
  g.beginPath();
  if (interp === 'hold') g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
  else if (interp === 'linear') { g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.8); g.lineTo(x - r, y + r * 0.8); g.closePath(); }
  else { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
  g.fillStyle = ease === 'selected' ? '#ffffff' : ease === 'sharp' ? '#ff9a7a' : ease === 'stop' ? '#b4e9c1' : color;
  g.fill();
  g.strokeStyle = ease === 'selected' ? color : 'rgba(0,12,20,0.8)'; g.lineWidth = ease === 'selected' ? 2 : 1; g.stroke();
}
