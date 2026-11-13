// A dance project in any file store: a folder on disk, the browser's private filesystem, or
// memory. The layout is the one docs/dance-format.md describes (tools/dance/project.ts reads and
// writes the same folders from Node):
//
//   dance.json                 the dance (format.ts), the one source of truth
//   sources/                   the audio, video and takes it references, named by content
//   attempts/                  playtests: players' poses through the routine
//   .dance/revisions/<n>.json  earlier revisions, for undo and redo
//   .dance/history.json        the undo and redo stacks
//
// Every change goes through apply/update/step under the store's lock: the revision goes up by
// one, the old revision is kept, and an expected revision that doesn't match fails instead of
// overwriting someone else's edit.
import { sha256 } from '../pose/song.ts';
import { assertDance, newDance, upgradeDance } from './format.ts';
import type { Dance, FileRef, TakeSource } from './format.ts';
import { applyOps } from './ops.ts';
import type { ChangeSummary } from './ops.ts';
import { decodeTake, encodeTake } from './takes.ts';
import type { TakeData, TrackedFrame } from './takes.ts';
import type { TakeLookup } from './evaluate.ts';

export const DANCE_FILE = 'dance.json';
const HISTORY_LIMIT = 200;

/** The files a project lives in. Paths use forward slashes, relative to the project's folder. */
export interface ProjectFiles {
  read(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  write(path: string, data: Uint8Array<ArrayBuffer> | Blob): Promise<void>;
  /** Removes a file, or a folder and everything in it; missing is fine. */
  remove(path: string): Promise<void>;
  /** The names in a folder (empty when it doesn't exist). */
  list(dir: string): Promise<string[]>;
  /** A file as a Blob, without reading it into memory where the store can avoid it. */
  blob(path: string): Promise<Blob | null>;
}
/** Runs one change at a time across every tab or process sharing the project. */
export type ProjectLock = <T>(fn: () => Promise<T>) => Promise<T>;

export interface ApplyRequest { ops: unknown[]; expectRevision?: number; label?: string; }
export interface ApplyResult { revision: number; previousRevision: number; summary: ChangeSummary; dance: Dance; }
export interface HistoryEntry { revision: number; label: string; at: string; }
interface History { undo: HistoryEntry[]; redo: HistoryEntry[]; }
export class RevisionConflict extends Error {
  readonly current: number;
  constructor(expected: number, current: number) {
    super(`The dance is at revision ${current}, not ${expected}: it was changed somewhere else. Reload it and try again.`);
    this.current = current;
  }
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
const text = (bytes: Uint8Array | null) => bytes ? decoder.decode(bytes) : null;
const serial = (): ProjectLock => { let chain: Promise<unknown> = Promise.resolve(); return fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; }; };

/** A short label for a batch of ops, for the undo list. */
export function describeOps(ops: readonly unknown[]): string {
  const names = ops.map(o => (typeof o === 'object' && o && 'op' in o ? String((o as { op: unknown }).op) : '?'));
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ');
}
const MIME: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', adpose: 'application/octet-stream', json: 'application/json' };
export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export interface TakeInfo { label: string; origin: TakeSource['origin']; clock: TakeSource['clock']; fps: number; model?: string; /** false: play the poses as stored (see TakeSource.cleanup). */ cleanup?: boolean; }
export interface AttemptInfo { id: string; path: string; createdAt: string; dancer: string; revision: number; player: string; width: number; height: number; }

export class DanceStore {
  readonly files: ProjectFiles;
  private readonly lock: ProjectLock;
  private takeCache = new Map<string, TakeData>();
  constructor(files: ProjectFiles, lock: ProjectLock = serial()) { this.files = files; this.lock = lock; }

