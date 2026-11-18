// This moment: what can be done to the selected dancer over the selected stretch (or, with none
// selected, a beat either side of the playhead): take touch-ups back, keep a foot or hand
// planted, and leave the stretch unscored.
import type { AnyKey, ContactControl, Dancer, Layer } from '../../../../../../packages/dance/format.ts';
import { DANCER_COLORS, beatMs, clock } from '../../core/format.ts';
import { useProject, useSession, useSongTime } from '../../core/hooks.ts';
import { Button, Panel, Segmented } from '../../core/ui.tsx';
import { useView, useViewStore } from '../../core/view.ts';
import { partWords } from './words.ts';

const PLANTS: readonly { control: ContactControl; label: string }[] = [
  { control: 'leftAnkle', label: 'Left foot' }, { control: 'rightAnkle', label: 'Right foot' },
  { control: 'leftWrist', label: 'Left hand' }, { control: 'rightWrist', label: 'Right hand' },
];
const PLANT_WORDS = Object.fromEntries(PLANTS.map(p => [p.control, p.label])) as Record<ContactControl, string>;
/** The layer touch-ups are kept on (packages/dance/ops.ts `fix`). */
export const touchUpLayer = (dancer: Dancer): Layer | null => dancer.layers.find((l, i) => i > 0 && l.id === 'fix') ?? null;
/** A key that moves something, as opposed to one holding the pose still either side of a touch-up. */
export const moves = (k: AnyKey) => Array.isArray(k.v) ? k.v.some(v => v !== 0) : k.v !== 0;
/**
 * The keys that make up the touch-ups felt in [a, b] or at `at` (the dancer's clock), per joint:
 * each moved moment whose ease in or out reaches there, and the still keys either side that no
 * remaining touch-up leans on. Clearing only what lies inside the stretch could strand a moved
 * key with nothing to ease it back, and the pose would stay moved for the rest of the song.
 */
function touchUpsIn(layer: Layer | null, a: number, b: number, at = a): { joint: string; times: number[] }[] {
  const out: { joint: string; times: number[] }[] = [];
  for (const [joint, keys] of Object.entries(layer?.channels ?? {})) {
    const drop = new Set<number>();
    keys.forEach((k, i) => {
      const from = keys[i - 1]?.t ?? -Infinity, to = keys[i + 1]?.t ?? Infinity;
      if (moves(k) && (from < b && to > a || from < at && to > at)) drop.add(i);
    });
    if (!drop.size) continue;
    const stays = (i: number) => i >= 0 && i < keys.length && moves(keys[i]) && !drop.has(i);
    keys.forEach((k, i) => { if (!moves(k) && (drop.has(i - 1) || drop.has(i + 1)) && !stays(i - 1) && !stays(i + 1)) drop.add(i); });
    out.push({ joint, times: [...drop].sort((x, y) => x - y).map(i => keys[i].t) });
  }
  return out;
}
const span = (startMs: number, endMs: number, offset: number) => `${clock(startMs + offset)} – ${clock(endMs + offset)}`;

