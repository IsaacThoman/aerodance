// Station 4, the playtest: the author (or a friend) dances the routine in front of the camera,
// scored by the game's own scorer, and the station shows where the points went: second by
// second on the timeline, split into the camera losing the player, the pose and the timing.
// Attempts stay with the project and are scored again whenever the dance changes, so a fix can
// be seen to help; stretches good attempts keep losing points on are offered to fix or unscore.
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { heatmap, measuredDifficulty, trouble } from '../../../../../../packages/dance/playtest.ts';
import type { Trouble } from '../../../../../../packages/dance/playtest.ts';
import type { AttemptInfo } from '../../../../../../packages/dance/store.ts';
import { camera, cameraOn } from '../../core/camera.ts';
import type { PoseSourceView } from '../../core/camera.ts';
import { CameraPanel, CameraPreview } from '../../core/CameraPanel.tsx';
import { DancerLanes } from '../../core/DancerLanes.tsx';
import { DANCER_COLORS, clock } from '../../core/format.ts';
import { useEvaluators, useKeys, useProject, useSession, useTransport } from '../../core/hooks.ts';
import { useLivePeople } from '../../core/live.ts';
import { StationLayout } from '../../core/StationLayout.tsx';
import { Timeline } from '../../core/Timeline.tsx';
import { TransportBar } from '../../core/TransportBar.tsx';
import { Button, Dialog, Field, Panel } from '../../core/ui.tsx';
import Viewport from '../../core/Viewport.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { DECENT_ACCURACY, MIN_ATTEMPT_MS, percent } from './analysis.ts';
import type { Range } from './analysis.ts';
import { useScoredAttempts } from './attempts.ts';
import { installFake } from './dev.ts';
import { Overlay } from './Overlay.tsx';
import { AttemptList, HowItWent, WherePointsGo } from './panels.tsx';
import { PointsLane } from './PointsLane.tsx';
import { useAttemptRun } from './run.ts';
import './playtest.css';

const PLAYER_KEY = 'aerodance.studio.player';
const recall = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage is off: it lasts the visit */ } };

const cameraPhase = (view: PoseSourceView) => view.status === 'connected' ? 'on' : cameraOn(view) ? 'starting' : 'off';
/** Whether the camera is off, starting or on. (useCamera re-renders on every tracked frame; this only when that changes.) */
function useCameraPhase() {
  const [phase, setPhase] = useState(() => cameraPhase(camera().view));
  useEffect(() => { const off = camera().subscribe(view => setPhase(cameraPhase(view))); return () => { off(); }; }, []);
  return phase;
}

