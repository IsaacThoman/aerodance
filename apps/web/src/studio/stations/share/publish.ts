// The finished song on its way out of the Studio: put together once per revision (the same ZIP
// goes to the game, to another device and to a file), saved in the game's own library on this
// origin (apps/web/src/songs/customSongs.ts), and remembered per project so the game keeps one
// copy of the song as its dance changes.
import { buildSongBundle, bundleFileName, bundleZip } from '../../../../../../packages/dance/bundle.ts';
import type { SongBundle } from '../../../../../../packages/dance/bundle.ts';
import { importSongZip, removeCustomSong, savedCustomSong } from '../../../songs/customSongs.ts';
import type { ProjectSession } from '../../core/session.ts';

/** A revision of the dance as the song the game imports. */
export interface BuiltSong { project: string; revision: number; bundle: SongBundle; zip: Uint8Array<ArrayBuffer>; fileName: string; }
/** The copy of the song a project last put in the game: its id there, and the dance revision it was made from. */
export interface InGame { songId: string; revision: number; bundleRevision: number; sha256?: string; }

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
let built: BuiltSong | null = null;
/** The saved dance's song, if it has been put together since the dance last changed. */
export const builtSong = (session: ProjectSession): BuiltSong | null =>
  built && built.project === session.id && built.revision === session.state.dance.revision ? built : null;
/** Puts the saved dance together as the game's song (or returns this revision's, already made). */
export async function buildSong(session: ProjectSession): Promise<BuiltSong> {
  const ready = builtSong(session);
  if (ready) return ready;
  const { dance, takes } = session.state, audio = await session.audioBlob();
  if (!audio) throw Error('The song needs its music before it can be put together.');
  // Let the page say what it's doing before the dance is baked, which holds it for a moment.
  await new Promise(resolve => setTimeout(resolve, 50));
  let bundle: SongBundle;
  try { bundle = await buildSongBundle(dance, new Uint8Array(await audio.arrayBuffer()), { takes }); }
  catch (e) { throw Error(`The song couldn't be put together: ${message(e)}`, { cause: e }); }
  built = { project: session.id, revision: dance.revision, bundle, zip: bundleZip(bundle), fileName: bundleFileName(bundle) };
  return built;
}

const key = (project: string) => `aerodance-studio:in-game:${project}`;
function remembered(project: string): InGame | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key(project)) ?? 'null');
    if (typeof v !== 'object' || v === null) return null;
    const { songId, revision, bundleRevision, sha256 } = v as Record<string, unknown>;
    return typeof songId === 'string' && typeof revision === 'number' && typeof bundleRevision === 'number'
      ? { songId, revision, bundleRevision, ...(typeof sha256 === 'string' ? { sha256 } : {}) } : null;
  } catch { return null; }
}
function remember(project: string, copy: InGame | null) {
  try { if (copy) localStorage.setItem(key(project), JSON.stringify(copy)); else localStorage.removeItem(key(project)); }
  catch { /* storage unavailable: the game still has the song, the Studio just won't recall adding it */ }
}
/** What a project last added to the game, if the game still has that song (it may have been removed there). */
export async function inGame(project: string): Promise<InGame | null> {
  const last = remembered(project);
  if (!last) return null;
  try { if (await savedCustomSong(last.songId)) return last; }
  catch { return last; }
  remember(project, null);
  return null;
}

export interface Added {
  /** added: new to the game; updated: in place of the copy this project (or an import) put there; kept: the game kept the copy it had. */
  status: 'added' | 'updated' | 'kept';
  copy: InGame | null;
  song: BuiltSong;
}
/** Saves the song in the game's library in this browser, in place of the copy this project added before. */
export async function addToGame(session: ProjectSession): Promise<Added> {
  const song = await buildSong(session), before = remembered(session.id);
  const result = await importSongZip(new Blob([song.zip]), { confirmReplace: () => true });
  if (result.status === 'kept') return { status: 'kept', copy: before, song };
  const copy: InGame = { songId: result.entry.id, revision: song.revision, bundleRevision: result.entry.bundleRevision, ...(result.entry.sha256 ? { sha256: result.entry.sha256 } : {}) };
  // New motion is a new song to the game: the copy added before goes, so it lists one.
  let replaced = result.status === 'replaced';
  if (before && before.songId !== copy.songId) replaced = await removeCustomSong({ id: before.songId, bundleRevision: before.bundleRevision, sha256: before.sha256 }).catch(() => false) || replaced;
  remember(session.id, copy);
  return { status: replaced ? 'updated' : 'added', copy, song };
}
