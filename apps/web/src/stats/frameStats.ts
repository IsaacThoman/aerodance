/*
 * The numbers behind the stats overlay (StatsOverlay.tsx), kept free of the renderer so they can
 * be tested: timed samples over a sliding window, and how they are summarised and printed.
 */

/** Samples (frame times, pose ages, ...) taken at performance.now() times, kept for windowMs. */
export class SampleWindow {
  windowMs: number;
  times: number[] = [];
  values: number[] = [];
  constructor(windowMs: number) { this.windowMs = windowMs; }

  add(at: number, value: number) {
    this.times.push(at);
    this.values.push(value);
    this.prune(at);
  }
  /** Drops the samples older than the window at `now`. */
  prune(now: number) {
    let drop = 0;
    while (drop < this.times.length && now - this.times[drop] > this.windowMs) drop++;
    if (!drop) return;
    this.times.splice(0, drop);
    this.values.splice(0, drop);
  }
  clear() { this.times.length = 0; this.values.length = 0; }
  get size() { return this.values.length; }
}

/** The value below which a fraction p (0..1) of the samples fall (nearest rank); NaN for none. */
export function percentile(values: readonly number[], p: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export const mean = (values: readonly number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);

export interface FrameSummary {
  /** Frames per second over the window. */
  fps: number;
  /** Mean, 99th percentile and longest frame interval (ms). */
  avgMs: number;
  p99Ms: number;
  maxMs: number;
}

/** Summarises frame intervals (ms): NaNs while there are none. */
export function summariseFrames(intervals: readonly number[]): FrameSummary {
  const avgMs = mean(intervals);
  return { fps: 1000 / avgMs, avgMs, p99Ms: percentile(intervals, 0.99), maxMs: intervals.length ? Math.max(...intervals) : NaN };
}

/** Events per second from the times they arrived at (performance.now() ms), within the window. */
export function rate(times: readonly number[]) {
  if (times.length < 2) return 0;
  return ((times.length - 1) * 1000) / Math.max(1, times[times.length - 1] - times[0]);
}

/** A number to `digits` decimals, or "--" when there isn't one. */
export const fixed = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(digits));

/** Counts in 4 characters or so: 950, 12.3K, 4.5M. */
export function count(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '--';
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}K`;
  return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
}

/** A WebGL renderer string, without the ANGLE wrapping: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)" → "Apple M5 Pro (Metal)". */
export function gpuName(renderer: string) {
  const angle = /^ANGLE \((.*)\)$/.exec(renderer.trim());
  if (!angle) return renderer.trim();
  const parts = angle[1].split(', ');
  const metal = /ANGLE (\w+) Renderer: (.*)/.exec(parts[1] ?? '');
  if (metal) return `${metal[2]} (${metal[1]})`;
  // ANGLE (Vendor, Device Direct3D11 vs_5_0 ps_5_0, D3D11): the device and the backend.
  const device = (parts[1] ?? parts[0]).replace(/\s+(Direct3D\S*|vs_\S+|ps_\S+|\(0x[0-9A-F]+\))/gi, '').trim();
  return parts[2] ? `${device} (${parts[2]})` : device;
}
