// Legacy disk adapter, retained for opening/backing up existing installations.
// Static Studio and the legacy server share project validation and compilation.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { BinaryLike } from "node:crypto";
import { Workspace } from "../storage/workspace.ts";
import type { WorkspaceFiles } from "../storage/store.ts";
export { id, httpError, isMissing } from "../storage/store.ts";
export const sha = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");
export const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

class DiskFiles implements WorkspaceFiles {
  root: string;
  queues = new Map<string, Promise<unknown>>();
  constructor(root: string) { this.root = root; }
  filename(name: string) { return path.resolve(this.root, name); }
  read(name: string) { return fs.readFile(this.filename(name)); }
  async has(name: string) {
    try { await fs.access(this.filename(name)); return true; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
  }
  async commit(entries: ReadonlyMap<string, Uint8Array>, remove: string[] = []) {
    for (const [name, bytes] of entries) {
      const filename = this.filename(name), tmp = `${filename}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(filename), { recursive: true });
      try { await fs.writeFile(tmp, bytes); await fs.rename(tmp, filename); }
      finally { await fs.rm(tmp, { force: true }); }
    }
    for (const name of remove) await fs.rm(this.filename(name), { recursive: true, force: true });
  }
  async list(prefix: string): Promise<string[]> {
    const result: string[] = [];
    const walk = async (folder: string) => {
      await fs.mkdir(this.filename(folder), { recursive: true });
      for (const entry of await fs.readdir(this.filename(folder), { withFileTypes: true })) {
        const name = `${folder.replace(/\/$/, "")}/${entry.name}`;
        if (entry.isDirectory()) await walk(name); else result.push(name);
      }
    };
    await walk(prefix);
    return result;
  }
  async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queues.set(key, next);
    try { return await next; }
    finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
}
export class Store extends Workspace {
  root: string;
  constructor(root: string) {
    const absolute = path.resolve(root);
    super(new DiskFiles(absolute));
    this.root = absolute;
  }
  override location(projectId: string, ...parts: string[]) {
    return path.join(this.root, super.location(projectId, ...parts));
  }
}
