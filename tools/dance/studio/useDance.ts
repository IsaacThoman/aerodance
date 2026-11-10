// The dance the Studio shows and edits, kept in step with dance.json on disk.
//
// Edits are ops (ops.ts), the same ones the CLI applies. The Studio shows their result at once
// (applied locally), then sends them to the bridge one batch at a time, in order, each against
// the latest saved revision, so quick successive edits (typing, a slider) never race each other.
// Changes from anywhere else (the CLI, an agent, another window, a hand edit) arrive as events
// and replace what's shown, unless a drag is in progress, which keeps its preview until it's
// committed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dance } from '../format.ts';
import { applyOps as applyLocally } from '../ops.ts';
import type { ChangeSummary } from '../ops.ts';
import { ApiError, applyOps, fetchCurrentDance, history, redo as redoRemote, undo as undoRemote, watchRevisions } from './data.ts';
import type { Progress } from './data.ts';

/** Ops that read tracking can't be previewed locally; they wait for the bridge. */
const NEEDS_TRACKING = new Set(['draft', 'fit-body']);
const needsTracking = (ops: readonly unknown[]) => ops.some(o => {
  const op = o as { op?: string; from?: unknown };
  return NEEDS_TRACKING.has(op.op ?? '') || op.op === 'pose' && op.from === 'tracking';
});

export interface DanceStore {
  /** What to show: a drag's preview or edits still being saved, else the saved dance. */
  dance: Dance | null;
  saved: Dance | null;
  /** The Studio was opened on a folder with no dance yet. */
  missing: boolean;
  /** Long work the bridge is doing (tracking), as it reports it. */
  progress: Progress | null;
  error: string;
  notice: string;
  busy: boolean;
  history: { undo: { revision: number; label: string }[]; redo: { revision: number; label: string }[] };
  setError(message: string): void;
  setNotice(message: string): void;
  /** Applies ops after any still being saved; resolves with the change summary, or null if it failed (the error is shown). */
  apply(ops: unknown[], label?: string): Promise<ChangeSummary | null>;
  /** Shows ops applied locally without saving (a drag in progress); null clears it. */
  preview(ops: unknown[] | null): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Reads the dance again (after creating it, or attaching sources). */
  reload(): Promise<void>;
}
export function useDance(): DanceStore {
  const [saved, setSaved] = useState<Dance | null>(null);
  const [preview, setPreview] = useState<Dance | null>(null);
  const [missing, setMissing] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<DanceStore['history']>({ undo: [], redo: [] });
  const current = useRef<Dance | null>(null), shownJson = useRef('');
  // Edits waiting to be saved: the queue they run in, how many, and what they add up to.
  const queue = useRef<Promise<unknown>>(Promise.resolve()), waiting = useRef(0), optimistic = useRef<Dance | null>(null);
  const refresh = useCallback(async () => {
    const [next, steps] = await Promise.all([fetchCurrentDance(), history()]);
    setMissing(next === null);
    if (!next) return null;
    const text = JSON.stringify(next);
    if (text !== shownJson.current) { shownJson.current = text; current.current = next; setSaved(next); }
    setLog(steps);
    return next;
  }, []);
  useEffect(() => {
    refresh().catch(e => setError(String(e instanceof Error ? e.message : e)));
    // Any change, including a hand edit that kept the revision, and the dance being created.
    return watchRevisions(() => { refresh().catch(() => {}); }, setProgress);
  }, [refresh]);
  const failed = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    return null;
  };
  const apply = useCallback((ops: unknown[], label?: string): Promise<ChangeSummary | null> => {
    if (!current.current) return Promise.resolve(null);
    setError('');
    // Show the result at once, on top of edits not saved yet, when it can be computed here.
    if (!needsTracking(ops)) {
      try { optimistic.current = applyLocally(optimistic.current ?? current.current, ops).dance; setPreview(optimistic.current); }
      catch (e) {
        // Nothing changes: drop a drag's preview and show what's saved (and edits still saving).
        setPreview(optimistic.current);
        return Promise.resolve(failed(e));
      }
    }
    waiting.current++;
    setBusy(true);
    const run = queue.current.then(async (): Promise<ChangeSummary | null> => {
      try {
        // Someone else (the CLI, another window) may save first, again and again while they're
        // busy: apply the same ops to the latest revision each time.
        let result;
        for (let attempt = 0; ; attempt++) {
          try { result = await applyOps(ops, current.current!.revision, label); break; }
          catch (e) {
            if (!(e instanceof ApiError && e.status === 409) || attempt >= 20) throw e;
            await refresh();
          }
        }
        await refresh();
        return result.summary;
      } catch (e) {
        // What's shown can't be trusted any more: show what's saved.
        optimistic.current = null;
        return failed(e);
      } finally {
        if (--waiting.current === 0) { optimistic.current = null; setPreview(null); setBusy(false); }
      }
    });
    queue.current = run.catch(() => {});
    return run;
  }, [refresh]);
  const showPreview = useCallback((ops: unknown[] | null) => {
    const base = optimistic.current ?? current.current;
    if (!ops || !base) { setPreview(optimistic.current); return; }
    try { setPreview(applyLocally(base, ops).dance); } catch { /* an impossible drag position: keep the last preview */ }
  }, []);
  const step = useCallback(async (direction: 'undo' | 'redo') => {
    await queue.current;
    setError('');
    setBusy(true);
    try {
      const { result } = await (direction === 'undo' ? undoRemote : redoRemote)(current.current?.revision);
      if (!result) setNotice(`Nothing to ${direction}`);
      else setNotice(`${direction === 'undo' ? 'Undid' : 'Redid'} ${result.label}`);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { await refresh(); setError('The dance changed elsewhere; try again'); }
      else failed(e);
    } finally { setBusy(false); }
  }, [refresh]);
  return {
    dance: preview ?? saved, saved, missing, progress, error, notice, busy, history: log, setError, setNotice,
    apply, preview: showPreview, undo: () => step('undo'), redo: () => step('redo'), reload: async () => { await refresh(); },
  };
}