  /** Whether the store holds a dance. */
  async exists(): Promise<boolean> { return (await this.files.read(DANCE_FILE)) !== null; }
  /** Creates the dance (the store must not hold one). */
  async create(options: Parameters<typeof newDance>[0] & { artist?: string } = {}): Promise<Dance> {
    return this.lock(async () => {
      if (await this.exists()) throw Error('There is already a dance here');
      const dance = newDance(options);
      dance.song.artist = options.artist ?? '';
      await this.files.write(DANCE_FILE, encoder.encode(JSON.stringify(dance, null, 1) + '\n'));
      return dance;
    });
  }
  async read(): Promise<Dance> {
    const raw = text(await this.files.read(DANCE_FILE));
    if (raw === null) throw Error('There is no dance here yet');
    const dance = upgradeDance(JSON.parse(raw));
    assertDance(dance);
    return dance;
  }
  private async history(): Promise<History> {
    try { return JSON.parse(text(await this.files.read('.dance/history.json')) ?? '') as History; }
    catch { return { undo: [], redo: [] }; }
  }
  private saveHistory(history: History) { return this.files.write('.dance/history.json', encoder.encode(JSON.stringify(history) + '\n')); }
  private async revision(n: number): Promise<Dance> {
    const raw = text(await this.files.read(`.dance/revisions/${n}.json`));
    if (raw === null) throw Error(`Revision ${n} isn't kept`);
    const dance = upgradeDance(JSON.parse(raw));
    assertDance(dance);
    return dance;
  }
  /** Writes the next revision of the dance (content from `next`) and returns it. */
  private async commit(current: Dance, next: Dance): Promise<Dance> {
    await this.files.write(`.dance/revisions/${current.revision}.json`, encoder.encode(JSON.stringify(current) + '\n'));
    const saved = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    assertDance(saved);
    await this.files.write(DANCE_FILE, encoder.encode(JSON.stringify(saved, null, 1) + '\n'));
    return saved;
  }
  private async prune(history: History, current: number) {
    history.undo = history.undo.slice(-HISTORY_LIMIT);
    const keep = new Set([...history.undo, ...history.redo].map(e => e.revision));
    for (const name of await this.files.list('.dance/revisions')) {
      const n = Number(name.replace('.json', ''));
      if (Number.isInteger(n) && n < current - HISTORY_LIMIT * 2 && !keep.has(n)) await this.files.remove(`.dance/revisions/${name}`);
    }
  }
  /** Applies ops atomically as the next revision. */
  async apply({ ops, expectRevision, label }: ApplyRequest): Promise<ApplyResult> {
    return this.lock(async () => {
      const current = await this.read();
      if (expectRevision !== undefined && expectRevision !== current.revision) throw new RevisionConflict(expectRevision, current.revision);
      const { dance, summary } = applyOps(current, ops, { takes: await this.takes(current) });
      const saved = await this.commit(current, dance);
      const history = await this.history();
      history.undo.push({ revision: current.revision, label: label ?? describeOps(ops), at: saved.updatedAt });
      history.redo = [];
      await this.prune(history, saved.revision);
      await this.saveHistory(history);
      return { revision: saved.revision, previousRevision: current.revision, summary, dance: saved };
    });
  }
  /**
   * Changes the dance outside the op set (its sources) as the next revision. `change` gets the
   * latest dance, read under the lock: do slow work (hashing, tracking) before calling this.
   */
  async update(label: string, change: (dance: Dance) => void | Promise<void>): Promise<Dance> {
    return this.lock(async () => {
      const current = await this.read(), next = structuredClone(current);
      await change(next);
      const saved = await this.commit(current, next);
      const history = await this.history();
      history.undo.push({ revision: current.revision, label, at: saved.updatedAt });
      history.redo = [];
      await this.saveHistory(history);
      return saved;
    });
  }
  /** Steps back (undo) or forward (redo) one change; the restored content gets a new revision. */
  async step(direction: 'undo' | 'redo'): Promise<{ dance: Dance; label: string } | null> {
    return this.lock(async () => {
      const history = await this.history();
      const from = direction === 'undo' ? history.undo : history.redo, to = direction === 'undo' ? history.redo : history.undo;
      const entry = from.pop();
      if (!entry) return null;
      const current = await this.read(), target = await this.revision(entry.revision);
      const saved = await this.commit(current, target);
      to.push({ revision: current.revision, label: entry.label, at: saved.updatedAt });
      await this.saveHistory(history);
      return { dance: saved, label: entry.label };
    });
  }
  async log(): Promise<History> { return this.history(); }

  // ---- Sources ----

