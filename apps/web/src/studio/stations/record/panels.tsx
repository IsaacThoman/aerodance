// The Record station's quieter panels: the takes of the selected stretch, having a stretch
// repeat an earlier part or follow another dancer, and the part picked in the timeline.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { TakeSource } from '../../../../../../packages/dance/format.ts';
import { applyOps } from '../../../../../../packages/dance/ops.ts';
import { measureTake } from '../../../../../../packages/dance/takes.ts';
import { DANCER_COLORS, ago, clock } from '../../core/format.ts';
import { useProject, useSession, useSongTime } from '../../core/hooks.ts';
import { Button, Dialog, Icon, Meter, Panel } from '../../core/ui.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { HANDLE_MS, alignedStart, hasMotion, overlap, placement, takeSpan, trackedShare, whereLabel } from './stretch.ts';
import type { Stretch } from './stretch.ts';

/** A dancer's name beside its colour. */
export function DancerTag({ index, label }: { index: number; label: string }) {
  return <span className="rec-tag"><i className="dancer-dot" style={{ background: DANCER_COLORS[index % 4] }} />{label}</span>;
}

/** The takes that overlap the stretch, newest first: use one, or delete it. */
export function TakesPanel({ stretch, placeFor }: { stretch: Stretch; /** The dancers (by index) a take's people go to, in the take's order. */ placeFor(take: TakeSource): number[] }) {
  const session = useSession(), { dance, takes } = useProject();
  const [deleting, setDeleting] = useState<TakeSource | null>(null);
  const list = useMemo(() => dance.sources.takes.filter(t => stretch.whole || overlap(takeSpan(dance, t), stretch.range) > 250).reverse(), [dance, stretch]);
  const tracked = useMemo(() => new Map(dance.sources.takes.map(t => { const data = takes(t.id); return [t.id, data ? trackedShare(data) : null] as const; })), [dance.sources.takes, takes]);
  const users = (take: TakeSource) => dance.dancers.filter(d => d.clips.some(c => c.kind === 'take' && c.take === take.id));
  /** Where the take would go: the part of it inside the stretch. */
  const span = (take: TakeSource) => placement(dance, take, stretch.whole ? null : stretch.range);
  /** Whether the take is already what its dancers do there. */
  const current = (take: TakeSource) => {
    const [a, b] = span(take);
    return placeFor(take).every((d, slot) => { const dancer = dance.dancers[d], o = dancer.timeOffsetMs;
      return dancer.clips.some(c => c.kind === 'take' && c.take === take.id && c.slot === slot && c.startMs + o <= a + 300 && c.endMs + o >= b - 300); });
  };
  const use = (take: TakeSource) => {
    const data = takes(take.id), [a, b] = span(take);
    // Motion tracked from the video goes back where it was filmed (while the dance is still the video's shape).
    const filmed = take.origin === 'video' && Math.abs(take.width / take.height - dance.frame.width / dance.frame.height) < 1e-3;
    const ops = placeFor(take).flatMap((d, slot) => { const dancer = dance.dancers[d];
      return data && measureTake(data, slot) ? [{ op: 'clip', dancer: dancer.id, take: take.id, slot, start: a - dancer.timeOffsetMs, end: b - dancer.timeOffsetMs, ...(filmed ? { place: 'frame' } : {}) }] : []; });
    if (!ops.length) return session.fail('The camera never saw anyone clearly in that take, so it can\'t be used.');
    void session.apply(ops, `use ${take.label}`);
  };
  const remove = (take: TakeSource, force: boolean) => { setDeleting(null); void session.apply([{ op: 'take', action: 'remove', id: take.id, ...(force ? { force: true } : {}) }], `delete ${take.label}`); };
  return (
    <>
      <Panel title="Takes" aside={<span className="muted">{stretch.whole ? 'all of them' : `of ${stretch.name}`}</span>}>
        {!list.length && <p className="muted">{dance.sources.takes.length ? 'No takes of this part yet.' : 'Nothing recorded yet.'} Each time through while recording is kept here as a take, and the newest one goes into the dance.</p>}
        {list.length > 0 && (
          <ul className="rec-takes" data-takes={list.length}>
            {list.map(take => {
              const share = tracked.get(take.id) ?? null, by = users(take), inUse = by.length > 0, to = placeFor(take).map(d => dance.dancers[d].label).join(' and ');
              return (
                <li key={take.id} className={inUse ? 'in-use' : ''} data-take={take.id}>
                  <div className="rec-take-name">
                    <strong title={`${take.label} · recorded ${ago(take.createdAt)}${take.slots > 1 ? ` · ${take.slots} people` : ''}`}>{take.label}</strong>
                    <Button kind="quiet" icon="trash" aria-label={`Delete ${take.label}`} title="Delete this take" onClick={() => inUse ? setDeleting(take) : remove(take, false)} />
                  </div>
                  <div className="rec-take-facts">
                    <span>{clock(take.endMs - take.startMs, false)}</span>
                    {share !== null && (
                      <span className="rec-seen" title={`The camera could see ${take.slots > 1 ? 'everyone' : 'the dancer'} for ${Math.round(share * 100)}% of this take`}>
                        <Icon name="eye" size={13} /><Meter value={share} tone={share >= 0.9 ? 'good' : share < 0.6 ? 'warning' : 'accent'} label="How much of the take the camera could see" />{Math.round(share * 100)}%
                      </span>
                    )}
                    {inUse && <span className="rec-mark" title={`${by.map(d => d.label).join(' and ')} ${by.length > 1 ? 'dance' : 'dances'} this take`}><Icon name="check" size={12} />In use{dance.dancers.length > 1 && by.map(d => <i key={d.id} className="dancer-dot" style={{ background: DANCER_COLORS[dance.dancers.indexOf(d) % 4] }} />)}</span>}
                    {!current(take) && <Button onClick={() => use(take)} title={`Put this take on ${to}${stretch.whole ? '' : ` for ${stretch.name}`}`}>Use this one</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {deleting && (
        <Dialog title="Delete a take that's in use?" onClose={() => setDeleting(null)}
          actions={<><Button onClick={() => setDeleting(null)}>Keep it</Button><Button kind="danger" onClick={() => remove(deleting, true)}>Delete</Button></>}>
          <p>{users(deleting).map(d => d.label).join(' and ')} {users(deleting).length > 1 ? 'dance' : 'dances'} “{deleting.label}”. Deleting it leaves that part of the dance empty. Undo brings it back.</p>
        </Dialog>
      )}
    </>
  );
}

/** Instead of dancing the stretch: repeat another part of the same dancer, or follow another dancer. Both stay linked. */
export function LinkPanel({ stretch }: { stretch: Stretch }) {
  const session = useSession(), { dance } = useProject(), view = useView();
  const index = Math.min(view.dancer, dance.dancers.length - 1), dancer = dance.dancers[index];
  const [from, setFrom] = useState(''), [leader, setLeader] = useState(''), [mirror, setMirror] = useState(true);
  const sections = dance.phrases.filter(p => overlap([p.startMs, p.endMs], stretch.range) < 1);
  const others = dance.dancers.filter(d => d !== dancer);
  const danced = (p: { startMs: number; endMs: number }) => hasMotion(dancer, [p.startMs, p.endMs]);
  // Offered first: the same part earlier in the song, if it has been danced.
  const source = sections.find(p => p.id === from) ?? sections.find(p => p.label === stretch.name && danced(p)) ?? sections.find(danced) ?? sections[0];
  const lead = others.find(d => d.id === leader) ?? others[0];
  /** Saves a link, saying plainly why not when two parts would end up copying each other. */
  const link = (op: Record<string, unknown>, label: string) => {
    try { applyOps(dance, [op], { takes: session.state.takes }); }
    catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return session.fail(/loop of linked/.test(text) ? 'Those two parts would be copying each other. One of them has to be danced.' : text);
    }
    void session.apply([op], label);
  };
  // Like a take, a linked part overhangs its stretch a moment either side, to blend with its neighbours.
  const o = dancer.timeOffsetMs, a = Math.max(0, stretch.range[0] - HANDLE_MS), b = Math.min(dance.song.durationMs, stretch.range[1] + HANDLE_MS);
  const repeat = () => {
    // A repeat can't overlap the part it copies. Right beside it there is no room to overhang, so
    // the two meet exactly at the section line instead.
    const [r0, r1] = stretch.range, before = source.endMs <= r0 + 1, after = source.startMs >= r1 - 1;
    const beside = before && r0 - source.endMs < HANDLE_MS * 2 || after && source.startMs - r1 < HANDLE_MS * 2;
    const from = beside ? r0 : a, to = beside ? r1 : b, pad = beside ? 0 : HANDLE_MS;
    let start = alignedStart(dance, source.startMs, r0) - (r0 - from);
    if (after) start = Math.max(start, to);
    let length = Math.min(to - from, source.endMs + pad - start);
    if (before) length = Math.min(length, from - start);
    if (!(length > 0)) return session.fail('That part is too close to this one to repeat here.');
    link({ op: 'clip', dancer: dancer.id, ref: { dancer: dancer.id, range: [start - o, start - o + length] }, start: from - o, label: `Repeats ${source.label}` }, `repeat ${source.label}`);
  };
  const follow = () => link({ op: 'clip', dancer: dancer.id, ref: { dancer: lead.id, range: [a - lead.timeOffsetMs, b - lead.timeOffsetMs] }, start: a - o, ...(mirror ? { mirror: true } : {}) }, `follow ${lead.label}`);
  return (
    <Panel title="Repeat or follow" aside={!stretch.whole && dance.dancers.length > 1 && <DancerTag index={index} label={dancer.label} />}>
      {stretch.whole ? <p className="muted">A part doesn't have to be danced again: it can repeat an earlier part{dance.dancers.length > 1 ? ', or follow another dancer' : ''}. Click a section in the timeline to choose where.</p> : (
        <>
          <div className="field">
            <span className="field-label">Repeat an earlier part here</span>
            {sections.length ? (
              <div className="rec-pick">
                <select aria-label="The part to repeat" value={source.id} onChange={e => setFrom(e.target.value)}>
                  {sections.map(p => <option key={p.id} value={p.id}>{p.label} · {whereLabel(dance, [p.startMs, p.endMs])}{danced(p) ? '' : ' · not danced'}</option>)}
                </select>
                <Button icon="link" onClick={repeat} title={`${dancer.label} does in ${stretch.name} what they do in ${source.label} (${whereLabel(dance, [source.startMs, source.endMs])})`}>Repeat it</Button>
              </div>
            ) : <span className="field-hint">The song has no other sections yet. Split it into sections in Song.</span>}
          </div>
          {others.length > 0 && (
            <div className="field">
              <span className="field-label">Follow another dancer</span>
              <div className="rec-pick">
                <select aria-label="The dancer to follow" value={lead.id} onChange={e => setLeader(e.target.value)}>
                  {others.map(d => <option key={d.id} value={d.id}>{d.label}{hasMotion(d, stretch.range) ? '' : ' · not danced'}</option>)}
                </select>
                <Button icon="mirror" on={mirror} onClick={() => setMirror(!mirror)} title="Swap left and right, like a reflection of the dancer they follow">Mirror</Button>
                <Button icon="link" onClick={follow} title={`${dancer.label} does what ${lead.label} does in ${stretch.name}${mirror ? ', mirrored' : ''}`}>Follow</Button>
              </div>
            </div>
          )}
          <p className="field-hint">Linked parts update when their source changes.</p>
        </>
      )}
    </Panel>
  );
}

/** The part picked in the timeline: remove it, split it, mirror it, or shift its timing a touch. */
export function PickedPanel() {
  const session = useSession(), { dance } = useProject(), view = useView(), viewStore = useViewStore();
  const time = useSongTime(8), panel = useRef<HTMLDivElement>(null);
  const index = dance.dancers.findIndex(d => d.id === view.clip?.dancer), dancer = dance.dancers[index], clip = dancer?.clips.find(c => c.id === view.clip?.id);
  // It appears at the foot of the column: bring it into view when a part is picked.
  const found = !!clip, picked = view.clip?.id;
  useEffect(() => { if (found) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [found, picked]);
  if (!dancer || !clip) return null;
  const o = dancer.timeOffsetMs, t = time - o, inside = t > clip.startMs + 1 && t < clip.endMs - 1;
  const change = (fields: Record<string, unknown>, label: string) => void session.apply([{ op: 'clip', dancer: dancer.id, id: clip.id, ...fields }], label);
  const source = clip.kind === 'ref' ? dance.dancers.find(d => d.id === clip.dancer) : null;
  const take = clip.kind === 'take' ? dance.sources.takes.find(k => k.id === clip.take) : null;
  // How far the part has been shifted from where it was danced (or from the dancer it follows).
  const shift = clip.rate !== 1 ? null : clip.kind === 'take' ? (take?.clock === 'song' ? Math.round(clip.startMs + o - clip.offsetMs) : null)
    : source && source !== dancer ? Math.round(clip.startMs + o - clip.fromMs - source.timeOffsetMs) : null;
  const against = take ? 'you danced it' : `${source?.label} does it`;
  return (
    <div ref={panel} className="rec-picked" data-picked={clip.id} data-start={clip.startMs} data-end={clip.endMs} data-mirror={clip.mirror}>
      <Panel title="Picked part" aside={<Button kind="quiet" icon="close" aria-label="Done with this part" title="Done" onClick={() => viewStore.set({ clip: null })} />}>
        <div className="rec-picked-name" style={{ '--dancer': DANCER_COLORS[index % 4] } as CSSProperties}>
          <strong>{clip.label}</strong>
          <span className="muted">
            <DancerTag index={index} label={dancer.label} /> · {whereLabel(dance, [clip.startMs + o, clip.endMs + o])}
            {clip.kind === 'ref' && <> · {source === dancer ? `repeats ${whereLabel(dance, [clip.fromMs + o, clip.fromMs + o + (clip.endMs - clip.startMs) * clip.rate])}` : `follows ${source?.label ?? 'another dancer'}`}</>}
          </span>
        </div>
        <div className="button-row">
          <Button icon="scissors" disabled={!inside} title={inside ? 'Cut this part in two at the playhead' : 'Move the playhead inside this part to split it there'}
            onClick={() => change({ action: 'split', t: Math.round(t) }, `split ${clip.label}`)}>Split at the playhead</Button>
          <Button icon="mirror" on={clip.mirror} title="Swap left and right" onClick={() => change({ action: 'update', mirror: !clip.mirror }, clip.mirror ? `stop mirroring ${clip.label}` : `mirror ${clip.label}`)}>Mirror</Button>
        </div>
        <div className="field">
          <span className="field-label">Timing</span>
          <div className="button-row">
            <Button onClick={() => change({ action: 'update', slip: -20 }, `move ${clip.label} earlier`)} title="Everything in this part happens 20 ms sooner">◀ 20 ms earlier</Button>
            <Button onClick={() => change({ action: 'update', slip: 20 }, `move ${clip.label} later`)} title="Everything in this part happens 20 ms later">20 ms later ▶</Button>
          </div>
          {shift !== null && <span className="field-hint" data-shift={shift}>{shift === 0 ? `Plays exactly as ${against}.` : `Plays ${Math.abs(shift)} ms ${shift > 0 ? 'later' : 'earlier'} than ${against}.`}</span>}
        </div>
        <div className="button-row">
          <Button kind="danger" icon="trash" title={take ? 'Take this part out of the dance (the take stays in Takes)' : 'Take this part out of the dance'}
            onClick={() => { change({ action: 'remove' }, `remove ${clip.label}`); viewStore.set({ clip: null }); }}>Remove</Button>
        </div>
      </Panel>
    </div>
  );
}
