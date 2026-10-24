// Dance Studio: animate dancers to a video, in the same project the `dance` CLI edits.
//
// The video with every dancer's skeleton (drag joints to key them), the dancers in-engine (as
// filmed, or exactly as the game shows them on the song's stage), a timeline of keys, contacts
// and beats, and panels for the selected dancer and control, the song, and review. Every edit
// is an op saved to dance.json; edits from the CLI show up here as they happen.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CONTROLS, roundTime } from '../format.ts';
import type { Control, Dance } from '../format.ts';
import { keyTimes } from '../evaluate.ts';
import type { TrackingData } from '../tracking.ts';
import { beatAt, parseTime } from '../time.ts';
import { SongClock } from './clock.ts';
import { fetchTracking } from './data.ts';
import { ContactsPanel, ControlPanel, DancerPanel, LayersPanel, SongPanel, controlLabel } from './Inspector.tsx';
import Review from './Review.tsx';
import StagePane from './StagePane.tsx';
import type { StageMode } from './StagePane.tsx';
import Timeline from './Timeline.tsx';
import type { KeySelection } from './Timeline.tsx';
import { useDance } from './useDance.ts';
import VideoPane from './VideoPane.tsx';
import type { Selection } from './VideoPane.tsx';
import { DANCER_COLORS } from './skeleton.ts';