export function Moment() {
  const session = useSession(), { dance } = useProject(), view = useView(), viewStore = useViewStore();
  const time = useSongTime(6);
  const index = Math.min(view.dancer, dance.dancers.length - 1), dancer = dance.dancers[index], offset = dancer.timeOffsetMs;
  const beat = beatMs(dance) ?? 500, selection = view.selection;
  /** The stretch in song time: the selection, or a beat either side of a moment. */
  const stretch = (at: number): [number, number] => selection ? [selection[0], selection[1]]
    : [Math.max(0, at - beat), Math.min(dance.song.durationMs, Math.max(0, at) + beat)];
  /** The same on the dancer's own clock, as edits take it; read when a button is pressed, so it's right while the song plays. */
  const local = (at = session.transport.timeMs()): [number, number] => { const [a, b] = stretch(at); return [Math.round(a - offset), Math.round(b - offset)]; };
  const [from, to] = stretch(time), [a, b] = local(time);
  // Touch-ups count as here when they're felt in the stretch or under the playhead.
  const touched = touchUpsIn(touchUpLayer(dancer), a, b, time - offset);
  const overlaps = (x: { startMs: number; endMs: number }) => x.endMs > a && x.startMs < b;
  const plants = dancer.contacts.filter(overlaps), unscored = dancer.exclusions.filter(overlaps), approved = dancer.approvals.filter(overlaps);
  const apply = (ops: unknown[], label: string) => void session.apply(ops, label);
  const undoTouchUps = () => {
    const [x, y] = local(), found = touchUpsIn(touchUpLayer(dancer), x, y, session.transport.timeMs() - offset);
    if (found.length) apply(found.map(f => ({ op: 'delete', dancer: dancer.id, layer: 'fix', controls: [f.joint], times: f.times })), 'undo the touch-ups');
  };
  return (
    <Panel title="This moment" className="moment-panel" aside={dance.dancers.length > 1 && (
      <Segmented label="Dancer" value={index} onChange={i => viewStore.set({ dancer: i })}
        options={dance.dancers.map((d, i) => ({ value: i, title: d.label, label: <><i className="dancer-dot" style={{ background: DANCER_COLORS[i % 4] }} />{i + 1}</> }))} />
    )}>
      <p className="moment-when" data-start={Math.round(from)} data-end={Math.round(to)}>
        <strong>{clock(from)} – {clock(to)}</strong>
        <span className="muted">{selection ? 'the selected stretch' : 'a beat either side of the playhead'}</span>
      </p>

      <div className="fix-group">
        <div className="button-row">
          <Button icon="undo" disabled={!touched.length} onClick={undoTouchUps}
            title={touched.length ? 'Take back the joints moved by hand here' : 'No joint has been moved by hand here'}>Undo touch-ups here</Button>
          {touched.length > 0 && <span className="muted">{touched.length === 1 ? '1 joint moved' : `${touched.length} joints moved`}</span>}
        </div>
      </div>

      <div className="fix-group">
        <span className="field-label">Keep a foot or hand planted</span>
        <div className="button-row">
          {PLANTS.map(p => {
            const taken = plants.some(c => c.control === p.control);
            return <Button key={p.control} disabled={taken} title={taken ? `The ${p.label.toLowerCase()} is already planted here` : `Hold the ${p.label.toLowerCase()} where it is when the stretch starts`}
              onClick={() => { const [start, end] = local(); apply([{ op: 'contact', dancer: dancer.id, control: p.control, start, end }], `plant the ${p.label.toLowerCase()}`); }}>{p.label}</Button>;
          })}
        </div>
        <span className="field-hint">It stays where it is at the start of the stretch, so it can't slide or drift.</span>
        {plants.length > 0 && (
          <ul className="mark-list">
            {plants.map(c => (
              <li key={c.id} data-plant={c.control}>
                <i className="mark-swatch plant" />
                <span><strong>{PLANT_WORDS[c.control]}</strong> planted</span>
                <button type="button" className="mark-when" title="Select this stretch" onClick={() => viewStore.set({ selection: [c.startMs + offset, c.endMs + offset] })}>{span(c.startMs, c.endMs, offset)}</button>
                <Button kind="quiet" icon="close" aria-label={`Let the ${PLANT_WORDS[c.control].toLowerCase()} go`} title="Let it move again"
                  onClick={() => apply([{ op: 'uncontact', dancer: dancer.id, id: c.id }], `let the ${PLANT_WORDS[c.control].toLowerCase()} go`)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="fix-group">
        <span className="field-label">Scoring</span>
        <div className="button-row">
          <Button title="Players aren't scored on this dancer over the stretch"
            onClick={() => { const [start, end] = local(); apply([{ op: 'exclude', dancer: dancer.id, start, end, reason: 'Left unscored' }], 'leave it unscored'); }}>Leave unscored</Button>
        </div>
        <span className="field-hint">For a part that can't be fixed or isn't meant to be followed: players get no points for it and lose none.</span>
        {(unscored.length > 0 || approved.length > 0) && (
          <ul className="mark-list">
            {unscored.map(x => (
              <li key={`x${x.id}`} data-unscored={x.id}>
                <i className="mark-swatch unscored" />
                <span><strong>Unscored</strong> {partWords(x.controls)}</span>
                <button type="button" className="mark-when" title="Select this stretch" onClick={() => viewStore.set({ selection: [x.startMs + offset, x.endMs + offset] })}>{span(x.startMs, x.endMs, offset)}</button>
                <Button kind="quiet" icon="close" aria-label="Score it again" title="Score it again" onClick={() => apply([{ op: 'include', dancer: dancer.id, id: x.id }], 'score it again')} />
              </li>
            ))}
            {approved.map(x => (
              <li key={`ok${x.id}`} data-approved={x.id}>
                <i className="mark-swatch approved" />
                <span><strong>Looks right</strong> {partWords(x.controls)}</span>
                <button type="button" className="mark-when" title="Select this stretch" onClick={() => viewStore.set({ selection: [x.startMs + offset, x.endMs + offset] })}>{span(x.startMs, x.endMs, offset)}</button>
                <Button kind="quiet" icon="close" aria-label="Take back the approval" title="Take it back: it goes unscored until it's looked at again"
                  onClick={() => apply([{ op: 'unapprove', dancer: dancer.id, id: x.id }], 'take back the approval')} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
