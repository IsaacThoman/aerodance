/** How a song position maps to the browser clock (performance.now()) once playback is scheduled. */
export interface AudioAnchor {
  browserTimeMs: number; songPositionMs: number; rate: number;
  method: 'audio-context-browser-observation'; timingUncertaintyMs: null;
}
export interface DecodedAudio { durationMs: number; peaks: number[]; }
export class AudioTransport {
  context: AudioContext | null = null;
  buffer: AudioBuffer | null = null;
  source: AudioBufferSourceNode | null = null;
  positionMs = 0;
  rate = 1;
  active = false;
  /** AudioContext time playback starts (after any lead-in). */
  startTime = 0;
  audioAnchor: AudioAnchor | null = null;
  async contextReady() {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }
  async load(bytes: ArrayBuffer): Promise<DecodedAudio> {
    // Decoding saved music must work before a user gesture. Resuming here can
    // wait indefinitely under browser autoplay restrictions and block startup.
    if (!this.context) this.context = new AudioContext();
    const context = this.context;
    const buffer = await context.decodeAudioData(bytes.slice(0));
    this.pause();
    this.buffer = buffer;
    this.positionMs = 0;
    const channel = buffer.getChannelData(0),
      peaks: number[] = [];
    for (let i = 0; i < 300; i++) {
      const a = Math.floor((i * channel.length) / 300),
        b = Math.floor(((i + 1) * channel.length) / 300);
      let max = 0;
      for (let j = a; j < b; j += Math.max(1, Math.floor((b - a) / 200)))
        max = Math.max(max, Math.abs(channel[j]));
      peaks.push(max);
    }
    return { durationMs: Math.round(buffer.duration * 1000), peaks };
  }
  current() {
    return this.active && this.context
      ? this.positionMs +
          (this.context.currentTime - this.startTime) * 1000 * this.rate
      : this.positionMs;
  }
  atBrowserTime(browserTimeMs: number) {
    if (!this.audioAnchor) throw Error('Start audio before mapping camera frames');
    return this.audioAnchor.songPositionMs +
      (browserTimeMs - this.audioAnchor.browserTimeMs) * this.audioAnchor.rate;
  }
  async play(positionMs = 0, delaySeconds = 0, rate = 1) {
    if (!this.buffer) throw Error("Import song audio before playing");
    const context = await this.contextReady();
    this.pause();
    this.positionMs = positionMs;
    this.rate = rate;
    this.startTime = context.currentTime + delaySeconds;
    this.audioAnchor = {
      browserTimeMs: performance.now() + (this.startTime - context.currentTime) * 1000,
      songPositionMs: positionMs, rate,
      method: 'audio-context-browser-observation', timingUncertaintyMs: null,
    };
    const source = context.createBufferSource();
    this.source = source;
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    source.connect(context.destination);
    source.start(this.startTime, Math.max(0, positionMs) / 1000);
    this.active = true;
  }
  pause() {
    if (this.active) this.positionMs = this.current();
    this.active = false;
    try {
      this.source?.stop();
    } catch { /* already stopped */ }
    this.source?.disconnect();
    this.source = null;
    return this.positionMs;
  }
  seek(time: number) {
    this.pause();
    this.positionMs = time;
  }
  dispose() {
    this.pause();
    void this.context?.close();
  }
}
