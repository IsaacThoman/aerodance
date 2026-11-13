// Station 3, fixing: after recording, the motion is mostly right. This is where the author goes
// through what needs a look (the camera lost the dancer, the tracker was unsure of an arm, a
// joint jumped, nothing was recorded for a stretch), decides each one, and touches up single
// poses by dragging joints, with the coach beside the picture showing every change at once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FindingAction } from '../../../../../../packages/dance/check.ts';
import { DancerLanes } from '../../core/DancerLanes.tsx';
import { needsAttention, useFindings } from '../../core/findings.ts';
import type { Finding } from '../../core/findings.ts';
import { useKeys, useProject, useSession } from '../../core/hooks.ts';
import { StationLayout } from '../../core/StationLayout.tsx';
import { Timeline } from '../../core/Timeline.tsx';
import { TransportBar } from '../../core/TransportBar.tsx';
import { Segmented } from '../../core/ui.tsx';
import Viewport from '../../core/Viewport.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { Inbox } from './Inbox.tsx';
import { LaneMarks } from './LaneMarks.tsx';
import { Moment } from './Moment.tsx';
import PoseEditor from './PoseEditor.tsx';
import { Reads } from './Reads.tsx';
import { findingKey, wholeSong } from './words.ts';
import './fix.css';

/** Going to a finding lands this long before it, so playing from there shows it arrive. */
const LEAD_MS = 300;

export default function FixStation() {
  const session = useSession(), { dance } = useProject(), view = useView(), viewStore = useViewStore();
  const result = useFindings();
  const { todo, notes } = useMemo(() => {
    const byTime = [...(result?.findings ?? [])].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return { todo: byTime.filter(needsAttention), notes: byTime.filter(f => !needsAttention(f)) };
  }, [result]);
  const [open, setOpen] = useState<string | null>(null);

  /** Opens a finding: its dancer, its stretch of the song selected, and the playhead just before it. */
  const goTo = useCallback((f: Finding) => {
    const { dance } = session.state, dancer = dance.dancers.findIndex(d => d.id === f.dancer), moment = !wholeSong(f, dance);
    setOpen(findingKey(f));
    viewStore.set({ ...(dancer >= 0 ? { dancer } : {}), ...(moment ? { selection: f.endMs - f.startMs >= 1 ? [f.startMs, f.endMs] : null } : {}) });
    if (moment) session.transport.seek(Math.max(0, f.startMs - LEAD_MS));
  }, [session, viewStore]);
  const go = (station: string) => { location.hash = `#/p/${encodeURIComponent(session.id)}/${station}`; };
  const record = (f: Finding) => {
    const dancer = dance.dancers.findIndex(d => d.id === f.dancer);
    viewStore.set({ ...(dancer >= 0 ? { dancer } : {}), ...(wholeSong(f, dance) ? {} : { selection: [f.startMs, f.endMs] }) });
    go('record');
  };

  // A decision clears its item; the next one in the song opens, as an inbox does.
  const decided = useRef<{ key: string; startMs: number; revision: number } | null>(null);
  const decide = (f: Finding, action: FindingAction) => {
    decided.current = { key: findingKey(f), startMs: f.startMs, revision: dance.revision };
    void session.apply(action.ops, action.label).then(done => { if (!done) decided.current = null; });
  };
  useEffect(() => {
    const d = decided.current;
    if (!d || !result || result.revision <= d.revision || result.revision !== dance.revision) return;
    decided.current = null;
    if (todo.some(f => findingKey(f) === d.key)) return;
    const next = todo.find(f => f.startMs >= d.startMs) ?? todo[0];
    if (next) goTo(next); else setOpen(null);
  }, [result, dance.revision, todo, goTo]);

  // , and . step to the previous and next item that needs a decision.
  useKeys(e => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== ',' && e.key !== '.') || !todo.length) return;
    e.preventDefault();
    const forward = e.key === '.', at = todo.findIndex(f => findingKey(f) === open), t = session.transport.timeMs() + LEAD_MS;
    const next = at >= 0 ? todo[(at + (forward ? 1 : -1) + todo.length) % todo.length]
      : forward ? todo.find(f => f.startMs >= t - 1) ?? todo[0] : todo.findLast(f => f.startMs < t - 1) ?? todo[todo.length - 1];
    goTo(next);
  });

  const marks = useCallback((dancer: number) => <LaneMarks dancer={dancer} findings={todo} open={open} onOpen={goTo} />, [todo, open, goTo]);
  return (
    <StationLayout wide
      stage={
        <div className="fix-stage">
          <div className="fix-panes">
            <PoseEditor />
            <Viewport view={view.look} mirror={view.mirror} focus={Math.min(view.dancer, dance.dancers.length - 1)}>
              <div className="viewport-chip coach-chip">Coach</div>
              <div className="viewport-tools">
                <Segmented label="Coach view" value={view.look} onChange={look => viewStore.set({ look })}
                  options={[{ value: 'floor', label: 'Practice floor' }, { value: 'stage', label: 'The stage', title: 'The song\'s stage, as the game shows it' }]} />
              </div>
            </Viewport>
          </div>
        </div>
      }
      side={
        <>
          <Inbox dance={dance} todo={result ? todo : null} notes={notes} checking={result !== null && result.revision !== dance.revision} open={open}
            onOpen={goTo} onClose={() => setOpen(null)} onDecide={decide} onRecord={record} onPlaytest={() => go('playtest')} />
          <Moment />
          <Reads />
        </>
      }
      bar={<TransportBar />}
      timeline={<Timeline><DancerLanes extra={marks} height={48} /></Timeline>}
    />
  );
}
