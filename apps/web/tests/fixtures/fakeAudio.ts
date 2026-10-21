// A stand-in for the page's AudioContext (audio/mixer.ts), so the real song player
// (audio/songPlayer.ts) runs in Node on a test clock: performance.now() and setTimeout are
// mocked, the context renders as the clock moves, and a buffer source ends once its last
// sample is rendered. Its output timestamp is WebKit's (the rendered position, leaving the
// output latency out) or, with trailing, Chrome's and the Apple TV app's (already trailing by it).
import type { TestContext } from 'node:test';

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  endAt: number;
  done: boolean;
  /** Where in the song the last start() began, in seconds. */
  offset: number;
  connect(): void;
  disconnect(): void;
  start(at: number, offset: number, duration: number): void;
  stop(): void;
}

export interface FakeAudio {
  ctx: { state: string; currentTime: number; baseLatency: number; outputLatency: number };
  /** performance.now(). */
  now: number;
  sources: FakeSource[];
  /** Moves time on in 10 ms steps: the context renders (while running), sources end, timers fire. */
  advance(ms: number): void;
  /** Stops the context (a phone call takes the audio): its time stands still. */
  setState(state: 'running' | 'suspended' | 'interrupted'): void;
}

export function installFakeAudio(t: TestContext, { latencyMs, trailing = false, bufferMs = 60_000 }: { latencyMs: number; trailing?: boolean; bufferMs?: number }): FakeAudio {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stampPerf = 1000;
  let rendered = 0; // ms, kept whole so the clock adds up exactly
  const gain = () => ({ gain: { value: 1 }, connect: <T>(node: T) => node, disconnect() {} });
  const ctx = {
    state: 'running',
    currentTime: 0,
    baseLatency: 0.005,
    outputLatency: latencyMs / 1000,
    getOutputTimestamp: () => ({ contextTime: ctx.currentTime - (trailing ? latencyMs / 1000 : 0), performanceTime: stampPerf }),
    createGain: gain,
    createBufferSource(): FakeSource {
      const source: FakeSource = {
        buffer: null, onended: null, endAt: Infinity, done: false, offset: 0,
        connect() {}, disconnect() {},
        start(at, offset, duration) { source.endAt = at + duration; source.offset = offset; },
        stop() { source.done = true; },
      };
      audio.sources.push(source);
      return source;
    },
    decodeAudioData: async () => ({ duration: bufferMs / 1000 }),
    resume: async () => { ctx.state = 'running'; },
  };
  const audio: FakeAudio = {
    ctx,
    now: 1000,
    sources: [],
    advance(ms) {
      for (let left = ms; left > 0; left -= 10) {
        const step = Math.min(10, left);
        audio.now += step;
        if (ctx.state === 'running') { rendered += step; ctx.currentTime = rendered / 1000; stampPerf = audio.now; }
        for (const s of audio.sources) {
          if (!s.done && ctx.currentTime >= s.endAt - 1e-9) { s.done = true; s.onended?.(); }
        }
        t.mock.timers.tick(step);
      }
    },
    setState(state) { ctx.state = state; },
  };
  t.mock.method(performance, 'now', () => audio.now);
  const mixer = { ctx, master: gain(), music: gain(), menuMusic: gain(), menuDuck: gain(), sfx: gain() };
  const page = globalThis as Record<symbol, unknown>;
  const key = Symbol.for('aerodance.mixer');
  const before = page[key];
  page[key] = mixer;
  t.after(() => { page[key] = before; });
  return audio;
}
