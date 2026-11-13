// Station 2, recording: the routine is made by dancing it. The author picks a dancer and a
// stretch of the song, presses Record and dances while it plays (round and round, a take per
// time through, until they stop), and the newest take becomes that dancer's motion there. Older
// takes stay to choose from, and a stretch can repeat an earlier part or follow another dancer
// instead of being danced again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { TakeSource } from '../../../../../../packages/dance/format.ts';
import { measureTake } from '../../../../../../packages/dance/takes.ts';
import { SKELETON } from '../../../../../../packages/pose/browser/preview.ts';
import type { PlayerCount } from '../../../../../../packages/pose/choreography.ts';
import { camera, cameraOn, startCamera } from '../../core/camera.ts';
import { CameraPanel, CameraPreview } from '../../core/CameraPanel.tsx';
import { TakeRecorder } from '../../core/capture.ts';
import type { Capture } from '../../core/capture.ts';
import { DancerLanes } from '../../core/DancerLanes.tsx';
import { DANCER_COLORS, barMs, beatMs, clock } from '../../core/format.ts';
import { useCamera, useKeys, useProject, useSession, useSongTime, useTransport } from '../../core/hooks.ts';
import { useLivePeople } from '../../core/live.ts';
import { StationLayout } from '../../core/StationLayout.tsx';
import { Timeline } from '../../core/Timeline.tsx';
import { TransportBar } from '../../core/TransportBar.tsx';
import { Button, Note, Panel, Segmented } from '../../core/ui.tsx';
import Viewport from '../../core/Viewport.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { LinkPanel, PickedPanel, TakesPanel } from './panels.tsx';
import { beatAtOrAfter, overlap, stretchOf, takeSpan, withHandles } from './stretch.ts';
import type { Range } from './stretch.ts';
import { VideoPanel } from './VideoPanel.tsx';
import './record.css';

/** A recording in progress: what it is of, fixed when Record was pressed. */
interface Run {
  recorder: TakeRecorder;
  range: Range; name: string; whole: boolean; loop: boolean;
  /** Where the count-in lands: the first beat of the stretch. */
  goMs: number;
  /** The dancer (by id) each person in the camera's picture is recorded as. */
  dancers: string[];
  /** The number the first time through gets ("take 3"); each further pass counts on from it. */
  firstTake: number;
  /** The transport's loop before recording, put back afterwards. */
  loopBefore: Range | null;
  /** When the song passed the end of a stretch that doesn't loop (performance.now()). */
  pastEnd: number | null;
}
/** Who the people in takes recorded this session were (project/take → dancer ids): a take's file doesn't say. */
const recordedAs = new Map<string, string[]>();
const span = (c: Capture) => c.frames[c.frames.length - 1].videoMs - c.frames[0].videoMs;
/** Brings the Stop button into view when it appears (the column may be scrolled away from it). */
const reveal = (el: HTMLElement | null) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
const list = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';

/** Over the coach view while recording: the count-in, then what is being recorded and how far through. */
function RecordingOverlay({ run }: { run: Run }) {
  const { transport } = useSession(), { dance } = useProject();
  const time = useSongTime(30), pass = transport.passAt();
  const beat = beatMs(dance), left = pass === 0 ? run.goMs - time : 0, count = Math.ceil(left / (beat ?? 1000));
  const started = pass > 0 || time >= run.range[0];
  return (
    <>
      {count > 0 && (
        <div className="rec-count" data-count={count}>
          <div><span>Get ready</span>{count <= 4 && <strong key={count}>{count}</strong>}</div>
        </div>
      )}
      <div className={`rec-badge${started ? ' live' : ''}`}>
        <i className="rec-dot" />{started ? 'Recording' : 'Get ready'}<span>{run.name}</span>{(run.loop || run.firstTake > 1) && <span>take {run.firstTake + pass}</span>}
      </div>
      {started && <div className="rec-progress"><div style={{ width: `${Math.max(0, Math.min(1, (time - run.range[0]) / (run.range[1] - run.range[0]))) * 100}%` }} /></div>}
    </>
  );
}