type Tab = 'edit' | 'song' | 'review';
function useClockTime(clock: SongClock) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    let frame = 0, last = -1;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = clock.now();
      // A few updates a second while playing; every change while paused.
      if (Math.abs(t - last) > (clock.playing ? 100 : 0.01)) { last = t; setTime(t); }
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [clock]);
  return time;
}
function useTracking(dance: Dance | null) {
  const [tracking, setTracking] = useState(new Map<string, { data: TrackingData; slot: number }>());
  const key = dance ? dance.sources.tracking.map(t => `${t.sha256}:${t.dancers.join(',')}`).join('|') : '';
  useEffect(() => {
    if (!dance) return;
    let live = true;
    (async () => {
      const next = new Map<string, { data: TrackingData; slot: number }>();
      for (const source of dance.sources.tracking) for (const [slot, id] of source.dancers.entries())
        if (id && !next.has(id)) next.set(id, { data: await fetchTracking(dance, source.id), slot });
      if (live) setTracking(next);
    })().catch(() => {});
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return tracking;
}

export default function App() {
  const store = useDance();
  const { dance } = store;
  const [clock] = useState(() => new SongClock());
  const time = useClockTime(clock);
  const [selection, setSelection] = useState<Selection>({ dancer: 'P1', control: null });
  const [keys, setKeys] = useState<KeySelection | null>(null);
  const [tab, setTab] = useState<Tab>('edit');
  const [mode, setMode] = useState<StageMode>('character');
  const [mirror, setMirror] = useState(false);
  const [showReference, setShowReference] = useState(true);
  const [showGhosts, setShowGhosts] = useState(false);
  const [solo, setSolo] = useState(false);
  const [rate, setRate] = useState(1);
  const [, rerender] = useState(0);
  const tracking = useTracking(dance);
  const audioSha = dance?.sources.audio?.sha256;
  useEffect(() => { clock.attach(audioSha ? `/api/media/audio?v=${audioSha.slice(0, 12)}` : null); }, [clock, audioSha]);
  useEffect(() => { if (dance) clock.durationMs = dance.song.durationMs; }, [clock, dance]);
  // ?t=b23&control=leftWrist opens at a moment (any time form), e.g. from a finding or a note.
  const opened = dance !== null;
  useEffect(() => {
    if (!opened) return;
    const params = new URLSearchParams(location.search);
    const at = params.get('t'), control = params.get('control'), who = params.get('dancer');
    try { if (at) clock.seek(parseTime(at, store.saved ?? undefined)); } catch { /* not a time: ignore it */ }
    if (who || control) setSelection(s => ({ dancer: who ?? s.dancer, control: (control && (CONTROLS as readonly string[]).includes(control) ? control : s.control) as Selection['control'] }));
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => clock.subscribe(() => rerender(n => n + 1)), [clock]);
  useEffect(() => {
    if (dance && !dance.dancers.some(d => d.id === selection.dancer)) setSelection({ dancer: dance.dancers[0].id, control: null });
  }, [dance, selection.dancer]);
  const apply = useCallback((ops: unknown[], label: string) => { void store.apply(ops, label); }, [store]);
  const dancer = dance?.dancers.find(d => d.id === selection.dancer) ?? dance?.dancers[0];
  const frameMs = 1000 / (dance?.sources.video?.fps ?? 30);
  const beatMs = dance?.song.bpm ? 60000 / dance.song.bpm : 500;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea')) return;
      if (!dance || !dancer) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === ' ') { e.preventDefault(); clock.toggle(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); clock.pause();
        // Step to the next whole video frame (or beat), so keys line up with what the video shows.
        const step = e.shiftKey ? beatMs : frameMs, base = e.shiftKey && dance.song.bpm ? dance.song.beatOffsetMs : 0;
        // Times are kept to 0.1 ms, so a frame boundary may sit a hair either side of where it is.
        const k = (clock.now() - base) / step;
        clock.seek(roundTime(base + (e.key === 'ArrowLeft' ? Math.ceil(k - 1 - 0.01) : Math.floor(k + 1 + 0.01)) * step));
      } else if (e.key === ',' || e.key === '.') {
        const times = keyTimes(dancer).map(t => t + dancer.timeOffsetMs), now = clock.now();
        const target = e.key === ',' ? [...times].reverse().find(t => t < now - 0.5) : times.find(t => t > now + 0.5);
        if (target !== undefined) { clock.pause(); clock.seek(target); }
      } else if (e.key === 'k' && !mod) apply([{ op: 'pose', dancer: dancer.id, t: roundTime(clock.now() - dancer.timeOffsetMs) }], 'key pose');
      else if ((e.key === 'Delete' || e.key === 'Backspace') && keys) {
        e.preventDefault();
        apply([{ op: 'delete', dancer: keys.dancer, layer: dance.dancers.find(d => d.id === keys.dancer)?.layers[keys.layer].id, times: keys.times,
          ...(keys.channel ? { controls: [keys.channel] } : {}) }], 'delete keys');
        setKeys(null);
      } else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? store.redo() : store.undo()); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); void store.redo(); }
      else if (/^[1-4]$/.test(e.key) && !mod) { const d = dance.dancers[Number(e.key) - 1]; if (d) setSelection({ dancer: d.id, control: selection.control }); }
      else if (e.key === 'g' && !mod) setMode(m => m === 'game' ? 'character' : 'game');
      else if (e.key === 'm' && !mod) setMirror(m => !m);
      else if (e.key === 'Escape') { setKeys(null); setSelection(s => ({ ...s, control: null })); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dance, dancer, keys, clock, apply, store, selection.control, frameMs, beatMs]);

  const focus = useMemo(() => solo && dance ? dance.dancers.findIndex(d => d.id === selection.dancer) : null, [solo, dance, selection.dancer]);
  if (!dance || !dancer) {
    return <div className="loading">{store.error ? <p className="error">{store.error}</p> : <p>Opening the dance…</p>}</div>;
  }
  const beat = beatAt(dance, time);
  return (
    <div className="studio" data-revision={dance.revision} data-saved-revision={store.saved?.revision ?? ''} data-busy={store.busy}
      data-playing={clock.playing} data-time={Math.round(time)} data-dancer={selection.dancer} data-control={selection.control ?? ''} data-mode={mode}>
      <header className="topbar">
        <div className="brand"><span className="brand-orb" /><div>aerodance<strong>Dance Studio</strong></div></div>
        <div className="song-title"><strong>{dance.song.title || 'Untitled dance'}</strong><span>{dance.song.artist || 'No artist'} · {dance.dancers.length} dancer{dance.dancers.length > 1 ? 's' : ''}</span></div>
        <div className="header-actions">
          <span className={`save-state ${store.error ? 'error' : store.busy ? 'busy' : ''}`} aria-live="polite">
            {store.error ? 'Not saved' : store.busy ? 'Saving…' : `Saved · revision ${dance.revision}`}</span>
          <button onClick={() => void store.undo()} disabled={!store.history.undo.length || store.busy} title={store.history.undo.length ? `Undo ${store.history.undo[store.history.undo.length - 1].label} (⌘Z)` : 'Nothing to undo'}>Undo</button>
          <button onClick={() => void store.redo()} disabled={!store.history.redo.length || store.busy} title="Redo (⇧⌘Z)">Redo</button>
        </div>
      </header>
      {(store.error || store.notice) && (
        <div className={`message ${store.error ? 'error' : ''}`} role={store.error ? 'alert' : 'status'}>
          <span>{store.error || store.notice}</span>
          <button className="link" onClick={() => { store.setError(''); store.setNotice(''); }} aria-label="Dismiss">×</button>
        </div>
      )}
      <div className="workspace">
        <main className="editor">
          <div className="panes">
            <section className="pane">
              <header className="pane-head">
                <h2>{dance.sources.video ? 'Video' : 'Skeleton'}</h2>
                <div className="toggles">
                  <label><input type="checkbox" checked={showReference} onChange={e => setShowReference(e.target.checked)} disabled={!tracking.size} /> Tracked</label>
                  <label><input type="checkbox" checked={showGhosts} onChange={e => setShowGhosts(e.target.checked)} /> Neighbouring keys</label>
                  <label><input type="checkbox" checked={solo} onChange={e => setSolo(e.target.checked)} /> Only {selection.dancer}</label>
                </div>
              </header>
              <VideoPane dance={dance} clock={clock} selection={selection} onSelect={s => { setSelection(s); setKeys(null); }}
                onPreview={store.preview} onCommit={apply} tracking={tracking} showReference={showReference} showGhosts={showGhosts} soloSelected={solo} />
            </section>
            <section className="pane">
              <header className="pane-head">
                <h2>{mode === 'game' ? 'Game' : 'Characters'}</h2>
                <div className="segmented" role="group" aria-label="3D view">
                  <button aria-pressed={mode === 'character'} onClick={() => setMode('character')}>Characters</button>
                  <button aria-pressed={mode === 'game'} onClick={() => setMode('game')}>Game</button>
                </div>
                {mode === 'character' && <label className="toggles"><input type="checkbox" checked={mirror} onChange={e => setMirror(e.target.checked)} /> Mirror</label>}
              </header>
              <StagePane dance={dance} clock={clock} mode={mode} mirror={mirror} focus={focus} />
            </section>
          </div>
          <div className="transport">
            <button className="play" onClick={() => clock.toggle()} aria-label={clock.playing ? 'Pause' : 'Play'}>{clock.playing ? '❚❚' : '▶'}</button>
            <span className="time" aria-label="Playhead">{(time / 1000).toFixed(3)} s{beat !== null && <small> · beat {beat.toFixed(2)}</small>}</span>
            <label className="rate">Speed <select value={rate} aria-label="Playback speed" onChange={e => { const r = Number(e.target.value); setRate(r); clock.setRate(r); }}>
              {[0.25, 0.5, 0.75, 1].map(r => <option key={r} value={r}>{r}×</option>)}</select></label>
            <span className="hint">Space play · ←/→ frame · ⇧←/→ beat · ,/. keys · K key pose · drag a joint to key it</span>
            <span className="dancer-chips">{dance.dancers.map((d, i) => (
              <button key={d.id} className={`chip ${d.id === selection.dancer ? 'active' : ''}`} style={{ '--chip': DANCER_COLORS[i] } as React.CSSProperties}
                onClick={() => setSelection({ dancer: d.id, control: selection.control })}>{d.id}</button>))}</span>
          </div>
          <Timeline dance={dance} clock={clock} selection={selection} onSelect={setSelection} keys={keys} onKeys={setKeys} onPreview={store.preview} onCommit={apply} />
        </main>
        <aside className="sidebar">
          <nav className="tabs" role="tablist">
            {(['edit', 'song', 'review'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'edit' ? 'Animate' : t === 'song' ? 'Song' : 'Review'}</button>)}
          </nav>
          <div className="sidebar-body">
            {tab === 'edit' && <>
              <DancerPanel dance={dance} dancer={dancer} clock={clock} time={time} selection={selection} onSelect={setSelection} apply={apply} hasTracking={tracking.has(dancer.id)} />
              {selection.control && (CONTROLS as readonly string[]).includes(selection.control) &&
                <ControlPanel dance={dance} dancer={dancer} control={selection.control as Control} time={time} apply={apply} />}
              <ContactsPanel dancer={dancer} time={time} selection={selection} apply={apply} />
              <LayersPanel dancer={dancer} apply={apply} />
            </>}
            {tab === 'song' && <SongPanel dance={dance} apply={apply} />}
            {tab === 'review' && <Review dance={dance} onSeek={ms => { clock.pause(); clock.seek(ms); }} onSelect={s => { setSelection(s); setTab('edit'); }} />}
          </div>
          <footer className="sidebar-foot">{selection.control ? `${selection.dancer} · ${controlLabel(selection.control as Control)}` : selection.dancer}</footer>
        </aside>
      </div>
    </div>
  );
}
