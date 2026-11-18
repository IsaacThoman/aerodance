// The dance as the game will load it: compiled choreography in a song bundle (no music), for
// the playtest's scorer and anything that reports on what will be published. Compiling a whole
// song takes a moment, so it runs a beat after the dance last changed and is kept per revision.
import { useEffect, useState } from 'react';
import { gameBundle } from '../../../../../packages/dance/score.ts';
import type { SongBundle } from '../../../../../packages/pose/song.ts';
import { useProject } from './hooks.ts';
import type { ProjectSession } from './session.ts';

let cache: { revision: number; project: string; bundle: SongBundle } | null = null;
/** Compiles the saved dance now (or returns the revision's cached bundle). Throws if it can't compile. */
export function compileNow(session: ProjectSession): SongBundle {
  const { dance, takes } = session.state;
  if (cache?.revision === dance.revision && cache.project === session.id) return cache.bundle;
  const bundle = gameBundle(dance, undefined, takes);
  cache = { revision: dance.revision, project: session.id, bundle };
  return bundle;
}
/** The saved dance compiled, a moment after it changes; null while compiling or when `enabled` is off. */
export function useGameBundle(session: ProjectSession, enabled = true): { bundle: SongBundle | null; compiling: boolean; error: string | null } {
  const { dance } = useProject();
  const [state, setState] = useState<{ bundle: SongBundle | null; compiling: boolean; error: string | null }>({ bundle: null, compiling: enabled, error: null });
  useEffect(() => {
    if (!enabled) { setState({ bundle: null, compiling: false, error: null }); return; }
    if (cache?.revision === dance.revision && cache.project === session.id) { setState({ bundle: cache.bundle, compiling: false, error: null }); return; }
    setState(s => ({ ...s, compiling: true, error: null }));
    const timer = setTimeout(() => {
      try { setState({ bundle: compileNow(session), compiling: false, error: null }); }
      catch (e) { setState({ bundle: null, compiling: false, error: e instanceof Error ? e.message : String(e) }); }
    }, 350);
    return () => clearTimeout(timer);
  }, [session, dance.revision, enabled]);
  return state;
}
