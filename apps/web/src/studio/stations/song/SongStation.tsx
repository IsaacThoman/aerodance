// Station 1, the song: its music, its beat, its sections, who dances and where. Everything the
// later stations count in (bars to snap to, sections to record) is set here, found from the
// music where it can be and corrected by ear where it can't.
import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGE_LIST } from '../../../../../../packages/stages/catalog.ts';
import { barBeat, barStart, clock } from '../../core/format.ts';
import { useKeys, useProject, useSession, useTransport } from '../../core/hooks.ts';
import { StationLayout } from '../../core/StationLayout.tsx';
import { Timeline } from '../../core/Timeline.tsx';
import { TransportBar } from '../../core/TransportBar.tsx';
import { Button, Dialog, Field, FileButton, Note, Panel, Segmented } from '../../core/ui.tsx';
import Viewport from '../../core/Viewport.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { analyze, sectionOps } from './analyze.ts';

const DANCER_WORDS = ['', 'Solo', 'Duet', 'Trio', 'Crew'];
const round = (v: number, step = 0.01) => Math.round(v / step) * step;

export default function SongStation() {
  const session = useSession(), { dance, shown } = useProject(), transport = useTransport(), view = useView(), viewStore = useViewStore();
  const { song } = dance;
  const apply = useCallback((ops: unknown[], label: string) => session.apply(ops, label), [session]);
  const set = (fields: Record<string, unknown>, label: string) => apply([{ op: 'song', set: fields }], label);

  // ---- The beat, found from the music the first time it's loaded without one ----
  const [finding, setFinding] = useState(false), [found, setFound] = useState<{ bpm: number; confidence: number } | null>(null);
  const analysed = useRef<string | null>(null);
  const findBeat = useCallback(async (sections: 'if-none' | 'replace' | 'keep') => {
    const { pcm, sampleRate } = session.transport;
    if (!pcm) return;
    setFinding(true);
    try {
      const { grid, sections: guesses } = await analyze(pcm, sampleRate, session.transport.state.durationMs);
      const now = session.state.dance, ops: unknown[] = [];
      if (grid) ops.push({ op: 'song', set: { bpm: grid.bpm, beatOffsetMs: grid.beatOffsetMs } });
      if (guesses.length && (sections === 'replace' || sections === 'if-none' && !now.phrases.length)) ops.push(...sectionOps(now.phrases, guesses));
      if (ops.length) await session.apply(ops, grid ? 'find the beat' : 'find the sections');
      setFound(grid ? { bpm: grid.bpm, confidence: grid.confidence } : { bpm: 0, confidence: 0 });
    } catch (e) { session.fail(e instanceof Error ? e.message : String(e)); }
    finally { setFinding(false); }
  }, [session]);
  const audioHash = dance.sources.audio?.sha256 ?? null;
  useEffect(() => {
    if (!audioHash || !transport.ready || !session.transport.pcm || analysed.current === audioHash) return;
    analysed.current = audioHash;
    if (session.state.dance.song.bpm === null) void findBeat('if-none');
  }, [audioHash, transport.ready, session, findBeat]);

  // ---- Tap along: the tempo and the count from taps on T while the music plays ----
  const taps = useRef<number[]>([]);
  const [tapCount, setTapCount] = useState(0);
  const tap = useCallback((perfMs: number) => {
    const t = session.transport.songTimeAt(perfMs), list = taps.current;
    if (list.length && t - list[list.length - 1] > 2500) list.length = 0;
    list.push(t);
    setTapCount(list.length);
    if (list.length < 5) return;
    // The line through the taps: its slope is the beat, and it puts a beat on the first tap.
    const n = list.length, mean = (n - 1) / 2, tMean = list.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    list.forEach((v, i) => { num += (i - mean) * (v - tMean); den += (i - mean) ** 2; });
    const beat = num / den;
    if (!(beat > 250 && beat < 1500)) return;
    const first = tMean - mean * beat, bar = beat * 4;
    void apply([{ op: 'song', set: { bpm: round(60000 / beat, 0.5), beatOffsetMs: Math.round(((first % bar) + bar) % bar) } }], 'tap the tempo');
  }, [session, apply]);
  useKeys(e => { if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); tap(e.timeStamp); } });

  const beat = song.bpm ? 60000 / song.bpm : null;
  const shiftCount = (ms: number) => { const bar = beat! * 4; void set({ beatOffsetMs: Math.round(((((song.beatOffsetMs + ms) % bar) + bar) % bar) * 10) / 10 }, 'move the count'); };
  const [bpmText, setBpmText] = useState<string | null>(null);

  // ---- Dancers ----
  const [dropping, setDropping] = useState<number | null>(null);
  const setDancers = (count: number) => {
    const now = dance.dancers.length;
    if (count === now) return;
    const going = dance.dancers.slice(count);
    if (count < now && dropping === null && going.some(d => d.clips.length || Object.keys(d.layers[0].channels).length)) { setDropping(count); return; }
    const ops: unknown[] = count > now ? Array.from({ length: count - now }, () => ({ op: 'dancer', action: 'add' }))
      : going.map(d => ({ op: 'dancer', action: 'remove', dancer: d.id })).reverse();
    // Dancers nobody has danced yet stand evenly across the picture.
    const ids = count > now ? [...dance.dancers.map(d => d.id), ...Array.from({ length: count - now }, (_, i) => `P${now + i + 1}`)] : dance.dancers.slice(0, count).map(d => d.id);
    ids.forEach((id, i) => {
      const d = dance.dancers.find(x => x.id === id);
      if (!d || !d.clips.length && !Object.keys(d.layers[0].channels).length) ops.push({ op: 'dancer', dancer: id, home: [Math.round((i + 0.5) / count * 1e4) / 1e4, 0.5] });
    });
    setDropping(null);
    if (view.dancer >= count) viewStore.set({ dancer: count - 1 });
    void apply(ops, count > now ? 'add a dancer' : 'remove a dancer');
  };

  // ---- Sections ----
  const splitHere = () => {
    const t = beat ? barStart(dance, session.transport.timeMs() + beat * 2) : Math.round(session.transport.timeMs());
    const inside = dance.phrases.find(p => t > p.startMs + 500 && t < p.endMs - 500);
    if (inside) return void apply([{ op: 'phrase', action: 'update', id: inside.id, end: t }, { op: 'phrase', label: inside.label, start: t, end: inside.endMs }], 'split the section');
    // At a section's edge there is nothing to split.
    if (dance.phrases.some(p => t >= p.startMs && t < p.endMs)) return;
    // Outside every section: a new one from here to the next section (or the end of the song).
    const next = dance.phrases.find(p => p.startMs > t), end = next?.startMs ?? song.durationMs;
    if (end - t > 500) void apply([{ op: 'phrase', label: `Part ${String.fromCharCode(65 + dance.phrases.length % 26)}`, start: t, end }], 'add a section');
  };
  const selection = view.selection;
  const wholeSong = song.playableStartMs === 0 && Math.abs(song.playableEndMs - song.durationMs) < 1;
  const musicName = dance.sources.audio ? `${dance.sources.audio.mimeType === 'audio/ogg' ? 'OGG' : 'MP3'} · ${clock(dance.sources.audio.durationMs, false)}` : null;

  return (
    <>
      <StationLayout
        stage={
          <Viewport view={view.look} mirror={view.mirror} focus={null}>
            <div className="viewport-tools">
              <Segmented label="Coach view" value={view.look} onChange={look => viewStore.set({ look })}
                options={[{ value: 'floor', label: 'Practice floor' }, { value: 'stage', label: 'The stage', title: 'The song\'s stage, as the game shows it' }]} />
            </div>
          </Viewport>
        }
        side={
          <>
            <Panel title="Music" aside={musicName && <span className="muted">{musicName}</span>}>
              {!dance.sources.audio ? (
                <div className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void session.attachAudio(file); }}>
                  <p>Start with the song: an <strong>MP3</strong> or <strong>OGG</strong> file.</p>
                  <FileButton kind="primary" big icon="music" accept=".mp3,.ogg,audio/mpeg,audio/ogg" onFile={file => void session.attachAudio(file)}>Choose the music</FileButton>
                  <small className="muted">or drop it here. It stays in this browser.</small>
                </div>
              ) : (
                <>
                  {finding && <Note>Listening for the beat…</Note>}
                  {!finding && found && found.bpm > 0 && <Note kind={found.confidence >= 0.35 ? 'good' : 'warning'}>
                    {found.confidence >= 0.35 ? `Found the beat: ${found.bpm} BPM.` : `Best guess: ${found.bpm} BPM, but the beat wasn't clear.`} Turn the click on and play to check it lands on the beat.
                  </Note>}
                  {!finding && found && found.bpm === 0 && <Note kind="warning">No steady beat stood out. Tap along below to set it.</Note>}
                  <div className="beat-row">
                    <Field label="Tempo (BPM)">
                      <input type="number" inputMode="decimal" min={40} max={240} step={0.5} placeholder="—" value={bpmText ?? song.bpm ?? ''}
                        onChange={e => setBpmText(e.target.value)}
                        onBlur={() => { const v = Number(bpmText); if (bpmText !== null && v >= 40 && v <= 240 && v !== song.bpm) void set({ bpm: round(v) }, 'set the tempo'); setBpmText(null); }}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                    </Field>
                    <Button disabled={!song.bpm || song.bpm < 80} title="Half the tempo" onClick={() => void set({ bpm: round(song.bpm! / 2) }, 'halve the tempo')}>½×</Button>
                    <Button disabled={!song.bpm || song.bpm > 120} title="Double the tempo" onClick={() => void set({ bpm: round(song.bpm! * 2) }, 'double the tempo')}>2×</Button>
                    <Button icon="metronome" on={transport.metronome} disabled={!song.bpm} onClick={() => session.transport.setMetronome(!transport.metronome)}>Click</Button>
                  </div>
                  <Field label="Where the count starts" hint="Bar lines should fall on the “one”. If the click is right but the bars start on the wrong beat, move the count.">
                    <div className="button-row">
                      <Button disabled={!beat} onClick={() => shiftCount(-beat!)} title="Move the “one” a beat earlier">◀ Beat</Button>
                      <Button disabled={!beat} onClick={() => shiftCount(-10)} title="10 ms earlier">−10 ms</Button>
                      <Button disabled={!beat} onClick={() => shiftCount(10)} title="10 ms later">+10 ms</Button>
                      <Button disabled={!beat} onClick={() => shiftCount(beat!)} title="Move the “one” a beat later">Beat ▶</Button>
                    </div>
                  </Field>
                  <div className="button-row">
                    <Button onClick={e => tap(e.timeStamp)} title="Play the song and tap this (or press T) on every beat, starting on a “one”">
                      {tapCount >= 5 ? `Tapping… ${tapCount}` : tapCount > 0 ? `Keep going… ${tapCount}` : 'Tap along (T)'}
                    </Button>
                    <Button disabled={finding} onClick={() => void findBeat('keep')}>Find the beat again</Button>
                    <FileButton kind="quiet" accept=".mp3,.ogg,audio/mpeg,audio/ogg" onFile={file => void session.attachAudio(file)} title="Use a different music file">Replace…</FileButton>
                  </div>
                </>
              )}
            </Panel>

            <Panel title="Sections" aside={<>
              <Button icon="scissors" disabled={!dance.sources.audio} onClick={splitHere} title="Start a new section at the bar under the playhead">Split here</Button>
            </>}>
              {!dance.phrases.length && <p className="muted">Sections are the parts you'll record one at a time: a verse, a chorus. {dance.sources.audio ? 'Find them from the music, or split the song yourself at the playhead.' : 'They\'re found from the music once it\'s added.'}</p>}
              {dance.phrases.length > 0 && (
                <ul className="section-list">
                  {dance.phrases.map(p => {
                    const active = selection && Math.abs(selection[0] - p.startMs) < 1 && Math.abs(selection[1] - p.endMs) < 1;
                    return (
                      <li key={p.id} className={active ? 'active' : ''}>
                        <button className="section-when" title="Select this section" onClick={() => { viewStore.set({ selection: [p.startMs, p.endMs] }); session.transport.seek(p.startMs); }}>
                          {barBeat(dance, p.startMs + 1) ? `bar ${barBeat(dance, p.startMs + 1)!.split('.')[0]}` : p.startMs < 1 ? 'start' : clock(p.startMs, false)}
                        </button>
                        <input aria-label="Section name" defaultValue={p.label} key={p.label} maxLength={40}
                          onBlur={e => { const label = e.target.value.trim(); if (label && label !== p.label) void apply([{ op: 'phrase', action: 'update', id: p.id, label }], 'rename the section'); }}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                        <span className="muted section-length">{clock(p.endMs - p.startMs, false)}</span>
                        <Button kind="quiet" icon="trash" aria-label={`Remove ${p.label}`} title="Remove this section (the music and any recording stay)" onClick={() => void apply([{ op: 'phrase', action: 'remove', id: p.id }], 'remove the section')} />
                      </li>
                    );
                  })}
                </ul>
              )}
              {dance.sources.audio && <div className="button-row">
                <Button disabled={finding || !song.bpm} onClick={() => void findBeat('replace')} title={song.bpm ? 'Replace these with sections found from the music' : 'Set the tempo first'}>
                  {dance.phrases.length ? 'Find sections again' : 'Find sections'}
                </Button>
              </div>}
            </Panel>

            <Panel title="Dancers">
              <Segmented<number> label="Dancers" value={dance.dancers.length} onChange={setDancers} options={[1, 2, 3, 4].map(n => ({ value: n, label: DANCER_WORDS[n] }))} />
              <p className="field-hint">How many coaches the song has. Any number of players can dance any song: each follows one of the coaches.</p>
            </Panel>

            <Panel title="Stage">
              <div className="stage-grid">
                {STAGE_LIST.map(s => (
                  <button key={s.id} className={`stage-tile${shown.song.stage === s.id ? ' on' : ''}`} style={{ background: `linear-gradient(150deg, ${s.accent[0]}, ${s.accent[1]})` }}
                    aria-pressed={song.stage === s.id} onClick={() => { viewStore.set({ look: 'stage' }); if (song.stage !== s.id) void set({ stage: s.id }, 'choose the stage'); }}>
                    <strong>{s.id}</strong><span>{s.subtitle}</span>
                  </button>
                ))}
              </div>
            </Panel>

            <Panel title="About the song">
              <Field label="Title"><input defaultValue={song.title} key={`t${song.title}`} maxLength={120} onBlur={e => { if (e.target.value.trim() !== song.title) void set({ title: e.target.value.trim() }, 'rename the song'); }} /></Field>
              <Field label="Artist"><input defaultValue={song.artist} key={`a${song.artist}`} maxLength={120} onBlur={e => { if (e.target.value.trim() !== song.artist) void set({ artist: e.target.value.trim() }, 'set the artist'); }} /></Field>
              <Field label="Choreography by" hint="Separate names with commas.">
                <input defaultValue={song.choreographers.join(', ')} key={`c${song.choreographers.join()}`} maxLength={300}
                  onBlur={e => { const list = e.target.value.split(',').map(v => v.trim()).filter(Boolean); if (list.join() !== song.choreographers.join()) void set({ choreographers: list }, 'credit the choreography'); }} />
              </Field>
              <Field label="Difficulty" hint="A playtest can measure this for you.">
                <Segmented label="Difficulty" value={song.difficulty} onChange={difficulty => void set({ difficulty }, 'set the difficulty')}
                  options={[{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }]} />
              </Field>
              <Field label="The part players dance" hint={wholeSong ? 'The whole song. To leave out an intro or an ending, select the part to keep in the timeline (shift-drag the ruler) and use it.'
                : `${clock(song.playableStartMs)} to ${clock(song.playableEndMs)} of ${clock(song.durationMs, false)}.`}>
                <div className="button-row">
                  <Button disabled={!selection || selection[1] - selection[0] < 5000} title={selection ? 'Players dance only the selected part' : 'Select the part to keep first'}
                    onClick={() => void set({ playableStartMs: selection![0], playableEndMs: selection![1] }, 'set the part players dance')}>Use the selection</Button>
                  <Button disabled={wholeSong} onClick={() => void set({ playableStartMs: 0, playableEndMs: song.durationMs }, 'play the whole song')}>Whole song</Button>
                </div>
              </Field>
            </Panel>
          </>
        }
        bar={<TransportBar />}
        timeline={<Timeline />}
      />
      {dropping !== null && (
        <Dialog title="Remove dancers that have been recorded?" onClose={() => setDropping(null)}
          actions={<><Button onClick={() => setDropping(null)}>Keep them</Button><Button kind="danger" onClick={() => setDancers(dropping)}>Remove</Button></>}>
          <p>{dance.dancers.slice(dropping).map(d => d.label).join(' and ')} {dance.dancers.length - dropping > 1 ? 'have' : 'has'} recorded motion, which goes too. Undo brings it back.</p>
        </Dialog>
      )}
    </>
  );
}
