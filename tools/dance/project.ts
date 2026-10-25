// A dance project folder on disk, shared by the CLI and the Studio bridge:
//
//   dance.json                 the dance (format.ts), the one source of truth
//   sources/                   the video, audio and tracking it references
//   .dance/revisions/<n>.json  earlier revisions, for undo and redo
//   .dance/history.json        the undo and redo stacks, and recent op ids (retries)
//   .dance/cache/, renders/    frame grabs and previews, safe to delete
//
// Every change goes through apply/undo/redo under a lock: the revision goes up by one, the
// old revision is kept, and an expected revision that doesn't match fails instead of
// overwriting someone else's edit. Retrying a request with the same opId returns the first
// result without applying it twice.
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyOps } from './ops.ts';
import type { ChangeSummary } from './ops.ts';
import { assertDance, newDance } from './format.ts';
import type { Dance, FileRef } from './format.ts';
import { decodeTracking } from './tracking.ts';
import type { TrackingData } from './tracking.ts';
import { extractAudio, makeProxy, mimeOf, probeAudioMs, probeVideo, sha256File } from './media.ts';

export const DANCE_FILE = 'dance.json';
const HISTORY_LIMIT = 200, OP_ID_LIMIT = 500;

export interface ApplyRequest { ops: unknown[]; expectRevision?: number; opId?: string; label?: string; }
export interface ApplyResult { revision: number; previousRevision: number; summary: ChangeSummary; replayed: boolean; }
interface HistoryEntry { revision: number; label: string; at: string; }
interface History { undo: HistoryEntry[]; redo: HistoryEntry[]; ops: { id: string; digest: string; result: ApplyResult }[]; }
export class RevisionConflict extends Error {
  readonly current: number;
  constructor(expected: number, current: number) {
    super(`The dance is at revision ${current}, not ${expected}: someone else changed it. Read it again and retry.`);
    this.current = current;
  }
}

