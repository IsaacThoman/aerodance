// The dance the Studio shows and edits, kept in step with dance.json on disk.
//
// Edits are ops (ops.ts), the same ones the CLI applies: the Studio shows the result at once
// (applied locally), then the bridge applies them to the latest revision. Changes from anywhere
// else (the CLI, an agent, another window) arrive as revision events and replace what's shown,
// unless a drag is in progress, which keeps its preview until it's committed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dance } from '../format.ts';
import { applyOps as applyLocally } from '../ops.ts';
import type { ChangeSummary } from '../ops.ts';
import { ApiError, applyOps, fetchDance, history, redo as redoRemote, undo as undoRemote, watchRevisions } from './data.ts';

/** Ops that read tracking can't be previewed locally; they wait for the bridge. */
const NEEDS_TRACKING = new Set(['draft', 'fit-body']);
const needsTracking = (ops: readonly unknown[]) => ops.some(o => {
  const op = o as { op?: string; from?: unknown };
  return NEEDS_TRACKING.has(op.op ?? '') || op.op === 'pose' && op.from === 'tracking';
});

export interface DanceStore {
  /** What to show: a drag's preview, else the latest dance. */
  dance: Dance | null;
  saved: Dance | null;
  error: string;
  notice: string;
  busy: boolean;
  history: { undo: { revision: number; label: string }[]; redo: { revision: number; label: string }[] };
  setError(message: string): void;
  setNotice(message: string): void;
  /** Applies ops; resolves with the change summary, or null if it failed (the error is shown). */
  apply(ops: unknown[], label?: string): Promise<ChangeSummary | null>;
  /** Shows ops applied locally without saving (a drag in progress); null clears it. */
  preview(ops: unknown[] | null): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
}
export function useDance(): DanceStore {
  const [saved, setSaved] = useState<Dance | null>(null);
  const [preview, setPreview] = useState<Dance | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<DanceStore['history']>({ undo: [], redo: [] });
  const current = useRef<Dance | null>(null);
  const dragging = useRef(false);
  current.current = saved;
  const refresh = useCallback(async () => {
    const [next, steps] = await Promise.all([fetchDance(), history()]);
    if (!current.current || next.revision !== current.current.revision) setSaved(next);
    setLog(steps);
    return next;
  }, []);
  useEffect(() => {
    refresh().catch(e => setError(String(e instanceof Error ? e.message : e)));
    return watchRevisions(revision => {
      if (current.current && revision === current.current.revision) return;
      refresh().catch(() => {});
    });
  }, [refresh]);
  const failed = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    return null;
  };
  const apply = useCallback(async (ops: unknown[], label?: string): Promise<ChangeSummary | null> => {
    const base = current.current;
    if (!base) return null;
    dragging.current = false;
    setError('');
    // Show the result immediately when it can be computed here.
    if (!needsTracking(ops)) {
      try { setPreview(applyLocally(base, ops).dance); }
      catch (e) { setPreview(null); return failed(e); }
    }
    setBusy(true);
    try {
      let result;
      try { result = await applyOps(ops, base.revision, label); }
      catch (e) {
        // Someone else saved first: apply the same ops to their revision.
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        const latest = await refresh();
        result = await applyOps(ops, latest.revision, label);
      }
      const next = await refresh();
      if (next.revision < result.revision) await refresh();
      return result.summary;
    } catch (e) { return failed(e); }
    finally { setPreview(null); setBusy(false); }
  }, [refresh]);
  const showPreview = useCallback((ops: unknown[] | null) => {
    const base = current.current;
    if (!ops || !base) { dragging.current = false; setPreview(null); return; }
    dragging.current = true;
    try { setPreview(applyLocally(base, ops).dance); } catch { /* an impossible drag position: keep the last preview */ }
  }, []);
  const step = useCallback(async (direction: 'undo' | 'redo') => {
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
    dance: preview ?? saved, saved, error, notice, busy, history: log, setError, setNotice,
    apply, preview: showPreview, undo: () => step('undo'), redo: () => step('redo'),
  };
}