  /** Stores a file under sources/ as <kind>-<hash>.<ext>; named by content, it's never overwritten. */
  async addSource(kind: string, name: string, data: Blob | Uint8Array<ArrayBuffer>): Promise<FileRef> {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    const hash = await sha256(bytes), extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'bin';
    const path = `sources/${kind}-${hash.slice(0, 12)}.${extension}`;
    if (!(await this.files.list('sources')).includes(path.slice('sources/'.length))) await this.files.write(path, data);
    return { path, sha256: hash, bytes: bytes.length, mimeType: (data instanceof Blob && data.type) || mimeOf(name) };
  }
  /** Every take the dance holds, decoded (and cleaned) once per file. */
  async takes(dance?: Dance): Promise<TakeLookup> {
    const current = dance ?? await this.read(), byId = new Map<string, TakeData>();
    for (const source of current.sources.takes) {
      const key = `${source.sha256}${source.cleanup === false ? ':as-stored' : ''}`;
      let data = this.takeCache.get(key);
      if (!data) {
        const bytes = await this.files.read(source.path);
        if (!bytes) continue;
        this.takeCache.set(key, data = decodeTake(bytes, { cleanup: source.cleanup !== false }));
      }
      byId.set(source.id, data);
    }
    return id => byId.get(id) ?? null;
  }
  /** Saves captured poses as a new take (the next revision) and returns its entry. */
  async addTake(frames: readonly TrackedFrame[], size: { width: number; height: number; slots: number }, info: TakeInfo): Promise<{ dance: Dance; take: TakeSource }> {
    if (!frames.length) throw Error('The take has no poses');
    const bytes = encodeTake(frames, size);
    const ref = await this.addSource('take', 'take.adpose', bytes);
    this.takeCache.set(`${ref.sha256}${info.cleanup === false ? ':as-stored' : ''}`, decodeTake(bytes, { cleanup: info.cleanup !== false }));
    let take!: TakeSource;
    const dance = await this.update(`add take ${info.label}`, next => {
      const taken = new Set(next.sources.takes.map(k => k.id));
      let n = next.sources.takes.length + 1;
      while (taken.has(`k${n}`)) n++;
      const id = `k${n}`;
      take = { ...ref, id, label: info.label, createdAt: new Date().toISOString(), origin: info.origin, clock: info.clock, model: info.model ?? 'lite', fps: info.fps,
        slots: size.slots, width: size.width, height: size.height, startMs: frames[0].videoMs, endMs: frames[frames.length - 1].videoMs,
        ...(info.cleanup === false ? { cleanup: false } : {}) };
      next.sources.takes.push(take);
    });
    return { dance, take };
  }

  // ---- Playtests ----

  /** Saves a player's attempt (their poses in song time) beside the project; it isn't part of the dance. */
  async addAttempt(frames: readonly TrackedFrame[], info: Omit<AttemptInfo, 'id' | 'path' | 'createdAt'>): Promise<AttemptInfo> {
    const id = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
    const entry: AttemptInfo = { ...info, id, path: `attempts/${id}.adpose`, createdAt: new Date().toISOString() };
    await this.files.write(entry.path, encodeTake(frames, { width: info.width, height: info.height, slots: 1 }));
    await this.lock(async () => {
      const list = await this.attempts();
      await this.files.write('attempts/index.json', encoder.encode(JSON.stringify([...list, entry]) + '\n'));
    });
    return entry;
  }
  async attempts(): Promise<AttemptInfo[]> {
    try { return JSON.parse(text(await this.files.read('attempts/index.json')) ?? '[]') as AttemptInfo[]; } catch { return []; }
  }
  /** An attempt's poses as captured (no cleanup: the scorer sees what the game would). */
  async attempt(info: AttemptInfo): Promise<TakeData | null> {
    const bytes = await this.files.read(info.path);
    return bytes ? decodeTake(bytes, { cleanup: false }) : null;
  }
  async removeAttempt(id: string): Promise<void> {
    await this.lock(async () => {
      const list = await this.attempts(), gone = list.find(a => a.id === id);
      if (!gone) return;
      await this.files.remove(gone.path);
      await this.files.write('attempts/index.json', encoder.encode(JSON.stringify(list.filter(a => a.id !== id)) + '\n'));
    });
  }
}

/** A project held in memory, for tests and previews. */
export function memoryFiles(initial: Record<string, Uint8Array<ArrayBuffer>> = {}): ProjectFiles & { entries: Map<string, Uint8Array<ArrayBuffer>> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    read: async path => entries.get(path) ?? null,
    write: async (path, data) => { entries.set(path, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data); },
    remove: async path => { for (const key of [...entries.keys()]) if (key === path || key.startsWith(`${path}/`)) entries.delete(key); },
    list: async dir => [...new Set([...entries.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1).split('/')[0]))],
    blob: async path => { const bytes = entries.get(path); return bytes ? new Blob([bytes], { type: mimeOf(path) }) : null; },
  };
}
