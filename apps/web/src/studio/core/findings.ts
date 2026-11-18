// The dance's open issues (packages/dance/check.ts), worked out a moment after each change so
// typing and dragging stay quick. The Fix station lists them; the tabs show how many there are.
import { useEffect, useState } from 'react';
import { checkDance } from '../../../../../packages/dance/check.ts';
import type { Finding } from '../../../../../packages/dance/check.ts';
import { useProject, useSession } from './hooks.ts';

export interface Findings { revision: number; findings: Finding[]; }
let cache: (Findings & { project: string }) | null = null;
/** The saved dance's findings, or null while they're being worked out for the first time. */
export function useFindings(): Findings | null {
  const { dance, takes } = useProject(), project = useSession().id;
  const fresh = () => cache?.revision === dance.revision && cache.project === project ? cache : null;
  const [result, setResult] = useState<Findings | null>(fresh);
  useEffect(() => {
    const kept = fresh();
    if (kept) { setResult(kept); return; }
    const timer = setTimeout(() => {
      try { cache = { project, revision: dance.revision, findings: checkDance(dance, { takes, stepMs: 1000 / 30 }) }; }
      catch { cache = { project, revision: dance.revision, findings: [] }; }
      setResult(cache);
    }, 500);
    return () => clearTimeout(timer);
    // `fresh` reads only what the effect already depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dance, takes, project]);
  // While a change is being checked the last result stands (its `revision` says how old it is),
  // but one worked out for another dance is never shown as this one's.
  return result && (result as { project?: string }).project === project ? result : null;
}
/** Findings that need a decision before sharing (warnings and errors), as opposed to notes. */
export const needsAttention = (f: Finding) => f.severity !== 'info' || f.kind === 'unsure-tracking';
export type { Finding };
