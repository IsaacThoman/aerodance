// The Studio's song clock. The song audio is the master while it plays; without audio a timer
// stands in. Views that animate (video, overlay, 3D, timeline) read now() each frame; React
// state only hears about seeks, play/pause and a few updates a second.
export type ClockListener = () => void;
export class SongClock {
  private audio: HTMLAudioElement | null = null;
  private startedAt = 0;
  private startedFrom = 0;
  private position = 0;
  private listeners = new Set<ClockListener>();
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
    let t: number;
    if (!this.playing) t = this.position;
    else if (this.audio && !this.audio.paused) t = this.audio.currentTime * 1000;
    else t = this.startedFrom + (performance.now() - this.startedAt) * this.rate;
    if (this.playing && this.loop && t >= this.loop[1]) { this.seek(this.loop[0]); return this.loop[0]; }
    if (this.playing && this.durationMs && t >= this.durationMs) { this.pause(); return this.durationMs; }
    return t;
  }
  seek(ms: number) {
    const t = Math.max(0, Math.min(this.durationMs || Infinity, ms));
    this.position = t;
    this.startedFrom = t;
    this.startedAt = performance.now();
    if (this.audio) this.audio.currentTime = t / 1000;
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
    this.emit();
  }
  pause() {
    if (!this.playing) return;
    this.position = this.now();
    this.playing = false;
    this.audio?.pause();
    this.emit();
  }
  toggle() { if (this.playing) this.pause(); else void this.play(); }
  setRate(rate: number) {
    const t = this.now();
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = rate;
    this.startedFrom = t; this.startedAt = performance.now(); this.position = t;
    this.emit();
  }
  subscribe(fn: ClockListener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }
}
