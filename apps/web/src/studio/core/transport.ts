// The Studio's song clock: plays the project's music (or keeps silent time without any), seeks,
// loops a section, slows down, counts in with a click, and says which song position was audible
// at any performance.now() time, which is how recorded poses get their song times (the game
// stamps players' poses the same way, apps/web/src/audio/songPlayer.ts).
import { audibleTime } from '../../audio/songPlayer.ts';

export interface TransportState {
  /** The music is decoded (or there is none to wait for). */
  ready: boolean; hasAudio: boolean;
  playing: boolean; rate: number;
  /** While set, playback wraps from the end of the range to its start. */
  loop: readonly [number, number] | null;
  durationMs: number;
  /** A click on every beat while playing (always during a count-in before the song's start). */
  metronome: boolean;
  volume: number;
}
export interface BeatGridLike { bpm: number | null; beatOffsetMs: number; }
type Listener = () => void;
interface Anchor { /** Context seconds at which `songMs` plays (unwrapped by loops). */ ctxTime: number; songMs: number; rate: number; loop: readonly [number, number] | null; }

export class Transport {
  state: TransportState = { ready: true, hasAudio: false, playing: false, rate: 1, loop: null, durationMs: 60_000, metronome: false, volume: 1 };
  /** The song mixed to mono, for waveforms and beat detection. */
  pcm: Float32Array | null = null;
  sampleRate = 44100;
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private anchor: Anchor | null = null;
  private position = 0;
  private grid: BeatGridLike = { bpm: null, beatOffsetMs: 0 };
  private clickTimer: ReturnType<typeof setInterval> | null = null;
  private clickedTo = -Infinity;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private loadId = 0;

  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  private set(patch: Partial<TransportState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.state.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }
  /** Loads the song (null: no music, a silent clock of `durationMs`). */
  async load(blob: Blob | null, durationMs: number): Promise<void> {
    const id = ++this.loadId;
    this.pause();
    this.buffer = null; this.pcm = null;
    if (!blob) { this.set({ ready: true, hasAudio: false, durationMs }); return; }
    this.set({ ready: false, hasAudio: true, durationMs });
    const ctx = this.context(), buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (id !== this.loadId) return;
    this.buffer = buffer; this.sampleRate = buffer.sampleRate;
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels; }
    this.pcm = mono;
    this.position = Math.min(this.position, buffer.duration * 1000);
    this.set({ ready: true, durationMs: buffer.duration * 1000 });
  }
  /** The beat grid the metronome clicks on. */
  setGrid(grid: BeatGridLike) { this.grid = { bpm: grid.bpm, beatOffsetMs: grid.beatOffsetMs }; }
  setMetronome(metronome: boolean) { this.set({ metronome }); }
  setVolume(volume: number) { if (this.gain) this.gain.gain.value = volume; this.set({ volume }); }

  /** Song time, unwrapped by loops, at a context time while playing. */
  private unwrapped(ctxTime: number): number { const a = this.anchor!; return a.songMs + (ctxTime - a.ctxTime) * 1000 * a.rate; }
  private wrap(u: number): { songMs: number; pass: number } {
    const loop = this.anchor?.loop;
    if (!loop || u < loop[1]) return { songMs: u, pass: 0 };
    const length = loop[1] - loop[0], over = u - loop[1];
    return { songMs: loop[0] + over % length, pass: 1 + Math.floor(over / length) };
  }
  private clockSeconds(perfMs?: number): number {
    if (!this.ctx) return (perfMs ?? performance.now()) / 1000;
    return perfMs === undefined ? audibleTime(this.ctx, performance.now(), performance.now()) : audibleTime(this.ctx, perfMs, performance.now());
  }
  /** The song position being heard now. Before the song's start during a count-in it is negative. */
  timeMs(): number { return this.songTimeAt(); }
  /** The song position that was (or will be) heard at a performance.now() time. */
  songTimeAt(perfMs?: number): number {
    if (!this.anchor) return this.position;
    const { songMs } = this.wrap(this.unwrapped(this.clockSeconds(perfMs)));
    return this.anchor.loop ? songMs : Math.min(songMs, this.state.durationMs);
  }
  /** How many times the loop had wrapped at a performance.now() time (0 on the first pass). */
  passAt(perfMs?: number): number { return this.anchor ? this.wrap(this.unwrapped(this.clockSeconds(perfMs))).pass : 0; }

  /**
   * Plays from `fromMs` (default: where it is). A negative start counts in: silence until the
   * song's start, with a click per beat. `loop` wraps playback within a range from then on.
   */
  play({ fromMs = this.position, loop = this.state.loop }: { fromMs?: number; loop?: readonly [number, number] | null } = {}) {
    this.stopSource();
    const rate = this.state.rate, duration = this.state.durationMs;
    if (loop && !(loop[1] - loop[0] >= 200)) loop = null;
    if (fromMs >= duration - 5 && !loop) fromMs = 0;
    // Past the loop's end there is nothing to play into it from: start at its start.
    if (loop && fromMs >= loop[1]) fromMs = loop[0];
    // A song with a tempo clicks even without music, and the clock must be the one the clicks use.
    const ctx = this.buffer || this.grid.bpm ? this.context() : this.ctx;
    if (ctx?.state === 'suspended') void ctx.resume();
    const now = ctx ? ctx.currentTime + 0.06 : performance.now() / 1000;
    this.anchor = { ctxTime: now, songMs: fromMs, rate, loop };
    if (this.buffer && ctx) {
      const source = ctx.createBufferSource();
      source.buffer = this.buffer; source.playbackRate.value = rate;
      source.connect(this.gain!);
      if (loop) { source.loop = true; source.loopStart = loop[0] / 1000; source.loopEnd = Math.min(this.buffer.duration, loop[1] / 1000); }
      source.start(now + Math.max(0, -fromMs) / 1000 / rate, Math.max(0, fromMs) / 1000);
      this.source = source;
    }
    this.clickedTo = fromMs - 1;
    this.clickTimer = setInterval(() => this.scheduleClicks(), 60);
    this.scheduleClicks();
    if (!loop) this.endTimer = setTimeout(() => { if (this.anchor) { this.pause(); this.position = duration; this.set({}); } }, (duration - fromMs) / rate + 250);
    this.set({ playing: true, loop });
  }
  private stopSource() {
    if (this.source) { try { this.source.stop(); } catch { /* not started */ } this.source.disconnect(); this.source = null; }
    if (this.clickTimer) { clearInterval(this.clickTimer); this.clickTimer = null; }
    if (this.endTimer) { clearTimeout(this.endTimer); this.endTimer = null; }
  }
  pause() {
    if (!this.anchor) return;
    this.position = Math.max(0, Math.min(this.state.durationMs, this.timeMs()));
    this.anchor = null;
    this.stopSource();
    this.set({ playing: false });
  }
  toggle() { if (this.state.playing) this.pause(); else this.play(); }
  seek(ms: number) {
    const to = Math.max(0, Math.min(this.state.durationMs, ms));
    if (this.anchor) this.play({ fromMs: to }); else { this.position = to; this.set({}); }
  }
  setRate(rate: number) {
    if (rate === this.state.rate) return;
    const at = this.timeMs(), playing = this.state.playing;
    if (playing) { this.anchor = null; this.stopSource(); }
    this.position = at;
    this.state = { ...this.state, rate };
    if (playing) this.play({ fromMs: at }); else this.set({});
  }
  /** Sets or clears the loop; while playing, it takes effect from where the song is. */
  setLoop(loop: readonly [number, number] | null) {
    if (this.state.playing) this.play({ fromMs: Math.max(loop?.[0] ?? -Infinity, Math.min(this.timeMs(), loop?.[1] ?? Infinity)), loop });
    else this.set({ loop });
  }
  /** Clicks for the beats in the next moments of playback: all of them in a count-in, else only with the metronome on. */
  private scheduleClicks() {
    const ctx = this.ctx, anchor = this.anchor;
    if (!ctx || !anchor || !this.grid.bpm) return;
    const beat = 60000 / this.grid.bpm, until = this.unwrapped(ctx.currentTime + 0.25), loop = anchor.loop;
    // Beats are on the song's grid, so each time round a loop they fall where they fell before,
    // whatever the loop's length: step from beat to beat in song time, pass by pass.
    for (let guard = 0; guard < 64; guard++) {
      const from = this.clickedTo + 0.01, { songMs } = this.wrap(from);
      const n = Math.ceil((songMs - this.grid.beatOffsetMs) / beat), song = this.grid.beatOffsetMs + n * beat;
      // No beat left before the loop wraps: carry on from the start of the next pass.
      if (loop && song >= loop[1] - 0.01) { const next = from + (loop[1] - songMs); if (next > until) break; this.clickedTo = next - 0.01; continue; }
      const u = from + (song - songMs);
      if (u > until) break;
      this.clickedTo = u;
      if (!(song < 0 || this.state.metronome)) continue;
      const when = anchor.ctxTime + (u - anchor.songMs) / 1000 / anchor.rate;
      if (when < ctx.currentTime) continue;
      const osc = ctx.createOscillator(), env = ctx.createGain(), downbeat = ((n % 4) + 4) % 4 === 0;
      osc.frequency.value = downbeat ? 1320 : 880;
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(0.35, when + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      osc.connect(env).connect(ctx.destination);
      osc.start(when); osc.stop(when + 0.08);
    }
  }
  dispose() { this.loadId++; this.pause(); this.stopSource(); void this.ctx?.close(); this.ctx = null; this.listeners.clear(); }
}
