// React bindings for the Studio's core objects.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { createEvaluator } from '../../../../../packages/dance/evaluate.ts';
import type { DancerEvaluator } from '../../../../../packages/dance/evaluate.ts';
import { previewCalibrations } from '../../../../../packages/dance/compile.ts';
import type { TrackCalibration } from '../../../../../packages/pose/choreography.ts';
import { camera } from './camera.ts';
import type { PoseSourceView } from './camera.ts';
import type { ProjectSession, SessionState } from './session.ts';
import type { TransportState } from './transport.ts';

export const SessionContext = createContext<ProjectSession | null>(null);
/** The open project. */
export function useSession(): ProjectSession {
  const session = useContext(SessionContext);
  if (!session) throw Error('No project is open');
  return session;
}
/** The project's state; re-renders on every change. */
export function useProject(): SessionState {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, session.getState);
}
export function useTransport(): TransportState {
  const { transport } = useSession();
  return useSyncExternalStore(transport.subscribe, transport.getState);
}
/** The camera's state (status, message, tracked poses), without starting it. */
export function useCamera(): PoseSourceView {
  const [view, setView] = useState<PoseSourceView>(() => camera().view);
  useEffect(() => { const off = camera().subscribe(setView); return () => { off(); }; }, []);
  return view;
}
/**
 * The song time, re-rendering as it moves: every frame while playing with `fps` unset, or at
 * most `fps` times a second. For readouts; draw loops should read transport.timeMs() themselves.
 */
export function useSongTime(fps = 15): number {
  const { transport } = useSession();
  const [time, setTime] = useState(() => transport.timeMs());
  useEffect(() => {
    let frame = 0, last = -Infinity, shown = NaN;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / fps) return;
      last = now;
      const t = transport.timeMs();
      if (t !== shown) { shown = t; setTime(t); }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [transport, fps]);
  return time;
}
/** An evaluator per dancer for the shown dance (edits in progress included). */
export function useEvaluators(options: { style?: boolean } = {}): DancerEvaluator[] {
  const { shown, takes } = useProject(), style = options.style;
  return useMemo(() => shown.dancers.map(d => createEvaluator(shown, d, { takes, ...(style === undefined ? {} : { style }) })), [shown, takes, style]);
}
/** How the character is sized and placed for each dancer, re-measured a moment after the dance changes. */
export function useCalibrations(): TrackCalibration[] {
  const { shown, takes } = useProject();
  const [calibrations, setCalibrations] = useState(() => previewCalibrations(shown, 250, takes));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const timer = setTimeout(() => setCalibrations(previewCalibrations(shown, 250, takes)), 250);
    return () => clearTimeout(timer);
  }, [shown, takes]);
  // The count must match the dancers at once (a dancer just added has no measurement yet).
  return calibrations.length === shown.dancers.length ? calibrations : previewCalibrations(shown, 500, takes);
}
/** A ref that always holds the latest value, for callbacks and frame loops. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
/**
 * Runs `handler` for window key presses while mounted, except ones a focused control would use
 * itself: any key in a text field, and Space or Enter on a button, checkbox or menu (which press
 * the control). Letters still reach the handler from those, and nothing does under a dialog.
 */
export function useKeys(handler: (event: KeyboardEvent) => void) {
  const latest = useLatest(handler);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (document.querySelector('.dialog-backdrop')) return;
      if (target) {
        const tag = target.tagName, type = tag === 'INPUT' ? (target as HTMLInputElement).type : '';
        const pressable = tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || type === 'checkbox' || type === 'radio' || type === 'range';
        if (target.isContentEditable || tag === 'TEXTAREA' || tag === 'INPUT' && !pressable) return;
        if (pressable && (event.key === ' ' || event.key === 'Enter' || tag === 'SELECT' || type === 'range' && event.key.startsWith('Arrow'))) return;
      }
      latest.current(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [latest]);
}
