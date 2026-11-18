// How it reads: the selected dancer's style. The glass character has no elbows or knees, so a
// move can be pushed further than it was danced to read on screen; the recording stays as it is.
import { useRef } from 'react';
import { STYLE_FIELDS, STYLE_LIMITS } from '../../../../../../packages/dance/format.ts';
import type { Style } from '../../../../../../packages/dance/format.ts';
import { useLatest, useProject, useSession } from '../../core/hooks.ts';
import { Button, Panel } from '../../core/ui.tsx';
import { useView } from '../../core/view.ts';

const WORDS: Readonly<Record<keyof Style, readonly [string, string]>> = {
  reach: ['Reach', 'how far the hands travel'],
  bounce: ['Bounce', 'how deep the body dips on the beat'],
  sway: ['Sway', 'how far the hips swing side to side'],
  lean: ['Lean', 'how far the body tips over'],
  turn: ['Turn', 'how much the body twists'],
  head: ['Head', 'how much the head looks and tilts'],
  lift: ['Lift', 'how high a stepping foot comes up'],
};
const STEP = 0.05;

export function Reads() {
  const session = useSession(), { dance, shown } = useProject(), view = useView();
  const index = Math.min(view.dancer, dance.dancers.length - 1), id = dance.dancers[index].id;
  // The sliders show the dance as previewed, so a thumb stays where it's dragged until it's saved.
  const style = shown.dancers[index]?.style ?? null, saved = dance.dancers[index].style ?? null;
  const sliding = useRef<{ field: keyof Style; value: number } | null>(null);
  const settle = () => {
    const s = sliding.current;
    if (!s) return;
    sliding.current = null;
    if (s.value === (saved?.[s.field] ?? 1)) session.preview(null);
    else void session.apply([{ op: 'dancer', dancer: id, style: { [s.field]: s.value } }], `change the ${WORDS[s.field][0].toLowerCase()}`);
  };
  const settled = useLatest(settle);
  const slide = (field: keyof Style, value: number) => {
    // A thumb let go of outside the slider still ends the slide.
    if (!sliding.current) window.addEventListener('pointerup', () => settled.current(), { once: true, capture: true });
    sliding.current = { field, value };
    session.preview([{ op: 'dancer', dancer: id, style: { [field]: value } }]);
  };
  const plain = !saved || STYLE_FIELDS.every(f => saved[f] === 1);
  return (
    <Panel title="How it reads" className="reads-panel" aside={<>
      {dance.dancers.length > 1 && <span className="muted">{dance.dancers[index].label}</span>}
      <Button disabled={plain} title="Play every move exactly as it was danced" onClick={() => void session.apply([{ op: 'dancer', dancer: id, style: null }], 'play it as danced')}>As danced</Button>
    </>}>
      <p className="field-hint">The character has no elbows or knees, so a move can be pushed further to read. Watch the coach as you slide; 1× leaves a move as danced.</p>
      <div className="reads" data-style={JSON.stringify(saved)}>
        {STYLE_FIELDS.map(field => {
          const [low, high] = STYLE_LIMITS[field], value = style?.[field] ?? 1, [name, hint] = WORDS[field];
          return (
            <label key={field} className={`read${value !== 1 ? ' changed' : ''}`}>
              <span className="read-name"><strong>{name}</strong> {hint}</span>
              <output>{value.toFixed(2).replace(/0$/, '')}×</output>
              <input type="range" min={low} max={high} step={STEP} value={value} list="reads-as-danced" data-style={field} aria-label={`${name}: ${hint}`}
                onChange={e => slide(field, Number(e.target.value))} onKeyUp={settle} onBlur={settle} />
            </label>
          );
        })}
        <datalist id="reads-as-danced"><option value="1" /></datalist>
      </div>
    </Panel>
  );
}