export default function RecordStation() {
  const session = useSession(), { dance } = useProject(), transport = useTransport(), view = useView(), viewStore = useViewStore();
  const cam = useCamera(), live = useLivePeople();
  const count = dance.dancers.length, selected = Math.min(view.dancer, count - 1);
  const stretch = useMemo(() => stretchOf(dance, view.selection), [dance, view.selection]);

  // ---- Who is in front of the camera ----
  const [peopleWanted, setPeopleWanted] = useState(1);
  const people = Math.min(peopleWanted, count) as PlayerCount;
  // The dancer each person in the picture is (by index): the selected dancer first, then the
  // ones after it, unless the author has said otherwise.
  const [custom, setCustom] = useState<number[] | null>(null);
  const order = useMemo(() => custom && custom.length === people && custom.includes(selected) && custom.every((d, i) => d < count && custom.indexOf(d) === i) ? custom
    : Array.from({ length: people }, (_, i) => (selected + i) % count), [custom, people, selected, count]);
  const assign = (person: number, dancer: number) => {
    const next = [...order], other = next.indexOf(dancer);
    if (other >= 0) next[other] = next[person];
    next[person] = dancer;
    setCustom(next);
    if (!next.includes(selected)) viewStore.set({ dancer });
  };
  /**
   * The dancers a take's people go to when it's used again, in the take's order. One person's
   * take goes to the selected dancer; several people's goes back to who they were recorded as.
   */
  const placeFor = useCallback((take: TakeSource): number[] => {
    if (take.slots === 1) return [selected];
    const n = Math.min(take.slots, count), ids = dance.dancers.map(d => d.id);
    const whole = (dancers: number[]) => dancers.length === n && dancers.every((d, i) => d >= 0 && dancers.indexOf(d) === i);
    const recorded = (recordedAs.get(`${session.id}/${take.id}`) ?? []).map(id => ids.indexOf(id));
    if (whole(recorded)) return recorded;
    const playing = Array.from({ length: n }, (_, person) => dance.dancers.findIndex(d => d.clips.some(c => c.kind === 'take' && c.take === take.id && c.slot === person)));
    if (whole(playing)) return playing;
    return take.origin !== 'video' && order.length === n ? order : Array.from({ length: n }, (_, i) => i);
  }, [session, dance, order, selected, count]);
  // A camera left on by another station may be tracking a different number of people.
  useEffect(() => { if (cameraOn(camera().view) && camera().playerCount !== people) void startCamera(people).catch(() => {}); }, [people]);

  // ---- What is recorded, and how ----
  const [countBars, setCountBars] = useState(1), [loopWanted, setLoopWanted] = useState<boolean | null>(null);
  const looping = loopWanted ?? !stretch.whole;
  const bar = barMs(dance);
  const nextTake = useMemo(() => {
    const numbers = dance.sources.takes.filter(t => overlap(takeSpan(dance, t), stretch.range) > 250)
      .map(t => t.label.startsWith(`${stretch.name} · take `) ? Number(t.label.slice(stretch.name.length + 8)) : 0).filter(Number.isFinite);
    return Math.max(0, ...numbers) + 1;
  }, [dance, stretch]);

  const on = cameraOn(cam), connected = cam.status === 'connected';
  const seen = order.every((_, person) => !!live.calibrations[person]);
  const blocked = !on ? 'Turn the camera on to record.'
    : !connected ? 'The camera is starting…'
    : !seen ? (people > 1 ? 'The camera needs to see everyone head to toe first.' : 'The camera needs to see you head to toe first.')
    : !transport.ready ? 'The music is still loading…' : null;

  // ---- Recording ----
  const run = useRef<Run | null>(null);
  const [active, setActive] = useState<Run | null>(null), [saving, setSaving] = useState(false), [passes, setPasses] = useState(0);
  const recording = active !== null, busy = recording || saving;
  // How the last recording went, shown until the dance next changes.
  const [outcome, setOutcome] = useState<{ kind: 'good' | 'warning' | 'info'; text: string; revision: number } | null>(null);
  const report = useCallback((kind: 'good' | 'warning' | 'info', text: string) => setOutcome({ kind, text, revision: session.state.dance.revision }), [session]);
  const start = () => {
    if (run.current || busy || blocked) return;
    const goMs = beatAtOrAfter(dance, stretch.range[0]), lead = bar ? bar * countBars : 3000;
    const next: Run = { recorder: new TakeRecorder(camera(), session.transport), range: stretch.range, name: stretch.name, whole: stretch.whole, loop: looping, goMs,
      dancers: order.map(d => dance.dancers[d].id), firstTake: nextTake, loopBefore: transport.loop, pastEnd: null };
    run.current = next;
    setPasses(0); setOutcome(null); setActive(next);
    viewStore.set({ clip: null });
    session.transport.play({ fromMs: goMs - lead, loop: looping ? next.range : null });
    next.recorder.start({ slots: next.dancers.length, range: next.range, onPass: () => setPasses(n => n + 1) });
  };
  /** Stops recording. Keeping saves each time through as a take and puts the newest whole one in the dance. */
  const finish = useCallback(async (keep: boolean) => {
    const now = run.current;
    if (!now) return;
    run.current = null;
    setActive(null);
    const { transport } = session;
    transport.pause();
    const captures = now.recorder.stop();
    transport.setLoop(now.loopBefore);
    transport.seek(now.range[0]);
    if (!keep) return report('info', 'Stopped. Nothing from that recording was kept.');
    const long = captures.filter(c => span(c) >= 1000), tracked = long.filter(c => Math.max(...c.coverage) >= 0.2);
    if (!tracked.length) return report('warning', long.length ? 'The camera didn\'t see you during that take, so it wasn\'t kept.' : 'That was too short to keep.');
    // A last time through that was cut short doesn't replace a whole one, and under half the
    // stretch it isn't worth keeping beside one.
    const length = now.range[1] - now.range[0], whole = tracked.filter(c => span(c) >= length * 0.9);
    const kept = whole.length ? tracked.filter(c => span(c) >= length * 0.5) : tracked, newest = (whole.length ? whole : kept).at(-1)!;
    setSaving(true);
    await session.busy(kept.length > 1 ? 'Saving your takes…' : 'Saving your take…', async () => {
      let placed: TakeSource | null = null, saved = 0;
      for (const capture of kept) {
        const take = await session.addTake(withHandles(capture.frames, now.range, session.state.dance.song.durationMs), { width: capture.width, height: capture.height, slots: capture.slots },
          { label: `${now.name} · take ${now.firstTake + capture.pass}`, origin: 'webcam', clock: 'song', fps: capture.fps || 30 });
        if (!take) return;
        recordedAs.set(`${session.id}/${take.id}`, now.dancers);
        saved++;
        if (capture === newest) placed = take;
      }
      const take = placed as TakeSource | null;
      if (!take) return;
      // Placed where it was recorded, it takes over that stretch of each dancer.
      const data = session.state.takes(take.id), missed: string[] = [], ops: unknown[] = [];
      now.dancers.forEach((id, person) => {
        const dancer = session.state.dance.dancers.find(d => d.id === id);
        if (!dancer) return;
        if (data && measureTake(data, person)) ops.push({ op: 'clip', dancer: id, take: take.id, slot: person }); else missed.push(dancer.label);
      });
      if (ops.length && !await session.apply(ops, `record ${now.whole ? 'the whole song' : now.name}`)) return;
      if (!ops.length) report('warning', 'The camera never saw you clearly enough to use that take. It\'s kept in Takes.');
      else if (missed.length) report('warning', `Recorded, but the camera didn't see enough of ${list(missed)}, who ${missed.length > 1 ? 'keep' : 'keeps'} what was there before.`);
      else report('good', `${saved > 1 ? `Kept ${saved} takes; the newest is in the dance.` : 'That take is in the dance.'} Press Space to watch it back.`);
    });
    setSaving(false);
  }, [session, report]);
  // Without a loop it stops by itself at the end of the stretch; and if the song is paused or
  // the camera goes, what was danced so far is kept.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const now = run.current, { transport } = session;
      if (!now) return;
      if (!transport.state.playing || camera().view.status !== 'connected') return void finish(true);
      if (now.loop || transport.timeMs() < now.range[1]) return;
      // A moment more, for the last poses still on their way from the tracker.
      now.pastEnd ??= performance.now();
      if (performance.now() - now.pastEnd >= 200) void finish(true);
    }, 50);
    return () => clearInterval(timer);
  }, [active, session, finish]);
  // Leaving the station mid-recording drops it.
  useEffect(() => () => {
    const now = run.current;
    if (!now) return;
    run.current = null;
    now.recorder.stop();
    session.transport.pause();
    session.transport.setLoop(now.loopBefore);
  }, [session]);
  useKeys(e => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.dialog-backdrop')) return;
    if (e.key.toLowerCase() === 'r' && !e.repeat) { e.preventDefault(); if (recording) void finish(true); else start(); }
    else if (recording && e.key === ' ') { e.preventDefault(); void finish(true); }
    else if (recording && e.key === 'Escape') { e.preventDefault(); void finish(false); }
  });

  // While recording (or waiting to), the recorded dancers are the people in front of the camera;
  // playing the song back shows what's in the dance instead.
  const following = connected && (recording || !transport.playing);
  const slots = useMemo(() => new Map(order.map((dancer, person) => [dancer, person])), [order]);
  const liveView = useMemo(() => following ? { people: live, slots } : null, [following, live, slots]);

  return (
    <StationLayout
      stage={
        <Viewport view={view.look} mirror={view.mirror} focus={count > 1 && people === 1 ? selected : null} live={liveView}>
          {!busy && <div className="viewport-tools">
            <Segmented label="Coach view" value={view.look} onChange={look => viewStore.set({ look })}
              options={[{ value: 'floor', label: 'Practice floor' }, { value: 'stage', label: 'The stage', title: 'The song\'s stage, as the game shows it' }]} />
          </div>}
          {on && !recording && <div className="viewport-chip">{!connected ? 'Starting the camera…' : !following ? 'Playing back what\'s recorded' : seen ? (people > 1 ? 'This is all of you, live' : 'This is you, live') : 'Step back until the camera sees all of you'}</div>}
          {on && <CameraPreview people={people} />}
          {active && <RecordingOverlay run={active} />}
        </Viewport>
      }
      side={
        <>
          <div className="rec-group" inert={busy}>
            <CameraPanel people={people} live={live}>
              {count > 1 && (
                <>
                  <div className="field rec-people">
                    <span className="field-label">People in the shot</span>
                    <Segmented<number> label="People in the shot" value={people} onChange={setPeopleWanted} options={dance.dancers.map((_, i) => ({ value: i + 1, label: i ? `${i + 1}` : 'Just me' }))} />
                  </div>
                  {people > 1 && (
                    <div className="rec-who">
                      {order.map((dancer, person) => (
                        <label key={person} className="field row">
                          <span className="field-label"><b style={{ color: SKELETON[person] }}>P{person + 1}</b> in the picture is</span>
                          <select value={dancer} onChange={e => { assign(person, Number(e.target.value)); e.target.blur(); }}>
                            {dance.dancers.map((d, i) => <option key={d.id} value={i}>{d.label}</option>)}
                          </select>
                        </label>
                      ))}
                      <span className="field-hint">The little picture names each person it follows. P1 starts on the left.</span>
                    </div>
                  )}
                </>
              )}
            </CameraPanel>
          </div>

          <Panel title="Record">
            <div className="rec-controls" data-phase={recording ? 'recording' : saving ? 'saving' : 'idle'} data-ready={!blocked} data-passes={passes} data-people={people} data-stretch={stretch.name} data-following={following}>
              <div className="rec-setup" inert={busy}>
                {count > 1 && <div className="field">
                  <span className="field-label">{people > 1 ? 'Who you are' : 'Who you\'re dancing'}</span>
                  <div className="rec-dancers">
                    {dance.dancers.map((d, i) => (
                      <button key={d.id} type="button" className={`rec-dancer${order.includes(i) ? ' on' : ''}`} aria-pressed={order.includes(i)} style={{ '--dancer': DANCER_COLORS[i % 4] } as CSSProperties}
                        onClick={() => viewStore.set({ dancer: i })} title={order.includes(i) ? `Recording ${d.label}` : `Record ${d.label} instead`}><i />{d.label}</button>
                    ))}
                  </div>
                </div>}
                <div className="field">
                  <span className="field-label">Which part</span>
                  <div className="rec-stretch">
                    <strong>{stretch.whole ? 'The whole song' : stretch.name}</strong>
                    <span className="muted">{stretch.where && `${stretch.where} · `}{clock(stretch.range[1] - stretch.range[0], false)}</span>
                    {!stretch.whole && <Button kind="quiet" onClick={() => viewStore.set({ selection: null, clip: null })} title="Record the whole song instead">Whole song</Button>}
                  </div>
                  {stretch.whole && <span className="field-hint">{dance.phrases.length ? 'Click a section in the timeline to record just that part.' : 'To record a part at a time, shift-drag across the timeline\'s ruler to select it.'}</span>}
                </div>
                <div className="field row">
                  <span className="field-label">Count-in</span>
                  {bar ? <Segmented<number> label="Count-in" value={countBars} onChange={setCountBars} options={[{ value: 1, label: '1 bar' }, { value: 2, label: '2 bars' }]} />
                    : <span className="muted" title="Set the song's tempo in Song to count in by bars">3 seconds</span>}
                </div>
                <label className="rec-check">
                  {/* (R reaches the page's shortcuts from anywhere but a field: this box passes it on.) */}
                  <input type="checkbox" checked={looping} onChange={e => setLoopWanted(e.target.checked)} />
                  <span>Keep looping until I stop<small>Each time through is kept as a take.</small></span>
                </label>
              </div>
              {!recording ? (
                <Button kind="primary" big icon="record" className="rec-go" disabled={!!blocked || busy} onClick={start} title="Record (R)">Record<kbd>R</kbd></Button>
              ) : (
                <div className="rec-stop" ref={reveal}>
                  <Button kind="danger" big icon="stop" className="rec-go" onClick={() => void finish(true)} title="Stop and keep what you danced (R or Space)">Stop<kbd>R</kbd></Button>
                  <Button onClick={() => void finish(false)} title="Stop and keep nothing (Escape)">Discard<kbd>Esc</kbd></Button>
                </div>
              )}
              {blocked && !busy && <p className="rec-why">{blocked}</p>}
              {active?.loop && <p className="rec-why">{passes ? `${passes} ${passes > 1 ? 'takes' : 'take'} so far. ` : ''}It goes round until you stop.</p>}
              {outcome && !busy && outcome.revision === dance.revision && <Note kind={outcome.kind}>{outcome.text}</Note>}
            </div>
          </Panel>

          <div className="rec-group" inert={busy}>
            <TakesPanel stretch={stretch} placeFor={placeFor} />
            <LinkPanel stretch={stretch} />
            {view.clip && <PickedPanel />}
            <VideoPanel />
          </div>
        </>
      }
      bar={<div className="rec-group" inert={busy}><TransportBar keys={!busy} /></div>}
      timeline={<div className="rec-group" inert={busy}><Timeline><DancerLanes /></Timeline></div>}
    />
  );
}
