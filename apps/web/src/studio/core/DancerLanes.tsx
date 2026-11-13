// A timeline lane per dancer with its clips: recorded takes as solid blocks in the dancer's
// colour, linked repeats hatched. Clicking a lane's label picks the dancer; clicking a clip
// picks it (and the dancer), and selects its stretch of the song. Stations add their own marks
// over each lane with `extra`.
import type { ReactNode } from 'react';
import type { Clip } from '../../../../../packages/dance/format.ts';
import { DANCER_COLORS, clock } from './format.ts';
import { useProject } from './hooks.ts';
import { Lane, Span } from './Timeline.tsx';
import { Icon } from './ui.tsx';
import { useView, useViewStore } from './view.ts';

export interface DancerLanesProps {
  /** Drawn over each dancer's lane, above its clips (children of the lane, positioned in song time). */
  extra?: (dancer: number) => ReactNode;
  /** Shown beside each dancer's name. */
  aside?: (dancer: number) => ReactNode;
  height?: number;
  /** Called when a clip is double-clicked. */
  onOpenClip?: (dancer: number, clip: Clip) => void;
}
export function DancerLanes({ extra, aside, height = 44, onOpenClip }: DancerLanesProps) {
  const { shown: dance } = useProject(), view = useView(), store = useViewStore();
  return (
    <>
      {dance.dancers.map((dancer, i) => (
        <Lane key={dancer.id} label={<><i className="dancer-dot" style={{ background: DANCER_COLORS[i % 4] }} />{dancer.label}</>} aside={aside?.(i)} height={height}
          selected={view.dancer === i} onPick={() => store.set({ dancer: i })} className="dancer-lane" data-dancer={dancer.id}
          onPointerDown={e => { if (e.target === e.currentTarget) store.set({ dancer: i, clip: null }); }}>
          {dancer.clips.map(clip => {
            const picked = view.clip?.dancer === dancer.id && view.clip.id === clip.id;
            const from = clip.kind === 'ref' ? dance.dancers.find(d => d.id === clip.dancer) : null;
            return (
              <Span key={clip.id} start={clip.startMs + dancer.timeOffsetMs} end={clip.endMs + dancer.timeOffsetMs}
                className={`clip clip-${clip.kind}${picked ? ' picked' : ''}${clip.mirror ? ' mirrored' : ''}`} style={{ '--dancer': DANCER_COLORS[i % 4] } as React.CSSProperties}
                data-clip={clip.id} title={`${clip.label} · ${clock(clip.startMs)}–${clock(clip.endMs)}${clip.kind === 'ref' ? ` · follows ${from === dancer ? 'an earlier part' : from?.label ?? 'another dancer'}` : ''}${clip.mirror ? ' · mirrored' : ''}`}
                onPointerDown={e => { e.stopPropagation(); store.set({ dancer: i, clip: { dancer: dancer.id, id: clip.id }, selection: [clip.startMs + dancer.timeOffsetMs, clip.endMs + dancer.timeOffsetMs] }); }}
                onDoubleClick={() => onOpenClip?.(i, clip)}>
                <span className="clip-label">{clip.kind === 'ref' && <Icon name="link" size={12} />}{clip.mirror && <Icon name="mirror" size={12} />}{clip.label}</span>
              </Span>
            );
          })}
          {extra?.(i)}
        </Lane>
      ))}
    </>
  );
}
