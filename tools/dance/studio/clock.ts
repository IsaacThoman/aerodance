// The Studio's song clock. The song audio is the master while it plays; without audio a timer
// stands in. Views that animate (video, overlay, 3D, timeline) read now() each frame; React
// state only hears about seeks, play/pause and a few updates a second. The clock stops at the
// end of the song on time by itself, however slowly frames are drawn.
export type ClockListener = () => void;
export class SongClock {
  private audio: HTMLAudioElement | null = null;
  private startedAt = 0;
  private startedFrom = 0;
  private position = 0;
  private listeners = new Set<ClockListener>();
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  playing = false;
  rate = 1;
  durationMs = 0;
  /** Loops [a, b] while set. */
  loop: [number, number] | null = null;
  attach(url: string | null) {
    this.audio?.pause();
    this.audio = null;
    if (!url) return;
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.onended = () => { this.pause(); };
    this.audio = audio;
  }
  now(): number {
    const t = this.elapsed();
    if (this.playing && this.loop && t >= this.loop[1]) { this.seek(this.loop[0]); return this.loop[0]; }
    if (this.playing && this.durationMs && t >= this.durationMs) { this.stop(this.durationMs); return this.durationMs; }
    return t;
  }
  /** Where the song is, before looping or stopping at its end. */
  private elapsed(): number {
    if (!this.playing) return this.position;
    if (this.audio && !this.audio.paused) return this.audio.currentTime * 1000;
    return this.startedFrom + (performance.now() - this.startedAt) * this.rate;
  }
  seek(ms: number) {
    const t = Math.max(0, Math.min(this.durationMs || Infinity, ms));
    this.position = t;
    this.startedFrom = t;
    this.startedAt = performance.now();
    if (this.audio) this.audio.currentTime = t / 1000;
    this.scheduleEnd();
    this.emit();
  }
  async play() {
    if (this.playing) return;
    if (this.loop && (this.position < this.loop[0] || this.position >= this.loop[1])) this.position = this.loop[0];
    this.playing = true;
    this.startedFrom = this.position;
    this.startedAt = performance.now();
    if (this.audio) {
      this.audio.currentTime = this.position / 1000;
      this.audio.playbackRate = this.rate;
      try { await this.audio.play(); } catch { /* blocked autoplay or no audio output: keep time with the timer */ }
    }
    this.scheduleEnd();
    this.emit();
  }
  pause() {
    if (!this.playing) return;
    this.stop(Math.min(this.elapsed(), this.durationMs || Infinity));
  }
  private stop(at: number) {
    this.position = at;
    this.playing = false;
    this.scheduleEnd();
    this.audio?.pause();
    this.emit();
  }
  toggle() { if (this.playing) this.pause(); else void this.play(); }
  setRate(rate: number) {
    const t = this.now();
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = rate;
    this.startedFrom = t; this.startedAt = performance.now(); this.position = t;
    this.scheduleEnd();
    this.emit();
  }
  /** While playing, a timer for the end of the song, so it stops then even if nothing reads now(). */
  private scheduleEnd() {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (!this.playing || !this.durationMs) return;
    const left = (this.durationMs - this.elapsed()) / this.rate;
    // now() stops the clock once the song is over; the audio may run a little behind, so look again.
    this.endTimer = setTimeout(() => { this.endTimer = null; if (this.playing && this.now() < this.durationMs) this.scheduleEnd(); }, Math.max(0, left) + 5);
  }
  subscribe(fn: ClockListener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }
}
