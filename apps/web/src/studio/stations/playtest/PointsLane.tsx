// The timeline's Points lane: for each second of the playable song, how much of its points the
// counted attempts earned, as a bar that is both taller and greener the more they did. Seconds
// no attempt covered are empty; stretches left unscored and trouble spots are marked over it.
import type { CSSProperties } from 'react';
import type { HeatCell, Trouble } from '../../../../../../packages/dance/playtest.ts';
import type { Exclusion } from '../../../../../../packages/dance/format.ts';
import { clock } from '../../core/format.ts';
import { useSession } from '../../core/hooks.ts';
import { Lane, Span } from '../../core/Timeline.tsx';
import { cellWords, heatColor } from './analysis.ts';

export function PointsLane({ cells, troubles, unscored, offsetMs, attempts }: {
  cells: readonly HeatCell[]; troubles: readonly Trouble[];
  /** The dancer's unscored stretches (on its own clock; whole-body ones are drawn) and that clock's offset from the song. */
  unscored: readonly Exclusion[]; offsetMs: number;
  /** How many attempts the lane counts. */
  attempts: number;
}) {
  const { transport } = useSession();
  const legend = <i className="playtest-legend" title="Short and red: few of the points were earned. Tall and green: all of them." />;
  return (
    <Lane label="Points" aside={legend} height={38} className="playtest-points" data-cells={cells.filter(c => c.attempts > 0).length} data-attempts={attempts}>
      {!attempts && <span className="playtest-points-empty">Each second of an attempt shows here: how many of its points were earned.</span>}
      {cells.map(cell => cell.attempts > 0 && (
        <Span key={cell.startMs} start={cell.startMs} end={cell.endMs} className="playtest-cell" data-points={Math.round(cell.points * 100)}
          style={{ '--heat': heatColor(cell.points), '--share': Math.max(0.1, cell.points) } as CSSProperties}
          title={`${clock(cell.startMs, false)} · ${cellWords(cell)}${attempts > 1 ? ` (${cell.attempts} of ${attempts} attempts danced it)` : ''}`}
          onClick={() => transport.seek(cell.startMs)} />
      ))}
      {unscored.map(x => !x.controls && (
        <Span key={x.id} start={x.startMs + offsetMs} end={x.endMs + offsetMs} className="playtest-unscored" data-unscored={x.id}
          title={`${clock(x.startMs + offsetMs, false)}–${clock(x.endMs + offsetMs, false)} isn't scored: ${x.reason}`} />
      ))}
      {troubles.map(t => <Span key={t.startMs} start={t.startMs} end={t.endMs} className="playtest-trouble-mark" aria-hidden="true" />)}
    </Lane>
  );
}
