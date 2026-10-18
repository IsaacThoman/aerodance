/*
 * Puts another device's performance.now() times on this one's clock, from ping round trips
 * (NTP's method): we send t0, they answer with their time t1, it arrives back at t2. With
 * symmetric delays their clock reads t1 at our (t0 + t2) / 2, so offset = t1 − (t0 + t2) / 2.
 *
 * The round trip with the least delay gives the best estimate, so the clock keeps the recent
 * samples and uses the quickest. Keeping only recent ones lets it follow the two clocks
 * drifting apart. The error is at most half that round trip (the uncertainty).
 *
 * const clock = new ClockSync();
 * clock.add(t0, t1, t2) for each pong; clock.ready; clock.toLocal(theirTime); clock.uncertaintyMs
 */

export interface ClockSample { at: number; rttMs: number; offsetMs: number; }

// Samples older than this are dropped.
const WINDOW_MS = 20_000;
// Round trips slower than this say little about the offset.
const MAX_RTT_MS = 1000;
const MIN_SAMPLES = 3;

export class ClockSync {
  samples: ClockSample[] = [];
  best: ClockSample | null = null;

  /** A round trip: sent at t0 (ours), answered at t1 (theirs), back at t2 (ours). */
  add(t0: number, t1: number, t2: number) {
    const rttMs = t2 - t0;
    if (![t0, t1, t2].every(Number.isFinite) || rttMs < 0 || rttMs > MAX_RTT_MS) return;
    this.samples.push({ at: t2, rttMs, offsetMs: t1 - (t0 + t2) / 2 });
    this.samples = this.samples.filter((s) => t2 - s.at <= WINDOW_MS);
    this.best = this.samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
  }

  /** Enough round trips to trust the offset. */
  get ready() { return this.samples.length >= MIN_SAMPLES; }
  /** Their clock minus ours. */
  get offsetMs() { return this.best?.offsetMs ?? 0; }
  /** How wrong toLocal() can be, at most. */
  get uncertaintyMs() { return this.best ? this.best.rttMs / 2 : Infinity; }
  /** Their performance.now() time on our clock. */
  toLocal(theirMs: number) { return theirMs - this.offsetMs; }
  reset() { this.samples = []; this.best = null; }
}
