// aerodance studio: where a song's dance is made. The library lists the projects kept in this
// browser; an open project moves through five stations (stations/index.ts) that all edit the
// same dance through the same ops (packages/dance), so the `dance` CLI and coding agents can
// work on a project too.
//
// The address says where you are: #/ is the library, #/p/<project>/<station> a station.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { needsAttention, useFindings } from './core/findings.ts';
import { stopCamera } from './core/camera.ts';
import { clock } from './core/format.ts';
import { SessionContext, useKeys, useProject, useSession, useTransport } from './core/hooks.ts';
import { addDemoTake } from './core/demo.ts';
import { FolderLocked, allowFolder, openProject } from './core/library.ts';
import * as library from './core/library.ts';
import { ProjectSession } from './core/session.ts';
import { storageSupported } from './core/files.ts';
import { Button, Icon, Note } from './core/ui.tsx';
import { ViewContext, ViewStore } from './core/view.ts';
import Library from './Library.tsx';
import { STATIONS, isStationId } from './stations/index.ts';
import type { StationId } from './stations/index.ts';

interface Route { project: string | null; station: StationId | null; }
function readRoute(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== 'p' || !parts[1]) return { project: null, station: null };
  return { project: decodeURIComponent(parts[1]), station: isStationId(parts[2]) ? parts[2] : null };
}
const subscribeHash = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
const hashNow = () => location.hash;
export const projectHref = (id: string, station?: StationId) => `#/p/${encodeURIComponent(id)}${station ? `/${station}` : ''}`;

export function Wordmark() {
  return <a className="wordmark" href="#/" aria-label="aerodance studio: all dances"><b>aero</b><span>dance</span><i /><em>studio</em></a>;
}

export default function StudioApp() {
  const hash = useSyncExternalStore(subscribeHash, hashNow);
  const route = useMemo(() => { void hash; return readRoute(); }, [hash]);
  if (!storageSupported()) return (
    <div className="studio" data-ready="true" data-screen="unsupported">
      <header className="topbar"><Wordmark /></header>
      <main className="library"><Note kind="warning">This browser can't keep dance projects (it has no private file storage). Try a current Chrome, Edge, Firefox or Safari, outside private browsing.</Note></main>
    </div>
  );
  return route.project ? <Project key={route.project} id={route.project} station={route.station} /> : <Library />;
}

function Project({ id, station }: { id: string; station: StationId | null }) {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [problem, setProblem] = useState('');
  // A folder on this computer the browser wants to be asked about again, and how many times it has been.
  const [locked, setLocked] = useState<string | null>(null), [asked, setAsked] = useState(0);
  const view = useMemo(() => new ViewStore(), []);
  useEffect(() => {
    let live = true, opened: ProjectSession | null = null;
    openProject(id).then(store => ProjectSession.open(id, store)).then(s => { if (live) { opened = s; setLocked(null); setSession(s); } else s.dispose(); },
      e => {
        if (!live) return;
        if (e instanceof FolderLocked) setLocked(e.folder);
        else setProblem(e instanceof DOMException && e.name === 'NotFoundError' ? 'That dance isn\'t in this browser\'s library.' : e instanceof Error ? e.message : String(e));
      });
    // The camera runs on between stations, but not after the dance is closed.
    return () => { live = false; opened?.dispose(); stopCamera(); };
  }, [id, asked]);
  if (locked && !session) return (
    <div className="studio" data-ready="true" data-screen="locked">
      <header className="topbar"><Wordmark /></header>
      <main className="library"><Note action={<Button kind="primary" icon="folder" onClick={() => void allowFolder(id).then(ok => { if (ok) setAsked(n => n + 1); })}>Allow</Button>}>
        This dance lives in the folder “{locked}” on this computer. The browser asks before the Studio uses it again.</Note></main>
    </div>
  );
  if (problem) return (
    <div className="studio" data-ready="true" data-screen="missing">
      <header className="topbar"><Wordmark /></header>
      <main className="library"><Note kind="error" action={<a className="btn btn-default" href="#/">All dances</a>}>{problem}</Note></main>
    </div>
  );
  // In development, the open project is on the page for scripts and the console:
  // studio.session, studio.view, and studio.demo() to add a stand-in performer's take.
  if (import.meta.env.DEV && session) (window as unknown as { studio?: unknown }).studio = { session, view, library, demo: (dancer = 0, options = {}) => addDemoTake(session, dancer, options) };
  if (!session) return <div className="studio" data-screen="opening"><header className="topbar"><Wordmark /></header><main className="library"><p className="muted">Opening…</p></main></div>;
  return <SessionContext.Provider value={session}><ViewContext.Provider value={view}><Shell station={station} /></ViewContext.Provider></SessionContext.Provider>;
}