export default function PlaytestStation() {
  const session = useSession(), { dance, busy } = useProject(), transport = useTransport(), view = useView(), viewStore = useViewStore();
  const cam = useCameraPhase(), live = useLivePeople();
  const { song } = dance, index = Math.min(view.dancer, dance.dancers.length - 1), dancer = dance.dancers[index];

  // ---- What to dance: the selected stretch, or all of the part players dance ----
  const playable = useMemo((): Range => [song.playableStartMs, song.playableEndMs], [song.playableStartMs, song.playableEndMs]);
  const selection = view.selection;
  const chosen: Range | null = selection ? [Math.max(selection[0], playable[0]), Math.min(selection[1], playable[1])] : null;
  const range = chosen ?? playable;
  const wholeSong = playable[0] === 0 && Math.abs(playable[1] - song.durationMs) < 1;
  const section = selection && dance.phrases.find(p => Math.abs(p.startMs - selection[0]) < 1 && Math.abs(p.endMs - selection[1]) < 1);
  const [player, setPlayer] = useState(() => recall(PLAYER_KEY) ?? 'Me');
  const run = useAttemptRun({ dancer: index, range, player: player.trim() || 'Me' });
  const running = run.state.range !== null;

  const recorded = dancer.clips.length > 0 || Object.keys(dancer.layers[0].channels).length > 0;
  // How much of the stretch players are scored on: where the dancer has moves that count (most
  // of the body's joints) and isn't left unscored. A stretch with next to none can't say anything.
  const evaluator = useEvaluators()[index];
  const scoredMs = useMemo(() => {
    const BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28], step = 250;
    let total = 0;
    for (let t = range[0] + step / 2; t < range[1]; t += step) {
      const local = t - dancer.timeOffsetMs;
      if (dancer.exclusions.some(x => !x.controls && local >= x.startMs && local < x.endMs)) continue;
      const eligible = evaluator.eligible(t);
      if (BODY.filter(j => eligible[j]).length >= BODY.length / 2) total += step;
    }
    return total;
  }, [evaluator, dancer, range]);
  /** Why an attempt can't start yet, or null when it can. */
  const reason = !transport.hasAudio ? 'This dance has no music yet. Add it in Song.'
    : !transport.ready ? 'The music is still loading…'
    : !recorded ? `${dancer.label} has no moves yet. Record them first.`
    : range[1] - range[0] < MIN_ATTEMPT_MS ? (chosen ? 'The selected stretch is under 8 seconds, too short to learn from. Select more, or dance it all.' : 'There are under 8 seconds for players to dance.')
    : scoredMs < 2000 ? (chosen ? 'Nothing in the selected stretch is scored: nothing is recorded there, or it\'s left unscored. Pick another part, or dance it all.'
      : `Nothing ${dancer.label} does is scored yet. Record more of the dance first.`)
    : cam === 'off' ? 'Turn the camera on first.'
    : cam === 'starting' ? 'Waiting for the camera…'
    : !live.calibrations[0] ? 'Step back until the camera sees you from head to toe.'
    : null;
  useKeys(e => { if (e.key === 'Escape' && running) { e.preventDefault(); run.stop(); } });

  // ---- Attempts, scored against the dance as it is now ----
  const { attempts, scored, scoring, error } = useScoredAttempts(index);
  const skipKey = `aerodance.studio.playtest.skipped.${session.id}`;
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => { try { return new Set(JSON.parse(recall(skipKey) ?? '[]') as string[]); } catch { return new Set(); } });
  const count = (id: string, counted: boolean) => {
    const next = new Set(skipped);
    if (counted) next.delete(id); else next.add(id);
    setSkipped(next);
    remember(skipKey, JSON.stringify([...next]));
  };
  const [picked, setPicked] = useState<string | null>(null), [removing, setRemoving] = useState<AttemptInfo | null>(null);
  const { dismiss } = run;
  useEffect(() => { setPicked(null); dismiss(); }, [index, dismiss]);
  const shown = scored.find(s => s.info.id === picked) ?? scored[0] ?? null;
  const start = () => { setPicked(null); void run.start(); };
  const remove = (attempt: AttemptInfo) => { setRemoving(null); if (skipped.has(attempt.id)) count(attempt.id, true); void session.removeAttempt(attempt.id); };

  // ---- Where the points go, over the attempts that count ----
  const counted = useMemo(() => scored.filter(s => !skipped.has(s.info.id)).map(s => s.analysis), [scored, skipped]);
  const cells = useMemo(() => heatmap(counted, playable[0], playable[1]), [counted, playable]);
  const troubles = useMemo(() => trouble(counted, playable[0], playable[1], { goodAccuracy: DECENT_ACCURACY }), [counted, playable]);
  const select = (t: Trouble) => { viewStore.set({ selection: [t.startMs, t.endMs] }); session.transport.seek(t.startMs); };

  useEffect(() => import.meta.env.DEV ? installFake(session, () => Math.min(viewStore.state.dancer, session.state.dance.dancers.length - 1)) : undefined, [session, viewStore]);

  // The last attempt's outcome stays on the stage until the next one (or until it's deleted).
  const { ended } = run.state, kept = ended?.kind === 'saved' && attempts.some(a => a.id === ended.attempt.id);
  const last = kept ? scored.find(s => s.info.id === ended.attempt.id) : null;
  const idle = kept || ended?.kind === 'saving' ? { title: last ? `${last.analysis.result.grade} · ${percent(last.analysis.result.accuracy)} of the points` : 'Scoring it…', text: 'Kept with your attempts. Where the points went is on the right and in the timeline.' }
    : ended?.kind === 'short' ? { title: 'Not kept', text: 'That was under 8 seconds, too short to learn from.' }
    : ended?.kind === 'unseen' ? { title: 'Not kept', text: 'The camera didn\'t see anyone dancing.' }
    : reason ? { title: 'Dance it like a player would', text: reason }
    : { title: 'Ready when you are', text: 'Press Start and follow the coach. The game\'s own scoring judges every second.' };

  return (
    <>
      <StationLayout
        stage={
          <Viewport view="stage" focus={index}>
            <Overlay run={run.state} idle={idle} state={{ 'data-attempts': attempts.length, 'data-scored': scored.length, 'data-scoring': scoring, 'data-can-start': !reason && !busy }} />
            {cam !== 'off' && <CameraPreview />}
          </Viewport>
        }
        side={
          <>
            <CameraPanel people={1} live={live} />

            <Panel title="Try it">
              <div className="field row">
                <span className="field-label">Who to follow</span>
                <div className="playtest-dancers" role="radiogroup" aria-label="Who to follow">
                  {dance.dancers.map((d, i) => (
                    <button key={d.id} type="button" role="radio" aria-checked={i === index} disabled={running} className={i === index ? 'on' : ''}
                      style={{ '--dancer': DANCER_COLORS[i % 4] } as CSSProperties} onClick={() => viewStore.set({ dancer: i })}>
                      <i className="dancer-dot" style={{ background: DANCER_COLORS[i % 4] }} />{d.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">What to dance</span>
                <div className="playtest-stretch" data-stretch={chosen ? 'selection' : 'all'}>
                  <span>
                    {section ? <><strong>{section.label}</strong>, {clock(range[0], false)}–{clock(range[1], false)}</>
                      : chosen ? <>Your selection, <strong>{clock(range[0])}–{clock(range[1])}</strong></>
                      : wholeSong ? <>The <strong>whole song</strong>, {clock(song.durationMs, false)}</>
                      : <>The part players dance, <strong>{clock(range[0], false)}–{clock(range[1], false)}</strong></>}
                  </span>
                  {chosen && <Button kind="quiet" disabled={running} onClick={() => viewStore.set({ selection: null })} title="Clear the selection and dance everything players do">Dance it all</Button>}
                </div>
                {!chosen && <span className="field-hint" title="Or shift-drag the timeline's ruler to select any stretch">To try just one part, click a section in the timeline.</span>}
              </div>
              <Field label="Who's dancing" row>
                <input className="playtest-name" value={player} maxLength={24} placeholder="Me" disabled={running} onChange={e => { setPlayer(e.target.value); remember(PLAYER_KEY, e.target.value.trim() || 'Me'); }} />
              </Field>
              {running
                ? <Button kind="danger" big icon="stop" className="playtest-start" onClick={run.stop} title="Stop the attempt (Esc)">Stop</Button>
                : <Button kind="primary" big icon="play" className="playtest-start" disabled={!!reason || !!busy} onClick={start}>Start</Button>}
              {running ? <p className="field-hint">Esc stops it too. What was danced is kept if it's 8 seconds or more.</p>
                : reason && <p className="playtest-reason" role="status">{reason}</p>}
            </Panel>

            <HowItWent attempt={shown} playable={playable} waiting={attempts.length > 0 && !error} />
            {error && <Panel><p className="playtest-reason" role="alert">The routine couldn't be put together for scoring: {error}</p></Panel>}

            <AttemptList attempts={attempts} scored={scored} scoring={scoring} revision={dance.revision} playable={playable} shown={shown?.info.id ?? null} skipped={skipped}
              onPick={setPicked} onCount={count} onRemove={setRemoving} />

            <WherePointsGo
              counted={{ attempts: counted.length, accuracy: counted.reduce((n, a) => n + a.result.accuracy, 0) / Math.max(1, counted.length) }}
              decent={counted.filter(a => a.result.accuracy >= DECENT_ACCURACY).length} troubles={troubles}
              measured={measuredDifficulty(counted)} difficulty={song.difficulty}
              onShow={select}
              onFix={t => { select(t); location.hash = '#/p/' + encodeURIComponent(session.id) + '/fix'; }}
              onUnscore={t => void session.apply([{ op: 'exclude', dancer: dancer.id, start: t.startMs - dancer.timeOffsetMs, end: t.endMs - dancer.timeOffsetMs, reason: 'Players lose points here' }], 'leave a stretch unscored')}
              onUseDifficulty={difficulty => void session.apply([{ op: 'song', set: { difficulty } }], 'set the difficulty')} />
          </>
        }
        bar={<TransportBar keys={!running} />}
        timeline={
          <Timeline>
            <DancerLanes />
            <PointsLane cells={cells} troubles={troubles} unscored={dancer.exclusions} offsetMs={dancer.timeOffsetMs} attempts={counted.length} />
          </Timeline>
        }
      />
      {removing && (
        <Dialog title="Delete this attempt?" onClose={() => setRemoving(null)}
          actions={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button kind="danger" onClick={() => remove(removing)}>Delete</Button></>}>
          <p>{removing.player}'s attempt goes for good: undo doesn't bring attempts back.</p>
        </Dialog>
      )}
    </>
  );
}
