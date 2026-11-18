// The Studio's library: the projects kept in this browser's private storage, and folders on
// this computer opened as projects (where the browser can: the `dance` CLI and coding agents can
// then work in the same folder, and its files are the user's own to back up).
import { DANCE_FILE, DanceStore } from '../../../../../packages/dance/store.ts';
import { assertDance, upgradeDance } from '../../../../../packages/dance/format.ts';
import { danceFromSong, songOf } from '../../../../../packages/dance/fromSong.ts';
import type { Dance } from '../../../../../packages/dance/format.ts';
import { makeZip, readZip, safePath } from '../../../../../packages/pose/zip.ts';
import { directoryFiles, webLock } from './files.ts';

export interface ProjectEntry {
  id: string; title: string; artist: string; updatedAt: string;
  dancers: number; durationMs: number; hasAudio: boolean;
  /** How many clips its dancers have: 0 for a dance nobody has recorded yet. */
  clips: number;
  /** Set when the folder holds something this Studio can't open. */
  problem?: string;
  /** A folder on this computer (its name); absent for a dance kept in the browser. */
  folder?: string;
  /** The browser wants to be asked again before it reads the folder. */
  locked?: boolean;
}
/** Thrown by openProject when a folder needs the user's say-so again (ask with allowFolder, from a click). */
export class FolderLocked extends Error {
  readonly folder: string;
  constructor(folder: string) { super(`Allow the Studio to use the folder “${folder}” again`); this.folder = folder; }
}

// ---- Folders on this computer: their handles are remembered in IndexedDB ----

interface FolderRecord { id: string; handle: FileSystemDirectoryHandle; addedAt: string; }
type Permission = 'granted' | 'denied' | 'prompt';
type AskableHandle = FileSystemDirectoryHandle & { queryPermission?(options: { mode: 'readwrite' }): Promise<Permission>; requestPermission?(options: { mode: 'readwrite' }): Promise<Permission> };
const isFolderId = (id: string) => id.startsWith('folder-');
function folderDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('aerodance-studio', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('folders', { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('The browser wouldn\'t open the Studio\'s folder list'));
  });
}
async function folders<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await folderDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction('folders', mode).objectStore('folders'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? Error('The folder list couldn\'t be read'));
    });
  } finally { db.close(); }
}
const permitted = async (handle: AskableHandle) => !handle.queryPermission || await handle.queryPermission({ mode: 'readwrite' }) === 'granted';
/**
 * Adds a folder on this computer as a project and returns its id. A folder that holds a dance
 * (a `dance` CLI project, or one made here before) opens as it is; any other gets a new dance.
 */
