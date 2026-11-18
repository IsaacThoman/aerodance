// An open project: its dance, takes and history, and the only way the Studio changes them.
// Stations read `state` (through useSession) and call apply/undo/redo; every edit is a batch of
// ops (packages/dance/ops.ts), saved as the next revision before the state changes.
import { applyOps } from '../../../../../packages/dance/ops.ts';
import type { ChangeSummary } from '../../../../../packages/dance/ops.ts';
import { DANCE_FILE } from '../../../../../packages/dance/store.ts';
import type { AttemptInfo, DanceStore, TakeInfo } from '../../../../../packages/dance/store.ts';
import type { Dance, TakeSource } from '../../../../../packages/dance/format.ts';
import type { TakeLookup } from '../../../../../packages/dance/evaluate.ts';
import type { TrackedFrame } from '../../../../../packages/dance/takes.ts';
import { Transport } from './transport.ts';

export interface SessionState {
  /** The saved dance. */
  dance: Dance;
  /** The dance to show: the saved one, or an unsaved preview of an edit in progress (a drag). */
  shown: Dance;
  takes: TakeLookup;
  undo: string | null; redo: string | null;
  /** What the session is busy doing, for a status line; edits wait their turn meanwhile. */
  busy: string | null;
  /** The last thing that went wrong, until dismissed. */
  error: string | null;
  attempts: AttemptInfo[];
}
type Listener = () => void;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export class ProjectSession {
  readonly id: string;
  readonly store: DanceStore;
  readonly transport = new Transport();
  state: SessionState;
  private listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  private constructor(id: string, store: DanceStore, state: SessionState) { this.id = id; this.store = store; this.state = state; }
  /** Opens a project: reads its dance and takes, and loads its music into the transport. */
  static async open(id: string, store: DanceStore): Promise<ProjectSession> {
    const dance = await store.read(), [takes, log, attempts] = await Promise.all([store.takes(dance), store.log(), store.attempts()]);
    const session = new ProjectSession(id, store, { dance, shown: dance, takes, busy: null, error: null, attempts,
      undo: log.undo[log.undo.length - 1]?.label ?? null, redo: log.redo[log.redo.length - 1]?.label ?? null });
    session.transport.setGrid(dance.song);
    void session.loadAudio();
    session.watch();
    return session;
  }
  /**
   * Picks up changes made elsewhere (another tab, or the `dance` CLI working in a folder
   * project): dance.json's modification time is looked at every second or two, and a revision
   * that isn't the one shown is read in.
   */
  private watch() {
    let seen = 0;
    this.watcher = setInterval(() => {
      if (this.checking || this.state.busy) return;
      this.checking = true;
      void (async () => {
        try {
          const file = await this.store.files.blob(DANCE_FILE), modified = file instanceof File ? file.lastModified : 0;
          if (!modified || modified === seen) return;
          seen = modified;
          await this.enqueue(async () => { const dance = await this.store.read(); if (dance.revision !== this.state.dance.revision) await this.refresh(dance); });
        } catch { /* mid-write, or the folder is away: the next look will see it */ } finally { this.checking = false; }
      })();
    }, 1500);
  }
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  private set(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
  private async loadAudio() {
    const { audio } = this.state.dance.sources;
    try { await this.transport.load(audio ? await this.store.files.blob(audio.path) : null, this.state.dance.song.durationMs); }
    catch (e) { this.set({ error: `The music couldn't be played: ${message(e)}` }); }
  }
  /** One change at a time, in order. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
  private async refresh(dance: Dance, extra: Partial<SessionState> = {}) {
    const log = await this.store.log(), before = this.state.dance;
    const takes = dance.sources.takes === before.sources.takes || JSON.stringify(dance.sources.takes) === JSON.stringify(before.sources.takes) ? this.state.takes : await this.store.takes(dance);
    this.set({ dance, shown: dance, takes, undo: log.undo[log.undo.length - 1]?.label ?? null, redo: log.redo[log.redo.length - 1]?.label ?? null, ...extra });
    this.transport.setGrid(dance.song);
    if (dance.sources.audio?.sha256 !== before.sources.audio?.sha256) void this.loadAudio();
    // Without music the clock runs for as long as the dance says the song is (a video sets that).
    else if (!dance.sources.audio && dance.song.durationMs !== this.transport.state.durationMs) void this.transport.load(null, dance.song.durationMs);
  }
  /**
   * Applies ops as the next revision. Resolves with what changed, or null when the edit was
   * refused (state.error says why); it never throws for a bad edit.
   */
  apply(ops: unknown[], label?: string): Promise<ChangeSummary | null> {
    return this.enqueue(async () => {
      try {
        const result = await this.store.apply({ ops, label, expectRevision: this.state.dance.revision });
        await this.refresh(result.dance, { error: null });
        return result.summary;
      } catch (e) { this.set({ shown: this.state.dance, error: message(e) }); return null; }
    });
  }
  /**
   * Shows what ops would do without saving them (for a drag in progress); null clears the
   * preview. Returns false when the ops don't apply.
   */
  preview(ops: unknown[] | null): boolean {
    if (!ops) { if (this.state.shown !== this.state.dance) this.set({ shown: this.state.dance }); return true; }
    try { this.set({ shown: applyOps(this.state.dance, ops, { takes: this.state.takes }).dance }); return true; }
    catch { return false; }
  }
  private step(direction: 'undo' | 'redo') {
    return this.enqueue(async () => {
      try { const result = await this.store.step(direction); if (result) await this.refresh(result.dance, { error: null }); }
      catch (e) { this.set({ error: message(e) }); }
    });
  }
  undo() { return this.step('undo'); }
  redo() { return this.step('redo'); }
  dismissError() { if (this.state.error) this.set({ error: null }); }
  fail(error: string) { this.set({ error }); }
  /** Runs slow work (decoding, tracking) under a status line; errors land in state.error. */
  async busy<T>(label: string, run: () => Promise<T>): Promise<T | null> {
    this.set({ busy: label });
    try { return await run(); } catch (e) { this.set({ error: message(e) }); return null; } finally { this.set({ busy: null }); }
  }

  // ---- Sources ----

  /** Sets the song's music: an MP3 or OGG file. The song takes the music's length. */
  async attachAudio(file: File): Promise<boolean> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['mp3', 'ogg'].includes(extension)) { this.set({ error: 'The music needs to be an MP3 or OGG file.' }); return false; }
    return await this.busy('Adding the music…', async () => {
      const probe = new AudioContext();
      let durationMs: number;
      try { durationMs = (await probe.decodeAudioData(await file.arrayBuffer())).duration * 1000; }
      catch { throw Error('This browser couldn\'t read that file as music. Try another MP3 or OGG.'); }
      finally { void probe.close(); }
      const ref = await this.store.addSource('audio', file.name, file);
      await this.enqueue(async () => {
        const dance = await this.store.update('add the music', next => {
          const whole = next.song.playableEndMs === next.song.durationMs && next.song.playableStartMs === 0;
          next.sources.audio = { ...ref, mimeType: extension === 'mp3' ? 'audio/mpeg' : 'audio/ogg', durationMs };
          next.song.durationMs = durationMs;
          next.song.playableEndMs = whole ? durationMs : Math.min(durationMs, next.song.playableEndMs);
          next.song.playableStartMs = Math.min(next.song.playableStartMs, next.song.playableEndMs - 1);
        });
        await this.refresh(dance);
      });
      return true;
    }) ?? false;
  }
  /** Sets the reference video (a file the browser can play). The dance's frame takes its shape. */
  async attachVideo(file: File): Promise<boolean> {
    return await this.busy('Adding the video…', async () => {
      const url = URL.createObjectURL(file), video = document.createElement('video');
      try {
        video.preload = 'metadata'; video.muted = true; video.src = url;
        await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(Error('This browser can\'t play that video. Try an MP4 or WebM.')); });
        const info = { width: video.videoWidth, height: video.videoHeight, durationMs: video.duration * 1000 };
        if (!(info.width > 0 && info.height > 0 && Number.isFinite(info.durationMs))) throw Error('That video has no picture to track.');
        const ref = await this.store.addSource('video', file.name, file);
        await this.enqueue(async () => {
          const dance = await this.store.update('add the video', next => {
            next.sources.video = { ...ref, ...info, fps: 30, startMs: next.sources.video?.startMs ?? 0, rate: 1, proxy: null };
            next.frame = { width: info.width, height: info.height };
            if (!next.sources.audio) { next.song.durationMs = Math.max(next.song.durationMs, info.durationMs); next.song.playableEndMs = next.song.durationMs; }
          });
          await this.refresh(dance);
        });
        return true;
      } finally { URL.revokeObjectURL(url); }
    }) ?? false;
  }
  audioBlob(): Promise<Blob | null> { const a = this.state.dance.sources.audio; return a ? this.store.files.blob(a.path) : Promise.resolve(null); }
  videoBlob(): Promise<Blob | null> { const v = this.state.dance.sources.video; return v ? this.store.files.blob(v.path) : Promise.resolve(null); }
  /** Saves captured poses as a take in the project's library (not yet on any dancer's timeline). */
  addTake(frames: readonly TrackedFrame[], size: { width: number; height: number; slots: number }, info: TakeInfo): Promise<TakeSource | null> {
    return this.enqueue(async () => {
      try { const { dance, take } = await this.store.addTake(frames, size, info); await this.refresh(dance); return take; }
      catch (e) { this.set({ error: message(e) }); return null; }
    });
  }

  // ---- Playtests ----

  async addAttempt(frames: readonly TrackedFrame[], info: Omit<AttemptInfo, 'id' | 'path' | 'createdAt'>): Promise<AttemptInfo | null> {
    try { const entry = await this.store.addAttempt(frames, info); this.set({ attempts: await this.store.attempts() }); return entry; }
    catch (e) { this.set({ error: message(e) }); return null; }
  }
  async removeAttempt(id: string) { await this.store.removeAttempt(id); this.set({ attempts: await this.store.attempts() }); }
  dispose() { if (this.watcher) clearInterval(this.watcher); this.transport.dispose(); this.listeners.clear(); }
}
