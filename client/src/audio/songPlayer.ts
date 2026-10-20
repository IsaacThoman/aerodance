import { getMixer, resumeAudio } from './mixer.ts';
import { hostState } from '../host.ts';

/**
 * Plays a song bundle's audio on the mixer's music bus (so Master, Music and Mute all apply),
 * kept inside the song's playable range: it pauses at the end, and playing from the end
 * starts over. Song time is the audible position: the audio clock mapped through the output
 * timestamp, less any output latency it leaves out (audibleTime), so dancers sampled at
 * timeMs() line up with what is heard, and a pose captured at a performance.now() time maps
 * to the song position the player was hearing then (songTimeAt).
 * On a TV (the iPhone/iPad app's AirPlay Screen Mirroring or HDMI, host.ts) the picture is
 * delayed as much as the sound, so timeMs() is the position being rendered instead, without
 * the output latency taken off; songTimeAt() still takes it off, since what the player saw and
 * heard at a moment is that much behind (drawClock).
 *
 * const player = await createSongPlayer(blob, { startMs, endMs });
 * player.play(); player.play({ delayMs: 3000 }) (scheduled: the countdown); player.pause();
 * player.seek(ms); player.timeMs(); player.rawTimeMs() (unclamped: negative before a
 * scheduled start); player.songTimeAt(perfMs); player.state ('paused' | 'playing');
 * player.ended (true once it plays out to the end); player.audioRunning() (false while a
 * phone call holds the audio, when the clock can't move)
 * const off = player.onChange(() => ...); player.dispose();
 */
export interface SongRange { startMs: number; endMs: number; }
export type SongPlayerState = 'paused' | 'playing';
export interface SongPlayer {
  state: SongPlayerState;
  durationMs: number;
  startMs: number;
  endMs: number;
  ended: boolean;
  timeMs(): number;
  rawTimeMs(): number;
  songTimeAt(perfMs: number): number;
  audioRunning(): boolean;
  play(options?: { delayMs?: number }): void;
  pause(): void;
  seek(ms: number): void;
  onChange(fn: (player: SongPlayer) => void): () => void;
  dispose(): void;
}
export type CreateSongPlayer = (blob: Blob, range: SongRange) => Promise<SongPlayer>;
/** The part of an AudioContext audibleTime reads. */
export type AudioClock = Pick<AudioContext, 'currentTime' | 'baseLatency' | 'outputLatency' | 'state'> & { getOutputTimestamp?: () => AudioTimestamp };

/**
 * The context time being heard at a performance.now() time (now is performance.now()).
 *
 * The output timestamp is meant to be what the speakers are playing. Chrome, Firefox and the
 * Apple TV app (client-tvos/src/Audio.mm) take the output latency off it, but WebKit's is the
 * position being rendered: it leaves out outputLatency, which WebKit does report (AirPods: about
 * 150-250 ms). So whatever part of outputLatency the timestamp doesn't already trail currentTime
 * by is taken off here. correct = false leaves it on (what's drawn on a TV; see above).
 * A context that isn't running (suspended, or interrupted by a phone call) has stopped, so
 * its time holds instead of running on from the last timestamp.
 */
export function audibleTime(ctx: AudioClock, perfMs: number, now: number, correct = true) {
  const output = ctx.outputLatency || 0;
  const latency = output || ctx.baseLatency || 0;
  const { contextTime = 0, performanceTime = 0 } = ctx.getOutputTimestamp?.() ?? {};
  const left = correct ? Math.max(0, output - (ctx.currentTime - contextTime)) : 0;
  const at = contextTime > 0 && performanceTime > 0
    ? contextTime - left + (perfMs - performanceTime) / 1000
    : ctx.currentTime - latency + (perfMs - now) / 1000;
  return ctx.state === 'running' ? at : Math.min(at, ctx.currentTime - latency);
}

/**
 * The clock to draw by: audibleTime, except on a TV (host.ts), where the picture is delayed with
 * the sound and so is drawn at the rendered position. It never steps back until reset() (a new
 * play), so the TV turning on mid-song moves it forward by the output latency at once, and
 * turning off holds it still for that long while the song catches up.
 */
export function drawClock(ctx: AudioClock, tv = () => hostState().tv) {
  let shown = -Infinity;
  return {
    at(perfMs: number, now: number) { return (shown = Math.max(shown, audibleTime(ctx, perfMs, now, !tv()))); },
    reset() { shown = -Infinity; },
  };
}

export async function createSongPlayer(blob: Blob, { startMs, endMs }: SongRange): Promise<SongPlayer> {
  const { ctx, music } = getMixer();
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const end = Math.min(endMs, buffer.duration * 1000);
  const out = ctx.createGain();
  out.connect(music);
  const listeners = new Set<(player: SongPlayer) => void>();
  let source: AudioBufferSourceNode | null = null;
  let positionMs = startMs;
  let startedAt = 0; // ctx time at which song time 0 would have been scheduled
  let playFrom = startMs; // where the current play() starts: song time holds here until then
  const drawn = drawClock(ctx);
  const clamp = (ms: number) => Math.min(end, Math.max(startMs, ms));

  const stop = () => {
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* never started */ }
    source.disconnect();
    source = null;
  };
  const audibleAt = (perfMs: number) => audibleTime(ctx, perfMs, performance.now());

  const player: SongPlayer = {
    state: 'paused',
    durationMs: end - startMs,
    startMs,
    endMs: end,
    ended: false,
    timeMs() {
      const raw = player.rawTimeMs();
      return clamp(player.state === 'playing' ? Math.max(raw, playFrom) : raw);
    },
    rawTimeMs() {
      if (player.state !== 'playing') return positionMs;
      const now = performance.now();
      return (drawn.at(now, now) - startedAt) * 1000;
    },
    /** The song position audible at a performance.now() time (unclamped). */
    songTimeAt(perfMs) {
      if (player.state !== 'playing') return positionMs;
      return (audibleAt(perfMs) - startedAt) * 1000;
    },
    audioRunning() { return ctx.state === 'running'; },
    play({ delayMs = 0 } = {}) {
      if (player.state === 'playing') return;
      resumeAudio(ctx);
      if (positionMs >= end - 1) positionMs = startMs;
      player.ended = false;
      playFrom = positionMs;
      drawn.reset();
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      const at = ctx.currentTime + 0.03 + delayMs / 1000;
      source.start(at, positionMs / 1000, (end - positionMs) / 1000);
      startedAt = at - positionMs / 1000;
      const mine = source;
      source.onended = () => {
        if (source !== mine) return;
        stop();
        positionMs = end;
        player.state = 'paused';
        player.ended = true;
        emit();
      };
      player.state = 'playing';
      emit();
    },
    pause() {
      if (player.state !== 'playing') return;
      // Where the player had got to (songTimeAt: on a TV, what's drawn is ahead of what they
      // have seen), or the start if paused during a scheduled start.
      positionMs = clamp(Math.max(player.songTimeAt(performance.now()), playFrom));
      stop();
      player.state = 'paused';
      emit();
    },
    seek(ms) {
      const playing = player.state === 'playing';
      stop();
      player.state = 'paused';
      positionMs = clamp(ms);
      if (playing) player.play();
      else emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispose() {
      stop();
      out.disconnect();
      listeners.clear();
    },
  };
  function emit() { for (const fn of listeners) fn(player); }
  return player;
}