function Shell({ station }: { station: StationId | null }) {
  const session = useSession(), state = useProject(), transport = useTransport(), findings = useFindings();
  const { dance } = state;
  // Opened without a station in the address: a new dance starts at the song, one with music but
  // no motion at recording. Chosen once and put in the address, so it doesn't change as the dance does.
  const [opening] = useState<StationId>(() => !dance.sources.audio && !dance.sources.video ? 'song' : dance.dancers.every(d => !d.clips.length) ? 'record' : 'fix');
  const current: StationId = station ?? opening;
  useEffect(() => { if (!station) location.replace(projectHref(session.id, opening)); }, [station, opening, session]);
  const info = STATIONS.find(s => s.id === current)!;
  const root = useRef<HTMLDivElement>(null);
  // The song position, for anything driving the page from outside (scripts/play.ts reads data-*).
  useEffect(() => {
    const timer = setInterval(() => { if (root.current) root.current.dataset.time = String(Math.round(session.transport.timeMs())); }, 200);
    return () => clearInterval(timer);
  }, [session]);
  useKeys(e => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    void (e.shiftKey ? session.redo() : session.undo());
  });
  const open = findings?.findings.filter(needsAttention).length ?? 0;
  const done: Record<StationId, boolean> = {
    song: !!dance.sources.audio && !!dance.song.bpm, record: dance.dancers.every(d => d.clips.length > 0 || Object.keys(d.layers[0].channels).length > 0),
    fix: findings !== null && open === 0 && dance.dancers.some(d => d.clips.length > 0), playtest: state.attempts.length > 0, share: false,
  };
  const go = useCallback((id: StationId) => { location.hash = projectHref(session.id, id); }, [session]);
  return (
    <div className="studio" ref={root} data-ready="true" data-screen="project" data-project={session.id} data-station={current} data-revision={dance.revision}
      data-playing={transport.playing} data-busy={state.busy ?? ''} data-error={state.error ?? ''} data-audio={transport.hasAudio ? (transport.ready ? 'ready' : 'loading') : 'none'}
      data-dancers={dance.dancers.length} data-takes={dance.sources.takes.length} data-clips={dance.dancers.reduce((n, d) => n + d.clips.length, 0)} data-issues={findings ? open : ''}>
      <header className="topbar">
        <Wordmark />
        <div className="project-name" title={`${dance.song.title || 'Untitled dance'}${dance.song.artist ? ` · ${dance.song.artist}` : ''} · ${clock(dance.song.durationMs, false)}`}>
          <strong>{dance.song.title || 'Untitled dance'}</strong>{dance.song.artist && <span>{dance.song.artist}</span>}
        </div>
        <nav className="stations" aria-label="Stations">
          {STATIONS.map((s, i) => (
            <button key={s.id} className={`station-tab${s.id === current ? ' on' : ''}${done[s.id] ? ' done' : ''}`} onClick={() => go(s.id)} title={s.hint} aria-current={s.id === current ? 'page' : undefined} data-station={s.id}>
              <span className="station-step">{done[s.id] ? <Icon name="check" size={12} /> : i + 1}</span>{s.label}
              {s.id === 'fix' && open > 0 && <span className="badge" aria-label={`${open} to look at`}>{open}</span>}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <Button kind="quiet" icon="undo" aria-label="Undo" disabled={!state.undo} title={state.undo ? `Undo: ${state.undo} (⌘Z)` : 'Nothing to undo'} onClick={() => void session.undo()} />
          <Button kind="quiet" icon="redo" aria-label="Redo" disabled={!state.redo} title={state.redo ? `Redo: ${state.redo} (⇧⌘Z)` : 'Nothing to redo'} onClick={() => void session.redo()} />
          <a className="btn btn-quiet" href="/" title="Open the game"><Icon name="game" />Game</a>
        </div>
      </header>
      {(state.error || state.busy) && (
        <div className="toasts">
          {state.busy && <Note kind="info">{state.busy}</Note>}
          {state.error && <Note kind="error" action={<Button kind="quiet" icon="close" aria-label="Dismiss" onClick={() => session.dismissError()} />}>{state.error}</Note>}
        </div>
      )}
      <main className="station" aria-label={info.label}>
        <Suspense fallback={<p className="muted pad">Loading…</p>}><info.Component /></Suspense>
      </main>
    </div>
  );
}