/** JSON with each key, point and short object on one line, so dance.json reads and diffs well. */
export function formatJson(value: unknown, indent = ''): string {
  const inline = JSON.stringify(value);
  const simple = (v: unknown): boolean => v === null || typeof v !== 'object' || Array.isArray(v) && v.every(x => x === null || typeof x !== 'object');
  if (inline === undefined) return 'null';
  if (simple(value)) return inline;
  if (!Array.isArray(value) && Object.values(value as object).every(simple) && inline.length <= 110) {
    // Spaced key by key: rewriting the serialized text would also change the strings inside it.
    const entries = Object.entries(value as object).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
  }
  const next = indent + '  ';
  if (Array.isArray(value)) return value.length ? `[\n${value.map(v => next + formatJson(v, next)).join(',\n')}\n${indent}]` : '[]';
  const entries = Object.entries(value as object).filter(([, v]) => v !== undefined);
  return entries.length ? `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatJson(v, next)}`).join(',\n')}\n${indent}}` : '{}';
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export class DanceProject {
  readonly dir: string;
  private trackingCache = new Map<string, TrackingData>();
  constructor(dir: string) { this.dir = path.resolve(dir); }
  get file() { return path.join(this.dir, DANCE_FILE); }
  meta(...parts: string[]) { return path.join(this.dir, '.dance', ...parts); }
  /** A source path from the dance, absolute. */
  resolve(ref: string) { return path.isAbsolute(ref) ? ref : path.join(this.dir, ref); }
  static exists(dir: string) { return existsSync(path.join(dir, DANCE_FILE)); }

  async read(): Promise<Dance> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw Error(`No dance at ${this.dir} (no ${DANCE_FILE}); create one with \`dance init ${this.dir}\``, { cause: e });
      throw e;
    }
    const dance: unknown = JSON.parse(text);
    assertDance(dance);
    return dance;
  }
  /** Runs fn holding the project's lock (a directory, so it works across processes). */
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = this.meta('lock');
    await mkdir(this.meta(), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try { await mkdir(lock); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const owner = Number(await readFile(path.join(lock, 'pid'), 'utf8').catch(() => '0'));
        const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
        // A lock whose process has gone is stale: take it over.
        if ((owner && !alive(owner)) || (!owner && age > 5000)) { await rm(lock, { recursive: true, force: true }); continue; }
        if (attempt > 1200) throw Error(`The project is busy: process ${owner || '(unknown)'} has been changing it for over a minute. Try again when it finishes.`, { cause: e });
        await sleep(50);
      }
    }
    try {
      await writeFile(path.join(lock, 'pid'), String(process.pid));
      return await fn();
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async history(): Promise<History> {
    try { return JSON.parse(await readFile(this.meta('history.json'), 'utf8')) as History; }
    catch { return { undo: [], redo: [], ops: [] }; }
  }
  private async saveHistory(history: History) {
    await this.writeAtomic(this.meta('history.json'), JSON.stringify(history) + '\n');
  }
  private async writeAtomic(file: string, text: string) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, text);
    await rename(temporary, file);
  }
  /**
   * Keeps a revision for undo. The current file is always written again: someone may have
   * edited dance.json by hand without changing its revision, and undo must restore what was
   * really there before the next change.
   */
  private async snapshot(dance: Dance) {
    const file = this.meta('revisions', `${dance.revision}.json`), text = JSON.stringify(dance) + '\n';
    if (existsSync(file) && await readFile(file, 'utf8') === text) return;
    await this.writeAtomic(file, text);
  }
  /** An earlier revision, as it was saved (the current one included). */
  async revisionAt(n: number): Promise<Dance> {
    if (!Number.isSafeInteger(n) || n < 0) throw Error(`No revision ${n}`);
    const current = await this.read();
    if (n === current.revision) return current;
    try { return await this.revision(n); }
    catch { throw Error(`Revision ${n} isn't kept (the history keeps the last ${HISTORY_LIMIT * 2})`); }
  }
  private async revision(n: number): Promise<Dance> {
    const dance: unknown = JSON.parse(await readFile(this.meta('revisions', `${n}.json`), 'utf8'));
    assertDance(dance);
    return dance;
  }
  /** Writes the next revision of the dance (content from `next`) and returns it. */
  private async commit(current: Dance, next: Dance): Promise<Dance> {
    await this.snapshot(current);
    const saved = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    assertDance(saved);
    await this.writeAtomic(this.file, formatJson(saved) + '\n');
    await this.snapshot(saved);
    return saved;
  }
  private async prune(history: History) {
    const keep = new Set([...history.undo, ...history.redo].map(e => e.revision));
    history.undo = history.undo.slice(-HISTORY_LIMIT);
    history.ops = history.ops.slice(-OP_ID_LIMIT);
    const files = await readdir(this.meta('revisions')).catch(() => [] as string[]);
    const current = (await this.read()).revision;
    for (const f of files) {
      const n = Number(f.replace('.json', ''));
      if (Number.isInteger(n) && n < current - HISTORY_LIMIT * 2 && !keep.has(n)) await rm(this.meta('revisions', f), { force: true });
    }
  }
  /**
   * Changes the dance outside the op set (sources: attach, track) as the next revision. `change`
   * gets the latest dance, read under the lock, so nothing saved meanwhile is lost: do slow work
   * (hashing, transcoding, tracking) before calling this, not inside it.
   */
  async update(label: string, change: (dance: Dance) => void | Promise<void>): Promise<Dance> {
    return this.locked(async () => {
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
  async apply({ ops, expectRevision, opId, label }: ApplyRequest): Promise<ApplyResult> {
    return this.locked(async () => {
      const history = await this.history();
      const digest = createHash('sha256').update(JSON.stringify(ops)).digest('hex');
      if (opId) {
        const seen = history.ops.find(o => o.id === opId);
        if (seen) {
          if (seen.digest !== digest) throw Error(`opId ${opId} was already used for different ops`);
          return { ...seen.result, replayed: true };
        }
      }
      const current = await this.read();
      if (expectRevision !== undefined && expectRevision !== current.revision) throw new RevisionConflict(expectRevision, current.revision);
      if (ops.some(o => typeof o === 'object' && o !== null && ['draft', 'fit-body', 'pose'].includes(String((o as { op?: unknown }).op)))) await this.loadTracking(current);
      const { dance, summary } = applyOps(current, ops, { tracking: id => this.trackingSync(current, id) });
      const saved = await this.commit(current, dance);
      const result: ApplyResult = { revision: saved.revision, previousRevision: current.revision, summary, replayed: false };
      history.undo.push({ revision: current.revision, label: label ?? describeOps(ops), at: saved.updatedAt });
      history.redo = [];
      if (opId) history.ops.push({ id: opId, digest, result });
      await this.prune(history);
      await this.saveHistory(history);
      return result;
    });
  }
  /** Steps back (undo) or forward (redo) one change; the restored content gets a new revision. */
  async step(direction: 'undo' | 'redo', expectRevision?: number): Promise<{ revision: number; label: string } | null> {
    return this.locked(async () => {
      const history = await this.history();
      const from = direction === 'undo' ? history.undo : history.redo, to = direction === 'undo' ? history.redo : history.undo;
      const entry = from.pop();
      if (!entry) return null;
      const current = await this.read();
      if (expectRevision !== undefined && expectRevision !== current.revision) throw new RevisionConflict(expectRevision, current.revision);
      const target = await this.revision(entry.revision);
      const saved = await this.commit(current, target);
      to.push({ revision: current.revision, label: entry.label, at: saved.updatedAt });
      await this.saveHistory(history);
      return { revision: saved.revision, label: entry.label };
    });
  }
  async log(): Promise<{ undo: HistoryEntry[]; redo: HistoryEntry[] }> {
    const { undo, redo } = await this.history();
    return { undo, redo };
  }
  /** Tracking by id, decoded once per file. */
  async tracking(id: string, dance?: Dance): Promise<TrackingData> {
    const current = dance ?? await this.read();
    await this.loadTracking(current);
    return this.trackingSync(current, id);
  }
  private trackingSync(dance: Dance, id: string): TrackingData {
    const source = dance.sources.tracking.find(s => s.id === id);
    if (!source) throw Error(`No tracking "${id}"`);
    const cached = this.trackingCache.get(source.sha256);
    if (!cached) throw Error(`Tracking ${id} isn't loaded`);
    return cached;
  }
  /** Loads every tracking file (ops read them synchronously). */
  async loadTracking(dance?: Dance): Promise<void> {
    for (const source of (dance ?? await this.read()).sources.tracking) {
      if (this.trackingCache.has(source.sha256)) continue;
      const bytes = await readFile(this.resolve(source.path));
      this.trackingCache.set(source.sha256, decodeTracking(bytes));
    }
  }
  /** Copies (or hard-links, or with link: references) a file into sources/, returning its ref. */
  /**
   * Copies a file into sources/ as <kind>-<hash><ext> (or with link, references it where it is),
   * returning its ref. Named by content, a source is never overwritten: undoing an attach finds
   * the file it had. Copies are clones where the filesystem allows, never links to the original.
   */
  async addSource(file: string, kind: string, { link: linkOnly = false }: { link?: boolean } = {}): Promise<FileRef> {
    const sha256 = await sha256File(file), bytes = (await stat(file)).size;
    if (linkOnly) return { path: path.resolve(file), sha256, bytes, mimeType: mimeOf(file) };
    const rel = path.join('sources', `${kind}-${sha256.slice(0, 12)}${path.extname(file).toLowerCase()}`), target = path.join(this.dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    if (path.resolve(file) !== target && !existsSync(target)) {
      const temporary = `${target}.${process.pid}.tmp`;
      await copyFile(file, temporary, fsConstants.COPYFILE_FICLONE);
      await rename(temporary, target);
    }
    return { path: rel.split(path.sep).join('/'), sha256, bytes, mimeType: mimeOf(file) };
  }
}

/** A short label for a batch of ops, for the undo list. */
export function describeOps(ops: readonly unknown[]): string {
  const names = ops.map(o => (typeof o === 'object' && o && 'op' in o ? String((o as { op: unknown }).op) : '?'));
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ');
}

export interface InitOptions {
  video?: string; audio?: string; audioFromVideo?: boolean;
  dancers?: number; title?: string; artist?: string;
  /** Reference the video and audio where they are instead of copying them in. */
  link?: boolean;
  /** Make a browser-playable proxy of the video for the Studio (default: unless it's already WebM). */
  proxy?: boolean;
  /** For non-video projects: the song length. */
  durationMs?: number;
  log?: (message: string) => void;
}
/** A browser-playable copy of the video for the Studio, made once per video. */
async function videoProxy(project: DanceProject, video: string, sha256: string, fps: number, log: (m: string) => void): Promise<string> {
  const rel = `sources/proxy-${sha256.slice(0, 12)}.webm`, file = path.join(project.dir, rel);
  if (!existsSync(file)) {
    log(`Making a browser-playable copy for the Studio (${rel})…`);
    const temporary = `${file}.${process.pid}.tmp.webm`;
    await makeProxy(video, temporary, fps);
    await rename(temporary, file);
  }
  return rel;
}
/** Adds or replaces the project's audio (and with `video`, the video and frame) as a new revision. */
export async function attachSources(project: DanceProject, { audio, video, link = false, proxy, log = () => {} }:
  { audio?: string; video?: string; link?: boolean; proxy?: boolean; log?: (m: string) => void }): Promise<Dance> {
  // The slow part first (probing, hashing, copying, transcoding), then the change under the lock.
  let videoSource: { ref: FileRef; info: Awaited<ReturnType<typeof probeVideo>>; proxy: string | null } | null = null;
  if (video) {
    const info = await probeVideo(video);
    const ref = await project.addSource(video, 'video', { link });
    const proxyPath = proxy ?? !['vp8', 'vp9', 'av1'].includes(info.codec) ? await videoProxy(project, video, ref.sha256, info.fps, log) : null;
    videoSource = { ref, info, proxy: proxyPath };
  }
  let audioSource: { ref: FileRef; ms: number } | null = null;
  if (audio) audioSource = { ms: await probeAudioMs(audio), ref: await project.addSource(audio, 'audio', { link }) };
  return project.update([audio && 'attach audio', video && 'attach video'].filter(Boolean).join(', '), next => {
    if (videoSource) {
      const { ref, info } = videoSource;
      if (next.frame.width / next.frame.height !== info.width / info.height && next.dancers.some(d => Object.keys(d.layers[0].channels).length))
        log(`Note: the frame changes from ${next.frame.width}×${next.frame.height} to ${info.width}×${info.height}; existing keys keep their frame coordinates`);
      next.sources.video = { ...ref, width: info.width, height: info.height, fps: info.fps, durationMs: info.durationMs,
        startMs: next.sources.video?.startMs ?? 0, rate: next.sources.video?.rate ?? 1, proxy: videoSource.proxy };
      next.frame = { width: info.width, height: info.height };
    }
    if (audioSource) {
      const hadAudio = next.sources.audio !== null, wholeSong = next.song.playableEndMs === next.song.durationMs;
      next.sources.audio = { ...audioSource.ref, durationMs: audioSource.ms };
      if (!hadAudio) {
        next.song.durationMs = audioSource.ms;
        next.song.playableEndMs = Math.min(audioSource.ms, Math.max(next.song.playableStartMs + 1, wholeSong ? audioSource.ms : next.song.playableEndMs));
      }
    }
  });
}

/** Creates a dance project folder: the dance, its sources and the .dance folder. */
export async function initProject(dir: string, options: InitOptions = {}): Promise<DanceProject> {
  const log = options.log ?? (() => {});
  const project = new DanceProject(dir);
  if (DanceProject.exists(project.dir)) throw Error(`${project.dir} already has a ${DANCE_FILE}`);
  await mkdir(project.dir, { recursive: true });
  await writeFile(path.join(project.dir, '.gitignore'), '.dance/\n', { flag: 'wx' }).catch(() => {});
  const video = options.video ? await probeVideo(options.video) : null;
  let durationMs = options.durationMs ?? 30_000;
  const dance = newDance({ dancers: options.dancers ?? 1, title: options.title ?? '', frame: video ? { width: video.width, height: video.height } : undefined, durationMs });
  dance.song.artist = options.artist ?? '';
  if (options.video && video) {
    log(`Video: ${video.width}x${video.height}, ${video.fps} fps, ${(video.durationMs / 1000).toFixed(1)} s (${video.codec})`);
    const ref = await project.addSource(options.video, 'video', { link: options.link });
    const proxy = options.proxy ?? !['vp8', 'vp9', 'av1'].includes(video.codec) ? await videoProxy(project, options.video, ref.sha256, video.fps, log) : null;
    dance.sources.video = { ...ref, width: video.width, height: video.height, fps: video.fps, durationMs: video.durationMs, startMs: 0, rate: 1, proxy };
    durationMs = video.durationMs;
  }
  let audioFile = options.audio ?? null, extracted: string | null = null;
  if (!audioFile && options.audioFromVideo !== false && options.video && video?.hasAudio) {
    audioFile = extracted = project.meta(`extracted-${process.pid}.wav`);
    log('Extracting the video\'s audio as the song…');
    await extractAudio(options.video, audioFile);
  }
  if (audioFile) {
    const ms = await probeAudioMs(audioFile);
    const ref = await project.addSource(audioFile, 'audio', { link: options.link && !extracted });
    if (extracted) await rm(extracted, { force: true });
    dance.sources.audio = { ...ref, durationMs: ms };
    durationMs = ms;
  }
  dance.song.durationMs = durationMs;
  dance.song.playableEndMs = durationMs;
  assertDance(dance);
  await writeFile(project.file, formatJson(dance) + '\n');
  return project;
}
