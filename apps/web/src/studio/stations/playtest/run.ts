// One attempt: the song plays a stretch after a count-in, the camera's poses are stamped with
// the song time that was audible when each was taken and fed to the game's scorer as the game
// feeds its own, and what was danced is kept with the project for scoring again later.
import { useCallback, useEffect, useRef, useState } from 'react';
import { INTERVAL_MS, createScorer, pointsShare } from '../../../../../../packages/score/scorer.ts';
import type { WindowJudgement } from '../../../../../../packages/score/scorer.ts';
import type { AttemptInfo } from '../../../../../../packages/dance/store.ts';
import type { TrackedFrame } from '../../../../../../packages/dance/takes.ts';
import { camera } from '../../core/camera.ts';
import { compileNow } from '../../core/compile.ts';
import { useLatest, useSession } from '../../core/hooks.ts';
import { MIN_ATTEMPT_MS } from './analysis.ts';
import type { Range } from './analysis.ts';

/** The count-in before the stretch starts. */
export const COUNT_IN_MS = 3000;
/** Intervals are scored this far behind the song, as the game does, so poses still on their way from the tracker count. */
const LATE_MS = 750;
/** The song plays on this long past the stretch for the last poses to arrive. */
const TAIL_MS = 400;

export interface RunState {
  /** The stretch being danced, or null when no attempt is running. */
  range: Range | null;
  /** The newest judgement and the combo it made; `n` counts them, so each can be shown afresh. */
  judgement: { kind: WindowJudgement; combo: number; n: number } | null;
  /** The share of points earned of those played so far, or null before any. */
  accuracy: number | null;
  /** How the last attempt ended: being kept, kept, too short to keep, or the camera never saw the player. */
  ended: { kind: 'saved'; attempt: AttemptInfo } | { kind: 'saving' | 'short' | 'unseen' } | null;
}
const IDLE: RunState = { range: null, judgement: null, accuracy: null, ended: null };

export function useAttemptRun(options: { dancer: number; range: Range; player: string }) {
  const session = useSession(), latest = useLatest(options);
  const [state, setState] = useState(IDLE);
  const stopper = useRef<(() => void) | null>(null), starting = useRef(false), mounted = useRef(true);

  const start = useCallback(async () => {
    if (stopper.current || starting.current) return;
    starting.current = true;
    const { dancer: index, range, player } = latest.current, { transport } = session;
    transport.pause();
    // A moment for the status line to show before the compile holds the page.
    const ready = await session.busy('Getting the routine ready…', async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      const bundle = compileNow(session);
      return { scorer: createScorer(bundle, 1, [index]), revision: bundle.song.build.projectRevision };
    });
    starting.current = false;
    const dancer = session.state.dance.dancers[index];
    if (!ready || !dancer || !mounted.current) return;
    const { scorer, revision } = ready;

    const frames: TrackedFrame[] = [];
    let size = { width: 640, height: 480 }, seen = 0, earned = 0, played = 0, combo = 0, shown = 0, over = false;
    // The scorer covers the whole playable song; only what falls in the stretch is this attempt's.
    scorer.onInterval(e => { if (e.songTimeMs >= range[0] && e.songTimeMs <= range[1]) { earned += pointsShare(e.score); played++; } });
    scorer.onJudgement(e => {
      if (e.songTimeMs - 1000 < range[0] - INTERVAL_MS || e.songTimeMs > range[1] + INTERVAL_MS) return;
      combo = e.judgement === 'miss' || e.judgement === 'lost' ? 0 : combo + 1;
      const judgement = { kind: e.judgement, combo, n: ++shown };
      setState(s => ({ ...s, judgement, accuracy: played ? earned / played : null }));
    });
    const finish = () => {
      if (over) return;
      over = true;
      clearInterval(timer); unsubscribe(); stopper.current = null;
      transport.pause();
      const danced = frames.length > 1 ? frames[frames.length - 1].videoMs - frames[0].videoMs : 0;
      if (danced < MIN_ATTEMPT_MS || seen < 10) { setState({ ...IDLE, ended: { kind: danced < MIN_ATTEMPT_MS ? 'short' : 'unseen' } }); return; }
      setState({ ...IDLE, ended: { kind: 'saving' } });
      void session.busy('Keeping the attempt…', () => session.addAttempt(frames, { dancer: dancer.id, revision, player, ...size }))
        .then(attempt => setState({ ...IDLE, ended: attempt ? { kind: 'saved', attempt } : null }));
    };
    const unsubscribe = camera().subscribeRecords(event => {
      if (!('record' in event)) { finish(); return; }
      if (!transport.state.playing) return;
      const songMs = Math.round(transport.songTimeAt(event.captureBrowserTimeMs) * 10) / 10;
      // Song time only moves forward; a straggler from before is dropped.
      if (songMs < range[0] || songMs > range[1] || frames.length && songMs <= frames[frames.length - 1].videoMs) return;
      const { record } = event, pose = record.poses.find(p => p.playerId === 0);
      size = { width: record.input.width, height: record.input.height };
      if (pose) { scorer.addSample(0, songMs, pose.landmarks, size.width / size.height); seen++; }
      // A frame without the player is kept too: it says the camera lost them there.
      frames.push({ videoMs: songMs, poses: [pose?.landmarks ?? null] });
    });
    // At full speed and straight through, as players get it.
    transport.setRate(1);
    transport.play({ fromMs: range[0] - COUNT_IN_MS, loop: null });
    let last = transport.timeMs();
    const timer = setInterval(() => {
      const t = transport.timeMs();
      // The stretch is over, or the song was paused or moved from outside.
      if (!transport.state.playing || t >= range[1] + TAIL_MS || t < last - 250) { finish(); return; }
      last = t;
      scorer.advance(t - LATE_MS);
    }, 100);
    stopper.current = finish;
    setState({ ...IDLE, range });
  }, [session, latest]);

  const stop = useCallback(() => stopper.current?.(), []);
  // Leaving the station ends the attempt (and keeps it, if enough was danced).
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop(); }; }, [stop]);
  const dismiss = useCallback(() => setState(s => s.ended ? { ...s, ended: null } : s), []);
  return { state, start, stop, dismiss };
}
