// The right-hand panels: the selected dancer and control at the playhead (values to type,
// the key's shape), the dancer's contacts and layers, and the song's details.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createEvaluator } from '../evaluate.ts';
import { CONTACT_CONTROLS, POINTS, SCALARS, baseLayer, isMidJoint, isPointControl, roundTime } from '../format.ts';
import type { AnyKey, Control, Dance, Dancer, Ease, Interp } from '../format.ts';
import { STAGE_LIST } from '../../../packages/stages/catalog.ts';
import { beatAt } from '../time.ts';
import type { SongClock } from './clock.ts';
import { CONTROL_LABELS, controlLabel } from './labels.ts';
import type { Selection } from './VideoPane.tsx';

type Apply = (ops: unknown[], label: string) => void;
const LABELS = CONTROL_LABELS;
export { controlLabel };

/** A number field that applies on Enter or blur, not on every keystroke. */
function NumberField({ label, value, step = 0.001, digits = 4, onCommit, disabled }: { label: string; value: number; step?: number; digits?: number; onCommit(v: number): void; disabled?: boolean }) {
  const [text, setText] = useState(value.toFixed(digits));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(value.toFixed(digits)); }, [value, digits, editing]);
  const commit = () => {
    setEditing(false);
    const v = Number(text);
    if (Number.isFinite(v) && Math.abs(v - value) > 10 ** -(digits + 1)) onCommit(v);
    else setText(value.toFixed(digits));
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} value={text} disabled={disabled} aria-label={label}
        onFocus={() => setEditing(true)} onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setEditing(false); setText(value.toFixed(digits)); } }} />
    </label>
  );
}
function TextField({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit(v: string): void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field wide">
      <span>{label}</span>
      <input value={text} placeholder={placeholder} aria-label={label} onChange={e => setText(e.target.value)}
        onBlur={() => { if (text !== value) onCommit(text); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}
export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <section className="card"><header><h3>{title}</h3>{aside}</header>{children}</section>;
}

export function DancerPanel({ dance, dancer, clock, time, selection, onSelect, apply, hasTracking }:
  { dance: Dance; dancer: Dancer; clock: SongClock; time: number; selection: Selection; onSelect(s: Selection): void; apply: Apply; hasTracking: boolean }) {
  const local = roundTime(time - dancer.timeOffsetMs);
  const base = baseLayer(dancer).channels;
  const keyedHere = Object.values(base).some(keys => keys.some(k => Math.abs(k.t - local) < 0.5));
  return (
    <Section title={dancer.label} aside={<span className="pill" style={{ color: 'var(--accent)' }}>{dancer.id}</span>}>
      <div className="button-row">
        <button onClick={() => apply([{ op: 'pose', dancer: dancer.id, t: local }], 'key pose')} title="Key every control at the playhead (K)">Key pose</button>
        {hasTracking && <button onClick={() => apply([{ op: 'pose', dancer: dancer.id, t: local, from: 'tracking' }], 'pose from video')}
          title="Key every control from the tracked video at the playhead">Key from video</button>}
        {keyedHere && <button className="danger" onClick={() => apply([{ op: 'delete', dancer: dancer.id, t: local }], 'delete pose keys')}>Delete keys here</button>}
      </div>
      <div className="control-grid" role="listbox" aria-label="Controls">
        {[...POINTS, ...SCALARS].map(c => {
          const keys = base[c] ?? [];
          const here = keys.some(k => Math.abs(k.t - local) < 0.5);
          return (
            <button key={c} role="option" aria-selected={selection.control === c} className={`control ${selection.control === c ? 'active' : ''}`}
              onClick={() => onSelect({ dancer: dancer.id, control: c })} title={`${keys.length} keys${isMidJoint(c) && !keys.length ? ' (bends automatically)' : ''}`}>
              <span className={`dot ${here ? 'here' : keys.length ? 'keyed' : isMidJoint(c) ? 'auto' : ''}`} />{LABELS[c]}
            </button>
          );
        })}
      </div>
      <TimingFields dancer={dancer} apply={apply} />
      <p className="hint">{clock.playing ? 'Playing' : `At ${(time / 1000).toFixed(3)} s${beatAt(dance, time) === null ? '' : `, beat ${beatAt(dance, time)!.toFixed(2)}`}`}
        {' · '}dot: <span className="dot here" /> key here <span className="dot keyed" /> keyed <span className="dot auto" /> automatic</p>
    </Section>
  );
}
function TimingFields({ dancer, apply }: { dancer: Dancer; apply: Apply }) {
  return (
    <div className="fields">
      <TextField label="Name" value={dancer.label} onCommit={v => apply([{ op: 'dancer', dancer: dancer.id, label: v }], 'rename dancer')} />
      <NumberField label="Offset ms" value={dancer.timeOffsetMs} step={10} digits={0}
        onCommit={v => apply([{ op: 'dancer', dancer: dancer.id, timeOffsetMs: v }], 'shift dancer')} />
      <NumberField label="Home x" value={dancer.home[0]} onCommit={v => apply([{ op: 'dancer', dancer: dancer.id, home: [v, dancer.home[1]] }], 'move home')} />
      <NumberField label="Home y" value={dancer.home[1]} onCommit={v => apply([{ op: 'dancer', dancer: dancer.id, home: [dancer.home[0], v] }], 'move home')} />
    </div>
  );
}

export function ControlPanel({ dance, dancer, control, time, apply }: { dance: Dance; dancer: Dancer; control: Control; time: number; apply: Apply }) {
  const local = roundTime(time - dancer.timeOffsetMs);
  const rig = createEvaluator(dance, dancer, { additive: false }).rigAt(local);
  const keys = (baseLayer(dancer).channels[control] ?? []) as AnyKey[];
  const key = keys.find(k => Math.abs(k.t - local) < 0.5);
  const point = isPointControl(control);
  const set = (v: unknown) => apply([{ op: 'key', dancer: dancer.id, t: local, set: { [control]: v } }], `key ${control}`);
  const prev = [...keys].reverse().find(k => k.t < local - 0.5), next = keys.find(k => k.t > local + 0.5);
  const state = key ? 'Keyed here' : !keys.length ? isMidJoint(control) ? 'Bends automatically (no keys)' : 'Not keyed: neutral stance' : 'Between keys';
  return (
    <Section title={LABELS[control]} aside={<span className={`pill ${key ? 'here' : ''}`}>{state}</span>}>
      <div className="fields">
        {point ? <>
          <NumberField label="x" value={rig.points[control][0]} onCommit={v => set({ x: v })} />
          <NumberField label="y" value={rig.points[control][1]} onCommit={v => set({ y: v })} />
          <NumberField label="z (depth)" value={rig.points[control][2]} onCommit={v => set({ z: v })} />
        </> : <NumberField label="degrees" value={rig[control as 'turn']} step={1} digits={1} onCommit={v => set(v)} />}
        {control === 'head' && (['headYaw', 'headPitch', 'headRoll'] as const).map(a =>
          <NumberField key={a} label={LABELS[a]} value={rig[a]} step={1} digits={1} onCommit={v => apply([{ op: 'key', dancer: dancer.id, t: local, set: { [a]: v } }], `key ${a}`)} />)}
      </div>
      {key ? (
        <div className="fields">
          <label className="field"><span>Into next</span>
            <select aria-label="Interpolation" value={key.interp ?? 'smooth'} onChange={e => apply([{ op: 'interp', dancer: dancer.id, t: local, controls: [control], interp: e.target.value as Interp }], 'set interpolation')}>
              <option value="smooth">Smooth</option><option value="linear">Linear</option><option value="hold">Hold (step)</option>
            </select></label>
          <label className="field"><span>At the key</span>
            <select aria-label="Ease" value={key.ease ?? 'auto'} onChange={e => apply([{ op: 'interp', dancer: dancer.id, t: local, controls: [control], ease: e.target.value as Ease }], 'set ease')}>
              <option value="auto">Flow through</option><option value="stop">Settle (stop)</option><option value="sharp">Hit (sharp)</option>
            </select></label>
          <button className="danger" onClick={() => apply([{ op: 'delete', dancer: dancer.id, t: local, controls: [control] }], `delete ${control} key`)}>Delete key</button>
        </div>
      ) : (
        <div className="button-row">
          <button onClick={() => apply([{ op: 'pose', dancer: dancer.id, t: local, controls: [control] }], `key ${control}`)}>Key current value</button>
        </div>
      )}
      <p className="hint">{keys.length} keys{prev ? ` · previous ${(prev.t / 1000).toFixed(2)} s` : ''}{next ? ` · next ${(next.t / 1000).toFixed(2)} s` : ''}
        {isMidJoint(control) && ' · moves with its limb between keys'}</p>
    </Section>
  );
}

export function ContactsPanel({ dancer, time, selection, apply }: { dancer: Dancer; time: number; selection: Selection; apply: Apply }) {
  const local = roundTime(time - dancer.timeOffsetMs);
  const selected = (CONTACT_CONTROLS as readonly string[]).includes(selection.control ?? '') ? selection.control as typeof CONTACT_CONTROLS[number] : null;
  const [control, setControl] = useState<typeof CONTACT_CONTROLS[number]>(selected ?? 'leftAnkle');
  useEffect(() => { if (selected) setControl(selected); }, [selected]);
  const [length, setLength] = useState(500);
  return (
    <Section title="Planted feet and hands">
      {dancer.contacts.length ? (
        <ul className="list">
          {dancer.contacts.map(c => (
            <li key={c.id}><span>{LABELS[c.control]} {(c.startMs / 1000).toFixed(2)}–{(c.endMs / 1000).toFixed(2)} s</span>
              <button className="link danger" aria-label={`Remove contact ${c.id}`} onClick={() => apply([{ op: 'uncontact', dancer: dancer.id, id: c.id }], 'remove contact')}>Remove</button></li>
          ))}
        </ul>
      ) : <p className="hint">None. A planted foot stays put on the floor, without sliding.</p>}
      <div className="fields">
        <label className="field"><span>Plant</span>
          <select aria-label="Contact control" value={control} onChange={e => setControl(e.target.value as typeof control)}>
            {CONTACT_CONTROLS.map(c => <option key={c} value={c}>{LABELS[c]}</option>)}</select></label>
        <NumberField label="For ms" value={length} step={50} digits={0} onCommit={setLength} />
        <button onClick={() => apply([{ op: 'contact', dancer: dancer.id, control, start: local, end: local + length }], 'plant')}>Plant from here</button>
      </div>
      <p className="hint">From the playhead; the foot or hand stays where it is there.</p>
    </Section>
  );
}

/** A 0-1 slider that saves once, when it's let go, rather than on every step. */
function WeightSlider({ value, label, onCommit }: { value: number; label: string; onCommit(v: number): void }) {
  const [shown, setShown] = useState(value);
  const [held, setHeld] = useState(false);
  useEffect(() => { if (!held) setShown(value); }, [value, held]);
  const commit = () => { setHeld(false); if (Math.abs(shown - value) > 1e-9) onCommit(shown); };
  return <input type="range" min={0} max={1} step={0.05} value={shown} aria-label={label}
    onChange={e => { setHeld(true); setShown(Number(e.target.value)); }}
    onPointerUp={commit} onKeyUp={commit} onBlur={() => { if (held) commit(); }} />;
}
export function LayersPanel({ dancer, apply }: { dancer: Dancer; apply: Apply }) {
  return (
    <Section title="Layers" aside={<button className="link" onClick={() => apply([{ op: 'layer', dancer: dancer.id, action: 'add', label: 'Adjustments' }], 'add layer')}>Add</button>}>
      <ul className="list">
        {dancer.layers.map((layer, i) => (
          <li key={layer.id}>
            <span>{layer.label} <small>{i === 0 ? 'base' : `offsets · ${Object.keys(layer.channels).length} channels`}</small></span>
            {i > 0 && <span className="layer-tools">
              <WeightSlider value={layer.weight} label={`${layer.label} weight`}
                onCommit={weight => apply([{ op: 'layer', dancer: dancer.id, id: layer.id, weight }], 'layer weight')} />
              <input type="checkbox" checked={layer.enabled} aria-label={`${layer.label} on`}
                onChange={e => apply([{ op: 'layer', dancer: dancer.id, id: layer.id, enabled: e.target.checked }], 'toggle layer')} />
              <button className="link danger" onClick={() => apply([{ op: 'layer', dancer: dancer.id, id: layer.id, action: 'remove' }], 'remove layer')}>Remove</button>
            </span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SongPanel({ dance, apply }: { dance: Dance; apply: Apply }) {
  const s = dance.song;
  const set = (field: string, value: unknown) => apply([{ op: 'song', set: { [field]: value } }], `set ${field}`);
  return (
    <Section title="Song">
      <div className="fields">
        <TextField label="Title" value={s.title} onCommit={v => set('title', v)} />
        <TextField label="Artist" value={s.artist} onCommit={v => set('artist', v)} />
        <NumberField label="BPM" value={s.bpm ?? 0} step={1} digits={2} onCommit={v => set('bpm', v > 0 ? v : null)} />
        <NumberField label="Beat 1 at ms" value={s.beatOffsetMs} step={5} digits={0} onCommit={v => set('beatOffsetMs', v)} />
        <NumberField label="Plays from ms" value={s.playableStartMs} step={100} digits={0} onCommit={v => set('playableStartMs', v)} />
        <NumberField label="Plays to ms" value={s.playableEndMs} step={100} digits={0} onCommit={v => set('playableEndMs', v)} />
        <label className="field wide"><span>Stage</span>
          <select aria-label="Stage" value={s.stage} onChange={e => set('stage', e.target.value)}>
            {STAGE_LIST.map(stage => <option key={stage.id} value={stage.id}>{stage.id} · {stage.subtitle}</option>)}
          </select></label>
        <label className="field wide"><span>Difficulty</span>
          <select aria-label="Difficulty" value={s.difficulty} onChange={e => set('difficulty', e.target.value)}>
            <option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option>
          </select></label>
      </div>
      {dance.sources.video && <div className="fields">
        <NumberField label="Video starts at song ms" value={dance.sources.video.startMs} step={10} digits={0}
          onCommit={v => apply([{ op: 'video', startMs: v }], 'align video')} />
      </div>}
    </Section>
  );
}
