// The Studio's building blocks: buttons, panels, fields and icons in the game's glassy look.
// Stations compose these instead of styling their own controls (studio.css has the rest).
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const PATHS = {
  play: 'M7 4.5v15l12-7.5z', pause: 'M6 4.5h4v15H6zM14 4.5h4v15h-4z', stop: 'M6 6h12v12H6z',
  record: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  loop: 'M17 3l4 4-4 4V8H8a3 3 0 0 0-3 3v1H3v-1a5 5 0 0 1 5-5h9zM7 21l-4-4 4-4v3h9a3 3 0 0 0 3-3v-1h2v1a5 5 0 0 1-5 5H7z',
  undo: 'M9 5L3 11l6 6v-4h5a4 4 0 0 1 0 8h-2v2h2a6 6 0 0 0 0-12H9z', redo: 'M15 5l6 6-6 6v-4h-5a4 4 0 0 0 0 8h2v2h-2a6 6 0 0 1 0-12h5z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z', close: 'M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
  check: 'M9.5 16.2L5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z', warning: 'M12 3L2 20h20zM11 10h2v5h-2zM11 16.5h2v2h-2z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z', music: 'M9 4v11.2A3.5 3.5 0 1 0 11 18V8h8v5.2A3.5 3.5 0 1 0 21 16V4z',
  camera: 'M9 4l-1.5 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.5L15 4zM12 9a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  video: 'M3 6h12a1 1 0 0 1 1 1v3l5-3v10l-5-3v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',
  link: 'M10.6 13.4a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.1 1.2 1.4 1.4 1.1-1.1a2 2 0 0 1 2.9 2.8l-3 3a2 2 0 0 1-2.9 0zM13.4 10.6a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.1-1.2-1.4-1.4-1.1 1.1a2 2 0 0 1-2.9-2.8l3-3a2 2 0 0 1 2.9 0z',
  mirror: 'M11 2h2v20h-2zM9 6v12H3zM15 6l6 12h-6z', scissors: 'M9.6 7.6A3.5 3.5 0 1 0 7.6 9.6L10 12l-2.4 2.4a3.5 3.5 0 1 0 2 2L12 14l7 7h3v-1L9.6 7.6zM6 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM19 3l-6 6 2 2 7-7V3z',
  download: 'M11 3h2v9l3.5-3.5 1.4 1.4L12 15.8 6.1 9.9l1.4-1.4L11 12zM4 18h16v2H4z', upload: 'M11 16h2V7l3.5 3.5 1.4-1.4L12 3.2 6.1 9.1l1.4 1.4L11 7zM4 18h16v2H4z',
  send: 'M3 4l19 8-19 8 3-8zM6.7 11h8v2h-8z', tv: 'M3 5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6l1 2H8l1-2H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 7v9h16V7z',
  back: 'M14.6 5L16 6.4 10.4 12l5.6 5.6-1.4 1.4-7-7z', next: 'M9.4 5L8 6.4l5.6 5.6L8 17.6 9.4 19l7-7z',
  metronome: 'M9 2h6l4 20H5zM11 6l-1.8 9h5.6L13 6zM12 9l5-4 1.2 1.6-5.3 4.2z', person: 'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0z',
  eye: 'M12 5c5 0 9 4.5 10 7-1 2.500-5 7-10 7S3 14.500 2 12c1-2.500 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', sparkle: 'M12 2l2.200 6.800L21 11l-6.800 2.200L12 20l-2.200-6.800L3 11l6.800-2.200zM19 16l.900 2.100L22 19l-2.100.900L19 22l-.900-2.100L16 19l2.100-.900z',
  folder: 'M3 5h7l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', game: 'M7 7h10a5 5 0 0 1 5 5v2a4 4 0 0 1-7 2.600L14 15h-4l-1 1.600A4 4 0 0 1 2 14v-2a5 5 0 0 1 5-5zm0 3v2H5v2h2v2h2v-2h2v-2H9v-2zm9 1a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3z',
} as const;
export type IconName = keyof typeof PATHS;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="icon-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d={PATHS[name]} /></svg>;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: the one thing to do next. danger: removes something. quiet: no chrome until hovered. */
  kind?: 'default' | 'primary' | 'danger' | 'quiet';
  icon?: IconName;
  /** Pressed (a toggle that is on). */
  on?: boolean;
  /** Bigger, for a screen's main action. */
  big?: boolean;
}
export function Button({ kind = 'default', icon, on, big, className = '', children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${kind}${on ? ' on' : ''}${big ? ' big' : ''}${children ? '' : ' icon-only'} ${className}`} aria-pressed={on === undefined ? undefined : on} {...rest}>
      {icon && <Icon name={icon} size={big ? 20 : 16} />}{children}
    </button>
  );
}
/** A glass card: an optional title row with controls on its right, then its content. */
export function Panel({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || aside) && <header className="panel-head">{title && <h2>{title}</h2>}{aside && <div className="panel-aside">{aside}</div>}</header>}
      {children}
    </section>
  );
}
/** A labelled control; `hint` explains it in a line beneath. */
export function Field({ label, hint, children, row = false }: { label: ReactNode; hint?: ReactNode; children: ReactNode; row?: boolean }) {
  return <label className={`field${row ? ' row' : ''}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
/** One choice of a few, as a row of buttons. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: ReactNode; title?: string }[]; onChange(value: T): void; label?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}
/** A message with nothing else to show yet: what this is for and the one thing to do. */
export function Empty({ icon, title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty">{icon && <div className="empty-icon"><Icon name={icon} size={30} /></div>}<h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
/** A coloured note: info, a warning, or something that went wrong. */
export function Note({ kind = 'info', children, action }: { kind?: 'info' | 'warning' | 'error' | 'good'; children: ReactNode; action?: ReactNode }) {
  return <div className={`note note-${kind}`} role={kind === 'error' ? 'alert' : 'status'}><span>{children}</span>{action}</div>;
}
/** A modal dialog over the whole page (wherever it's rendered from); Escape or the backdrop closes it. */
export function Dialog({ title, children, onClose, actions }: { title: ReactNode; children: ReactNode; onClose(): void; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button.btn-primary')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // On the page's body: inside a frosted panel, the panel's blur would confine it to the panel.
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog panel" role="dialog" aria-modal="true" ref={ref}>
        <header className="panel-head"><h2>{title}</h2><Button kind="quiet" icon="close" aria-label="Close" onClick={onClose} /></header>
        <div className="dialog-body">{children}</div>
        {actions && <footer className="dialog-actions">{actions}</footer>}
      </div>
    </div>, document.body);
}
/** 0 to 1 as a bar. */
export function Meter({ value, label, tone = 'accent' }: { value: number; label?: string; tone?: 'accent' | 'good' | 'warning' }) {
  return <div className={`meter meter-${tone}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>;
}
/** A file picker behind a button. */
export function FileButton({ accept, onFile, children, ...rest }: Omit<ButtonProps, 'onClick'> & { accept: string; onFile(file: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button {...rest} onClick={() => input.current?.click()}>{children}</Button>
      <input ref={input} type="file" accept={accept} hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onFile(file); }} />
    </>
  );
}