export async function adoptFolder(handle: FileSystemDirectoryHandle): Promise<string> {
  for (const known of await folders<FolderRecord[]>('readonly', s => s.getAll() as IDBRequest<FolderRecord[]>))
    if (await known.handle.isSameEntry(handle)) return known.id;
  const store = new DanceStore(directoryFiles(handle));
  if (!await store.exists()) await store.create({ title: handle.name, dancers: 1, durationMs: 60_000 });
  else await store.read();
  const id = `folder-${Math.random().toString(36).slice(2, 10)}`;
  await folders('readwrite', s => s.put({ id, handle, addedAt: new Date().toISOString() } satisfies FolderRecord));
  return id;
}
/** Asks the user for a folder and adds it (adoptFolder). Null when they cancel. */
export async function pickFolder(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?(options: { mode: 'readwrite'; id: string }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!picker) throw Error('This browser can\'t open folders. Chrome and Edge on a computer can.');
  let handle: FileSystemDirectoryHandle;
  try { handle = await picker({ mode: 'readwrite', id: 'aerodance-dance' }); }
  catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return null; throw e; }
  return adoptFolder(handle);
}
/** Asks the user (it must be from a click) to let the Studio use a folder again. */
export async function allowFolder(id: string): Promise<boolean> {
  const record = await folders<FolderRecord | undefined>('readonly', s => s.get(id) as IDBRequest<FolderRecord | undefined>);
  const handle = record?.handle as AskableHandle | undefined;
  return !!handle && (!handle.requestPermission || await handle.requestPermission({ mode: 'readwrite' }) === 'granted');
}
const ROOT = 'aerodance-studio', PROJECTS = 'projects';
async function projectsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(ROOT, { create: true })).getDirectoryHandle(PROJECTS, { create: true });
}
const slug = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'dance';
const newId = (title: string) => `${slug(title)}-${Math.random().toString(36).slice(2, 8)}`;
const entryOf = (id: string, dance: Dance): ProjectEntry => ({
  id, title: dance.song.title || 'Untitled dance', artist: dance.song.artist, updatedAt: dance.updatedAt,
  dancers: dance.dancers.length, durationMs: dance.song.durationMs, hasAudio: dance.sources.audio !== null,
  clips: dance.dancers.reduce((n, d) => n + d.clips.length, 0),
});
/** A project's store: its files, with changes serialized across this origin's tabs. */
export async function openProject(id: string): Promise<DanceStore> {
  if (isFolderId(id)) {
    const record = await folders<FolderRecord | undefined>('readonly', s => s.get(id) as IDBRequest<FolderRecord | undefined>);
    if (!record) throw new DOMException('That folder isn\'t in the library', 'NotFoundError');
    if (!await permitted(record.handle)) throw new FolderLocked(record.handle.name);
    return new DanceStore(directoryFiles(record.handle), webLock(`aerodance-studio:${id}`));
  }
  const dir = await (await projectsDir()).getDirectoryHandle(id);
  return new DanceStore(directoryFiles(dir), webLock(`aerodance-studio:${id}`));
}
export async function listProjects(): Promise<ProjectEntry[]> {
  const dir = await projectsDir(), out: ProjectEntry[] = [];
  for (const record of await folders<FolderRecord[]>('readonly', s => s.getAll() as IDBRequest<FolderRecord[]>).catch(() => [] as FolderRecord[])) {
    const blank = { id: record.id, title: record.handle.name, artist: '', updatedAt: record.addedAt, dancers: 0, durationMs: 0, hasAudio: false, clips: 0, folder: record.handle.name };
    try {
      if (!await permitted(record.handle)) out.push({ ...blank, locked: true });
      else out.push({ ...entryOf(record.id, await new DanceStore(directoryFiles(record.handle)).read()), folder: record.handle.name });
    } catch (e) { out.push({ ...blank, problem: e instanceof DOMException && e.name === 'NotFoundError' ? 'The folder has moved or been deleted' : e instanceof Error ? e.message : String(e) }); }
  }
  for await (const [id, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== 'directory') continue;
    try { out.push(entryOf(id, await new DanceStore(directoryFiles(handle as FileSystemDirectoryHandle)).read())); }
    catch (e) {
      out.push({ id, title: id, artist: '', updatedAt: '', dancers: 0, durationMs: 0, hasAudio: false, clips: 0,
        problem: e instanceof Error ? e.message : String(e) });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createProject({ title, artist = '', dancers = 1 }: { title: string; artist?: string; dancers?: number }): Promise<string> {
  const id = newId(title), dir = await (await projectsDir()).getDirectoryHandle(id, { create: true });
  await new DanceStore(directoryFiles(dir)).create({ title, artist, dancers, durationMs: 60_000 });
  return id;
}
/** Deletes a dance kept in the browser. A folder is only forgotten: its files stay where they are. */
export async function deleteProject(id: string): Promise<void> {
  if (isFolderId(id)) { await folders('readwrite', s => s.delete(id)); return; }
  await (await projectsDir()).removeEntry(id, { recursive: true });
}
/** Every file of a project (its undo history left out) as one ZIP, to keep or move to another browser. */
export async function exportProject(id: string): Promise<{ name: string; zip: Uint8Array<ArrayBuffer> }> {
  const files = (await openProject(id)).files, out = new Map<string, Uint8Array>();
  const walk = async (path: string) => {
    for (const name of await files.list(path)) {
      const child = path ? `${path}/${name}` : name;
      if (child === '.dance') continue;
      const bytes = await files.read(child).catch(() => null);
      if (bytes) out.set(child, bytes); else await walk(child);
    }
  };
  await walk('');
  const dance = await new DanceStore(files).read();
  return { name: `${slug(dance.song.title)}.aerodance-dance.zip`, zip: makeZip(out) };
}
/**
 * Adds a project from a ZIP: a dance saved by exportProject (or a `dance` CLI project folder,
 * zipped), or a finished song (the file the game imports), which opens as a dance to edit.
 */
export async function importProject(file: Blob): Promise<string> {
  const entries = await readZip(new Uint8Array(await file.arrayBuffer()), 1024 * 1024 * 1024);
  // The ZIP may hold the project at its root or inside one folder.
  const at = (name: string) => [...entries.keys()].filter(p => p === name || p.endsWith(`/${name}`)).sort((a, b) => a.length - b.length)[0];
  const danceAt = at(DANCE_FILE), songAt = danceAt === undefined ? at('song.json') : undefined;
  if (songAt !== undefined) {
    const folder = songAt.slice(0, songAt.length - 'song.json'.length);
    const files = new Map([...entries].filter(([p]) => p.startsWith(folder)).map(([p, bytes]) => [p.slice(folder.length), new Uint8Array(bytes)]));
    const id = newId(songOf(files).title), dir = await (await projectsDir()).getDirectoryHandle(id, { create: true });
    try { await danceFromSong(new DanceStore(directoryFiles(dir)), files); }
    catch (e) { await (await projectsDir()).removeEntry(id, { recursive: true }).catch(() => {}); throw e; }
    return id;
  }
  if (danceAt === undefined) throw Error('That ZIP holds neither a saved dance nor a song');
  const prefix = danceAt.slice(0, danceAt.length - DANCE_FILE.length);
  const dance = upgradeDance(JSON.parse(new TextDecoder().decode(entries.get(danceAt))));
  assertDance(dance);
  const id = newId(dance.song.title), dir = await (await projectsDir()).getDirectoryHandle(id, { create: true }), files = directoryFiles(dir);
  for (const [path, bytes] of entries) {
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const rel = path.slice(prefix.length);
    if (!safePath(rel) || rel.startsWith('.dance/')) continue;
    await files.write(rel, new Uint8Array(bytes));
  }
  return id;
}
/** How much of the browser's storage the origin uses, and whether the browser promised to keep it. */
export async function storageStatus(): Promise<{ usedBytes: number; quotaBytes: number; persisted: boolean }> {
  const estimate = await navigator.storage.estimate?.() ?? {};
  return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0, persisted: await navigator.storage.persisted?.() ?? false };
}
export const keepStorage = () => navigator.storage.persist?.() ?? Promise.resolve(false);
