// A dancer's lane in the Fix station's timeline: where it's unscored (hatched), approved (a
// green line), planted (bars along the bottom) and touched up (diamonds, which go to their
// moment), and a marker at the top for each finding still to decide, which opens it in the inbox.
import type { CSSProperties } from 'react';
import type { Finding } from '../../core/findings.ts';
import { clock } from '../../core/format.ts';
import { useProject, useSession } from '../../core/hooks.ts';
import { Span, useTimeline } from '../../core/Timeline.tsx';
import { toneOf } from './Inbox.tsx';
import { moves, touchUpLayer } from './Moment.tsx';
import { findingKey, findingTitle, findingWhen, partWords, wholeSong } from './words.ts';

/** How far a clip's block sits inside its lane, top and bottom (studio.css .clip). */
const CLIP_EDGE = 8;
/** Feet along the bottom of the block, hands just above them. */
const PLANT_ROWS = { leftAnkle: 0, rightAnkle: 0, leftWrist: 1, rightWrist: 1 } as const;
const PLANT_WORDS = { leftAnkle: 'Left foot', rightAnkle: 'Right foot', leftWrist: 'Left hand', rightWrist: 'Right hand' } as const;

export function LaneMarks({ dancer: index, findings, open, onOpen }: { dancer: number; findings: readonly Finding[]; open: string | null; onOpen(finding: Finding): void }) {
  const session = useSession(), { shown: dance } = useProject(), { toX } = useTimeline();
  const dancer = dance.dancers[index], offset = dancer.timeOffsetMs;
  const layer = touchUpLayer(dancer);
  const touched = [...new Set(Object.values(layer?.channels ?? {}).flatMap(keys => keys.filter(moves).map(k => k.t)))];
  const when = (x: { startMs: number; endMs: number }) => `${clock(x.startMs + offset)} – ${clock(x.endMs + offset)}`;
  return (
    <>
      {dancer.exclusions.map(x => <Span key={`x${x.id}`} start={x.startMs + offset} end={x.endMs + offset} className="mark mark-unscored" style={{ top: x.controls ? '50%' : CLIP_EDGE, bottom: CLIP_EDGE }}
        title={`Unscored: ${partWords(x.controls)} · ${when(x)}`} data-mark="unscored" />)}
      {dancer.approvals.map(x => <Span key={`ok${x.id}`} start={x.startMs + offset} end={x.endMs + offset} className="mark mark-approved" style={{ top: CLIP_EDGE + 3, bottom: 'auto', height: 3 }}
        title={`Looks right: ${partWords(x.controls)} · ${when(x)}`} data-mark="approved" />)}
      {dancer.contacts.map(c => <Span key={`c${c.id}`} start={c.startMs + offset} end={c.endMs + offset} className="mark mark-plant" style={{ top: 'auto', bottom: CLIP_EDGE + 3 + PLANT_ROWS[c.control] * 5, height: 3 }}
        title={`${PLANT_WORDS[c.control]} planted · ${when(c)}`} data-mark="plant" />)}
      {touched.map(t => <button key={`t${t}`} type="button" className="mark-touch" style={{ left: toX(t + offset) }} title={`Touched up at ${clock(t + offset)}`} aria-label={`Go to the touch-up at ${clock(t + offset)}`}
        data-mark="touch" data-at={t + offset} onPointerDown={e => e.stopPropagation()} onClick={() => session.transport.seek(t + offset)} />)}
      {findings.filter(f => f.dancer === dancer.id).map(f => {
        const key = findingKey(f), whole = wholeSong(f, dance);
        return (
          <button key={key} type="button" className={`mark-finding tone-${toneOf(f)}${key === open ? ' open' : ''}`} data-mark="finding" data-kind={f.kind}
            style={{ left: Math.max(7, toX(f.startMs)), '--length': `${whole ? 0 : Math.max(0, toX(f.endMs - f.startMs))}px` } as CSSProperties}
            title={`${findingTitle(f)} · ${findingWhen(f, dance)}`} aria-label={`${findingTitle(f)}, ${findingWhen(f, dance)}`}
            onPointerDown={e => e.stopPropagation()} onClick={() => onOpen(f)} />
        );
      })}
    </>
  );
}
