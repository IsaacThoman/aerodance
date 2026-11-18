// Projects in the browser: each is a folder (packages/dance/store.ts's layout) in the origin's
// private filesystem, or, where the browser can open one, a real folder on disk the `dance` CLI
// and coding agents can work in too.
import type { ProjectFiles, ProjectLock } from '../../../../../packages/dance/store.ts';
import { mimeOf } from '../../../../../packages/dance/store.ts';

const missing = (e: unknown) => e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
/** A FileSystemDirectoryHandle (the private filesystem's, or a picked folder's) as a project's files. */
export function directoryFiles(root: FileSystemDirectoryHandle): ProjectFiles {
  const folder = async (parts: string[], create: boolean) => {
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  };
  const file = async (path: string) => {
    const parts = path.split('/').filter(Boolean), name = parts.pop()!;
    try { return await (await (await folder(parts, false)).getFileHandle(name)).getFile(); }
    catch (e) { if (missing(e)) return null; throw e; }
  };
  return {
    read: async path => { const f = await file(path); return f ? new Uint8Array(await f.arrayBuffer()) : null; },
    blob: async path => { const f = await file(path); return f ? (f.type ? f : new Blob([f], { type: mimeOf(path) })) : null; },
    async write(path, data) {
      const parts = path.split('/').filter(Boolean), name = parts.pop()!;
      const handle = await (await folder(parts, true)).getFileHandle(name, { create: true });
      // A writable stream replaces the file only when it closes: a write that fails (the browser
      // out of room) is abandoned, so the file keeps what it had.
      const writable = await handle.createWritable();
      try { await writable.write(data); }
      catch (e) { await writable.abort().catch(() => {}); throw e; }
      await writable.close();
    },
    async remove(path) {
      const parts = path.split('/').filter(Boolean), name = parts.pop()!;
      try { await (await folder(parts, false)).removeEntry(name, { recursive: true }); } catch (e) { if (!missing(e)) throw e; }
    },
    async list(dir) {
      try {
        const names: string[] = [];
        for await (const name of (await folder(dir.split('/').filter(Boolean), false) as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
        return names;
      } catch (e) { if (missing(e)) return []; throw e; }
    },
  };
}
/** One change at a time across this origin's tabs, by name. */
export const webLock = (name: string): ProjectLock => fn => navigator.locks.request(name, fn) as Promise<Awaited<ReturnType<typeof fn>>>;

/** Whether this browser can keep projects (a private filesystem with writable files, and locks). */
export const storageSupported = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && !!navigator.locks
  && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
/** Whether it can open a folder on disk as a project (Chromium on a computer). */
export const foldersSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
