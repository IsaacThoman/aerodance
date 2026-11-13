// What's drawn over the stage: nothing much while idle, the count-in before an attempt, and
// during one the judgements as they land, the combo and the points earned so far.
import type { ReactNode } from 'react';
import { clock } from '../../core/format.ts';
import { useSongTime } from '../../core/hooks.ts';
import { JUDGEMENT_WORDS, percent } from './analysis.ts';
import type { RunState } from './run.ts';

/** The count-in and the live readout of a running attempt. */
function Running({ run }: { run: RunState & { range: NonNullable<RunState['range']> } }) {
  const time = useSongTime(30), [from, to] = run.range, left = from - time;
  if (left > 0) return (
    <div className="playtest-countdown" role="status">
      <span>Get ready</span>
      <strong key={Math.ceil(left / 1000)}>{Math.ceil(left / 1000)}</strong>
    </div>
  );
  const { judgement } = run;
  return (
    <>
      <div className="playtest-progress" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(1, (time - from) / (to - from))) * 100}%` }} /></div>
      <div className="playtest-now">
        <strong>{run.accuracy === null ? '—' : percent(run.accuracy)}</strong>
        <span>of the points so far</span>
      </div>
      <div className="playtest-left">{clock(Math.max(0, to - time), false)} to go</div>
      {judgement && (
        <div key={judgement.n} className={`playtest-judgement is-${judgement.kind}`}>
          <strong>{JUDGEMENT_WORDS[judgement.kind]}</strong>
          {judgement.combo > 1 && <span>{judgement.combo} in a row</span>}
        </div>
      )}
    </>
  );
}

export function Overlay({ run, idle, state }: {
  run: RunState;
  /** What the stage says while no attempt is running. */
  idle: { title: ReactNode; text: ReactNode };
  /** Reported on the element as data-* for scripts. */
  state: Record<`data-${string}`, string | number | boolean>;
}) {
  const time = useSongTime(4);
  const phase = !run.range ? 'idle' : time < run.range[0] ? 'countdown' : 'playing';
  return (
    <div className="playtest-overlay" data-phase={phase} data-judgements={run.judgement?.n ?? 0} data-judgement={run.judgement?.kind ?? ''}
      data-ended={run.ended?.kind ?? ''} {...state}>
      {run.range ? <Running run={{ ...run, range: run.range }} /> : <div className="playtest-idle"><strong>{idle.title}</strong><span>{idle.text}</span></div>}
    </div>
  );
}
