// The Studio's front door: the dances kept in this browser, and starting a new one.
import { useCallback, useEffect, useState } from 'react';
import { ago, bytes, clock } from './core/format.ts';
import { foldersSupported } from './core/files.ts';
import { allowFolder, createProject, deleteProject, exportProject, importProject, keepStorage, listProjects, pickFolder, storageStatus } from './core/library.ts';
import type { ProjectEntry } from './core/library.ts';
import { Button, Dialog, Empty, Field, FileButton, Icon, Note, Segmented } from './core/ui.tsx';
import { Wordmark, projectHref } from './StudioApp.tsx';

function save(name: string, data: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' })), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const DANCER_WORDS = ['', 'Solo', 'Duet', 'Trio', 'Crew of four'];

export default function Library() {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ProjectEntry | null>(null);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof storageStatus>> | null>(null);
  const refresh = useCallback(async () => {
    try { setProjects(await listProjects()); setStorage(await storageStatus()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setProjects([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (work: () => Promise<void>) => { setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  return (
    <div className="studio" data-ready={projects ? 'true' : 'false'} data-screen="library" data-projects={projects?.length ?? ''}>
      <header className="topbar">
        <Wordmark />
        <div className="topbar-right"><a className="btn btn-quiet" href="/" title="Open the game"><Icon name="game" />Game</a></div>
      </header>
      <main className="library">
        <div className="library-head">
          <div>
            <h1>Your dances</h1>
            <p className="muted">Make a song's dance by dancing it: record each part with your camera, tidy it up, try it out, and send it to the game.</p>
          </div>
          <div className="library-actions">
            <FileButton accept=".zip,application/zip" icon="upload" title="Open a dance saved as a file, or a finished song file (.aerodance-song.zip) to edit its dance"
              onFile={file => void run(async () => { location.hash = projectHref(await importProject(file)); })}>Open a saved dance</FileButton>
            {foldersSupported() && <Button icon="folder" title="Keep a dance in a folder on this computer: its files are yours to back up, and the dance command-line tool can work in the same folder"
              onClick={() => void run(async () => { const id = await pickFolder(); if (id) location.hash = projectHref(id); })}>Open a folder</Button>}
            <Button kind="primary" icon="plus" big onClick={() => setCreating(true)}>New dance</Button>
          </div>
        </div>
        {error && <Note kind="error">{error}</Note>}
        {projects && !projects.length && (
          <Empty icon="music" title="No dances yet" action={<Button kind="primary" icon="plus" big onClick={() => setCreating(true)}>Make your first dance</Button>}>
            You'll need a song (an MP3 or OGG file) and a camera with room to dance in front of it.
          </Empty>
        )}
        {projects && projects.length > 0 && (
          <ul className="project-grid">
            {projects.map(p => (
              <li key={p.id} className={`project-card${p.problem ? ' broken' : ''}`}>
                <a href={p.problem ? undefined : projectHref(p.id)} className="project-open" aria-disabled={!!p.problem}
                  onClick={p.locked ? e => { e.preventDefault(); void run(async () => { if (await allowFolder(p.id)) location.hash = projectHref(p.id); }); } : undefined}>
                  <span className="project-art" data-dancers={p.dancers}><Icon name={p.folder ? 'folder' : p.hasAudio ? 'music' : 'person'} size={28} /></span>
                  <span className="project-text">
                    <strong>{p.title}</strong>
                    <span>{p.problem ? 'Can\'t be opened here' : p.locked ? 'Click to let the Studio use this folder again'
                      : [p.artist, DANCER_WORDS[p.dancers], p.hasAudio ? clock(p.durationMs, false) : 'no music yet'].filter(Boolean).join(' · ')}</span>
                    <small>{p.problem ?? [p.folder && `In the folder “${p.folder}”`, p.locked ? null : p.clips ? `Edited ${ago(p.updatedAt)}` : `Nothing recorded yet · ${ago(p.updatedAt)}`].filter(Boolean).join(' · ')}</small>
                  </span>
                </a>
                <div className="project-tools">
                  {!p.problem && !p.locked && <Button kind="quiet" icon="download" aria-label={`Save ${p.title} as a file`} title="Save as a file, to keep or to open in another browser"
                    onClick={() => void run(async () => { const { name, zip } = await exportProject(p.id); save(name, zip); })} />}
                  <Button kind="quiet" icon={p.folder ? 'close' : 'trash'} aria-label={p.folder ? `Take ${p.title} off this list` : `Delete ${p.title}`} title={p.folder ? 'Take it off this list (the folder stays)' : 'Delete'} onClick={() => setRemoving(p)} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {storage && projects && projects.length > 0 && (
          <p className="storage muted">
            Dances are kept in this browser, on this device: {bytes(storage.usedBytes)} used.{' '}
            {storage.persisted ? 'The browser has agreed to keep them.' : <>Clearing site data deletes them, and a browser short of space may too.{' '}
              <button className="linklike" onClick={() => void run(async () => { await keepStorage(); await refresh(); })}>Ask the browser to keep them</button>, and save the ones you care about as files.</>}
          </p>
        )}
      </main>
      {creating && <NewDance onClose={() => setCreating(false)} />}
      {removing && (
        <Dialog title={removing.folder ? `Take “${removing.title}” off this list?` : `Delete “${removing.title}”?`} onClose={() => setRemoving(null)}
          actions={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button kind="danger" icon={removing.folder ? 'close' : 'trash'}
            onClick={() => void run(async () => { await deleteProject(removing.id); setRemoving(null); await refresh(); })}>{removing.folder ? 'Take it off' : 'Delete'}</Button></>}>
          <p>{removing.folder ? `The folder “${removing.folder}” and everything in it stay on this computer; open it again any time.`
            : 'Its music, recordings and edits are removed from this browser. This can\'t be undone; save it as a file first if you might want it back.'}</p>
        </Dialog>
      )}
    </div>
  );
}

function NewDance({ onClose }: { onClose(): void }) {
  const [title, setTitle] = useState(''), [artist, setArtist] = useState(''), [dancers, setDancers] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const create = async () => {
    setBusy(true);
    try { location.hash = projectHref(await createProject({ title: title.trim() || 'Untitled dance', artist: artist.trim(), dancers }), 'song'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Dialog title="New dance" onClose={onClose}
      actions={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={() => void create()}>{busy ? 'Making it…' : 'Start'}</Button></>}>
      <form className="form" onSubmit={e => { e.preventDefault(); void create(); }}>
        <Field label="Song title"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Untitled dance" maxLength={120} /></Field>
        <Field label="Artist"><input value={artist} onChange={e => setArtist(e.target.value)} maxLength={120} /></Field>
        <Field label="Dancers" hint="How many coaches the song has. Any number of players can dance any song; you can change this later.">
          <Segmented<number> label="Dancers" value={dancers} onChange={n => setDancers(n)} options={[1, 2, 3, 4].map(n => ({ value: n, label: DANCER_WORDS[n] }))} />
        </Field>
        {error && <Note kind="error">{error}</Note>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
