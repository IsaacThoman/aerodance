import type { WorkspaceFiles } from "./store.ts";
import { missing } from "./workspace.ts";

type Entry = { bytes: Uint8Array } | { blob: string };
const FILES_LOCK = "aerodance-studio:files";
const range = (prefix: string) => IDBKeyRange.bound(prefix, prefix + "\uffff");
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || Error("Browser save was aborted"));
    tx.onerror = () => {}; // onabort supplies the final transaction error.
  });
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("aerodance-studio", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error("Close other Dance Studio tabs to upgrade browser storage."));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** IndexedDB holds metadata and file pointers; OPFS holds immutable asset bytes.
 * New files close before the IDB transaction commits. Old files are removed only
 * after commit. The workspace lock works across tabs, including crash recovery.
 */
export class BrowserFiles implements WorkspaceFiles {
  private ready?: Promise<{ db: IDBDatabase; directory: FileSystemDirectoryHandle }>;
  private initialize() {
    return this.ready ??= (async () => {
      if (!globalThis.isSecureContext || !globalThis.indexedDB || !navigator.storage?.getDirectory || !navigator.locks)
        throw Error("Dance Studio needs HTTPS or localhost and a browser with IndexedDB, private file storage, and Web Locks enabled.");
      const db = await database();
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("aerodance-studio", { create: true });
      await navigator.locks.request(FILES_LOCK, async () => {
        const tx = db.transaction("files", "readonly"), done = complete(tx);
        const entries = await result<Entry[]>(tx.objectStore("files").getAll());
        await done;
        const live = new Set(entries.flatMap(entry => "blob" in entry ? [entry.blob] : []));
        // Clean up files left by an interrupted commit or deletion.
        for await (const name of directory.keys()) if (!live.has(name)) await directory.removeEntry(name);
      });
      return { db, directory };
    })();
  }
  locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!navigator.locks) return Promise.reject(Error("This browser does not support safe saving across tabs (Web Locks)."));
    return navigator.locks.request(`aerodance-studio:project:${key}`, fn);
  }
  async read(path: string): Promise<Uint8Array> {
    const { db, directory } = await this.initialize();
    return navigator.locks.request(FILES_LOCK, { mode: "shared" }, async () => {
      const tx = db.transaction("files", "readonly"), done = complete(tx);
      const entry = await result<Entry | undefined>(tx.objectStore("files").get(path));
      await done;
      if (!entry) throw missing();
      if ("bytes" in entry) return entry.bytes;
      const file = await (await directory.getFileHandle(entry.blob)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    });
  }
  async has(path: string): Promise<boolean> {
    const { db } = await this.initialize();
    const tx = db.transaction("files", "readonly"), done = complete(tx);
    const count = await result(tx.objectStore("files").count(path));
    await done;
    return count > 0;
  }
  async list(prefix: string): Promise<string[]> {
    const { db } = await this.initialize();
    const tx = db.transaction("files", "readonly"), done = complete(tx);
    const keys = await result(tx.objectStore("files").getAllKeys(range(prefix)));
    await done;
    return keys.map(String);
  }
  async commit(entries: ReadonlyMap<string, Uint8Array>, remove: string[] = []): Promise<void> {
    const { db, directory } = await this.initialize();
    return navigator.locks.request(FILES_LOCK, async () => {
      const prepared = new Map<string, Entry>(), created: string[] = [], obsolete: string[] = [];
      try {
        for (const [path, bytes] of entries) {
          if (/\/(assets|capture|takes|tracks)\//.test(path)) {
            const blob = crypto.randomUUID(); created.push(blob);
            const file = await directory.getFileHandle(blob, { create: true });
            const writer = await file.createWritable();
            try { await writer.write(new Uint8Array(bytes)); await writer.close(); }
            catch (error) { await writer.abort().catch(() => {}); throw error; }
            prepared.set(path, { blob });
          } else prepared.set(path, { bytes });
        }
        const tx = db.transaction("files", "readwrite", { durability: "strict" }), done = complete(tx), store = tx.objectStore("files");
        // Queue all requests synchronously: IDB transactions must not await OPFS work.
        const collect = (request: IDBRequest<Entry | undefined>) => {
          request.onsuccess = () => { if (request.result && "blob" in request.result) obsolete.push(request.result.blob); };
        };
        try {
        for (const name of remove) {
          if (name.endsWith("/")) {
            const cursor = store.openCursor(range(name));
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (!entry) return;
              const value: Entry = entry.value;
              if ("blob" in value) obsolete.push(value.blob);
              entry.delete(); entry.continue();
            };
          } else { collect(store.get(name)); store.delete(name); }
        }
        for (const [path, entry] of prepared) { collect(store.get(path)); store.put(entry, path); }
        } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
        await done;
      } catch (error) {
        for (const name of created) await directory.removeEntry(name).catch(() => {});
        throw error;
      }
      for (const name of new Set(obsolete)) await directory.removeEntry(name).catch(() => {});
    });
  }
}
