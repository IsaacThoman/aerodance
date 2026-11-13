// The inbox: what the checker found, in song order, to go through one at a time. The open item
// says what's wrong in a sentence and offers the decisions that settle it.
import { useEffect, useRef } from 'react';
import type { Dance } from '../../../../../../packages/dance/format.ts';
import type { FindingAction } from '../../../../../../packages/dance/check.ts';
import type { Finding } from '../../core/findings.ts';
import { DANCER_COLORS } from '../../core/format.ts';
import { Button, Empty, Icon, Panel } from '../../core/ui.tsx';
import { findingJoint, findingKey, findingStory, findingTitle, findingWhen } from './words.ts';

/** How loudly a finding is shown: something wrong, something to decide, or a note. */
export const toneOf = (f: Finding) => f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : f.kind === 'unsure-tracking' ? 'unsure' : 'note';
/** Findings settled by dancing the part (again), and what the button that goes there says. */
const RECORD: Readonly<Record<string, string>> = { 'tracking-lost': 'Record this part again', 'no-motion': 'Record this part again', 'no-keys': 'Record this dancer', 'missing-take': 'Record this part again' };

export interface InboxProps {
  dance: Dance;
  /** Needing a decision, and notes, each in song order; null while they're first worked out. */
  todo: Finding[] | null; notes: Finding[];
  /** The list is from before the last edit and is being worked out again. */
  checking: boolean;
  open: string | null;
  onOpen(finding: Finding): void;
  onClose(): void;
  onDecide(finding: Finding, action: FindingAction): void;
  onRecord(finding: Finding): void;
  onPlaytest(): void;
}
export function Inbox({ dance, todo, notes, checking, open, onOpen, onClose, onDecide, onRecord, onPlaytest }: InboxProps) {
  const several = dance.dancers.length > 1, opened = useRef<HTMLLIElement>(null);
  // Opened from the timeline or the keyboard, an item may be off screen.
  useEffect(() => { opened.current?.scrollIntoView({ block: 'nearest' }); }, [open]);
  const item = (f: Finding) => {
    const key = findingKey(f), isOpen = key === open, tone = toneOf(f), joint = findingJoint(f);
    const index = dance.dancers.findIndex(d => d.id === f.dancer), record = RECORD[f.kind];
    return (
      <li key={key} ref={isOpen ? opened : undefined} className={`inbox-item tone-${tone}${isOpen ? ' open' : ''}`} data-kind={f.kind} data-start={f.startMs}>
        <button type="button" className="inbox-row" aria-expanded={isOpen} onClick={() => isOpen ? onClose() : onOpen(f)}>
          <span className="inbox-icon"><Icon name={tone === 'error' || tone === 'warning' ? 'warning' : 'eye'} size={15} /></span>
          <span className="inbox-text">
            <strong>{findingTitle(f)}</strong>
            <small>
              {several && index >= 0 && <><i className="dancer-dot" style={{ background: DANCER_COLORS[index % 4] }} />{dance.dancers[index].label} · </>}
              {joint && `${joint} · `}{findingWhen(f, dance)}
            </small>
          </span>
          <span className="inbox-chevron"><Icon name="next" size={14} /></span>
        </button>
        {isOpen && (
          <div className="inbox-body">
            <p>{findingStory(f, dance)}</p>
            {(record || f.actions?.length) && (
              <div className="button-row">
                {record && <Button kind="primary" icon="record" onClick={() => onRecord(f)}>{record}</Button>}
                {f.actions?.map((action, i) => <Button key={action.label} kind={!record && i === 0 ? 'primary' : 'default'} onClick={() => onDecide(f, action)}>{action.label}</Button>)}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <Panel title="To look at" className="inbox-panel" aside={todo && todo.length > 0 && <span className={`badge${checking ? ' checking' : ''}`} aria-label={`${todo.length} to decide`}>{todo.length}</span>}>
      <div className="inbox-state" data-ready={todo !== null && !checking} data-items={todo?.length ?? ''} data-notes={notes.length} data-open={open ?? ''}>
        {!todo && <p className="muted">Checking…</p>}
        {todo && todo.length === 0 && (
          <Empty icon="check" title="Nothing left to look at" action={<Button kind="primary" icon="game" onClick={onPlaytest}>Try it in Playtest</Button>}>
            Everything that needed a decision has one. Touch up any pose you like, or go and dance it.
          </Empty>
        )}
        {todo && todo.length > 0 && <ul className="inbox">{todo.map(item)}</ul>}
        {todo && notes.length > 0 && (
          <details className="inbox-notes" open={notes.some(f => findingKey(f) === open) || undefined}>
            <summary>Notes <span className="muted">· {notes.length} that need no decision</span></summary>
            <ul className="inbox">{notes.map(item)}</ul>
          </details>
        )}
      </div>
    </Panel>
  );
}
