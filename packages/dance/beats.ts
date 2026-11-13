// Reads a song's beat grid and rough structure from its audio, so a new dance starts with bars
// to snap to and sections to record. Everything works on mono PCM (any sample rate) and runs in
// a worker or in Node; nothing here needs Web Audio.
//
//   analyzeSong(pcm, sampleRate) → { grid: { bpm, beatOffsetMs, confidence }, sections, peaks }
//
// The tempo is assumed constant (true of nearly all produced music). The estimate is a starting
// point the author confirms: `confidence` says how clearly the beat stood out.

export interface BeatGrid {
  bpm: number;
  /** A downbeat: beat 1 of a bar, the first at or after the start of the song. */
  beatOffsetMs: number;
  /** 0 (no clear pulse) to 1 (a metronome). */
  confidence: number;
}
export interface SectionGuess {
  startMs: number; endMs: number;
  /** "Part A", "Part B", …: sections that sound alike share a label and a group. */
  label: string; group: number;
}
export interface SongAnalysis { grid: BeatGrid | null; sections: SectionGuess[]; }

const TARGET_RATE = 11025, FFT = 512, HOP = 128, BANDS = 12;

const COS = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.cos(-2 * Math.PI * k / FFT));
const SIN = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.sin(-2 * Math.PI * k / FFT));
/** In-place radix-2 FFT of FFT points. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, stride = n / size;
    for (let start = 0; start < n; start += size) for (let k = 0; k < half; k++) {
      const wr = COS[k * stride], wi = SIN[k * stride], a = start + k, b = a + half;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}
/** Mono PCM brought down to about 11 kHz by averaging runs of samples. */
function decimate(pcm: Float32Array, sampleRate: number): { samples: Float32Array; rate: number } {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  if (factor === 1) return { samples: pcm, rate: sampleRate };
  const out = new Float32Array(Math.floor(pcm.length / factor));
  for (let i = 0; i < out.length; i++) { let sum = 0; for (let k = 0; k < factor; k++) sum += pcm[i * factor + k]; out[i] = sum / factor; }
  return { samples: out, rate: sampleRate / factor };
}
export interface Spectral {
  /** Milliseconds per frame, and the time of frame 0 (the middle of its window). */
  hopMs: number; firstMs: number;
  /** How much new sound starts in each frame (all frequencies), and in the bass alone. */
  onset: Float32Array; bass: Float32Array;
  /** Log energy in BANDS bands per frame, [frame * BANDS + band]. */
  bands: Float32Array;
}
/** The onset envelopes and band energies the beat and section estimates read. */
export function spectral(pcm: Float32Array, sampleRate: number): Spectral {
  const { samples, rate } = decimate(pcm, sampleRate);
  const frames = Math.max(0, Math.floor((samples.length - FFT) / HOP) + 1), bins = FFT / 2;
  const window = Float32Array.from({ length: FFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1)));
  const onset = new Float32Array(frames), bass = new Float32Array(frames), bands = new Float32Array(frames * BANDS);
  const re = new Float32Array(FFT), im = new Float32Array(FFT), previous = new Float32Array(bins), bassBins = Math.max(2, Math.round(200 / (rate / FFT)));
  // Band edges spaced evenly in log frequency from about 60 Hz to the top.
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => Math.min(bins, Math.max(1, Math.round(60 * (rate / 2 / 60) ** (b / BANDS) / (rate / FFT)))));
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FFT; i++) { re[i] = samples[f * HOP + i] * window[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0, low = 0;
    for (let k = 1; k < bins; k++) {
      const magnitude = Math.log1p(100 * Math.hypot(re[k], im[k]) / (FFT / 4));
      const rise = magnitude - previous[k];
      if (rise > 0) { flux += rise; if (k <= bassBins) low += rise; }
      previous[k] = magnitude;
    }
    onset[f] = flux; bass[f] = low;
    for (let b = 0; b < BANDS; b++) {
      let energy = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) energy += previous[Math.min(bins - 1, k)];
      bands[f * BANDS + b] = energy / Math.max(1, edges[b + 1] - edges[b]);
    }
  }
  return { hopMs: HOP / rate * 1000, firstMs: FFT / 2 / rate * 1000, onset, bass, bands };
}
/** An envelope less its local average (about half a second either side), clipped at zero. */
function sharpen(envelope: Float32Array, hopMs: number): Float32Array {
  const half = Math.max(1, Math.round(500 / hopMs)), out = new Float32Array(envelope.length);
  let sum = 0;
  for (let i = 0; i < Math.min(envelope.length, half); i++) sum += envelope[i];
  for (let i = 0; i < envelope.length; i++) {
    const a = i - half, b = i + half;
    if (b < envelope.length) sum += envelope[b];
    if (a > 0) sum -= envelope[a - 1];
    const count = Math.min(envelope.length - 1, b) - Math.max(0, a) + 1;
    out[i] = Math.max(0, envelope[i] - sum / count);
  }
  return out;
}
const at = (v: Float32Array, x: number) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= v.length) return 0;
  return v[i] + (v[i + 1] - v[i]) * (x - i);
};
/** The mean of an envelope at beats `period` frames apart from `phase`, with a little of each beat's surroundings. */
function comb(envelope: Float32Array, period: number, phase: number): number {
  let sum = 0, n = 0;
  for (let x = phase; x < envelope.length - 1; x += period) { sum += at(envelope, x); n++; }
  return n ? sum / n : 0;
}
function bestPhase(envelope: Float32Array, period: number): { phase: number; score: number } {
  let best = { phase: 0, score: -1 };
  const steps = Math.max(8, Math.ceil(period));
  for (let s = 0; s < steps; s++) {
    const phase = s * period / steps, score = comb(envelope, period, phase);
    if (score > best.score) best = { phase, score };
  }
  return best;
}

/** The song's tempo and where its bars start, or null when the audio has no steady pulse to find. */
export function detectBeats(source: Spectral, { minBpm = 70, maxBpm = 185 }: { minBpm?: number; maxBpm?: number } = {}): BeatGrid | null {
  const { hopMs } = source, envelope = sharpen(source.onset, hopMs), n = envelope.length;
  if (n * hopMs < 4000) return null;
  let mean = 0;
  for (const v of envelope) mean += v;
  mean /= n;
  if (!(mean > 1e-9)) return null;
  // Autocorrelation over the lags of plausible tempos, on at most the first three minutes.
  const span = Math.min(n, Math.round(180_000 / hopMs));
  const lagOf = (bpm: number) => 60000 / bpm / hopMs;
  const lo = Math.floor(lagOf(maxBpm)), hi = Math.ceil(lagOf(minBpm));
  const ac = (lag: number) => { let sum = 0; for (let i = 0; i + lag < span; i++) sum += envelope[i] * envelope[i + lag]; return sum / (span - lag); };
  const table = new Map<number, number>();
  const acAt = (lag: number) => { const k = Math.round(lag); if (!table.has(k)) table.set(k, k >= span ? 0 : ac(k)); return table.get(k)!; };
  let best = { lag: 0, score: -Infinity };
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = 60000 / (lag * hopMs);
    // A beat also repeats at two and four beats; a mild preference for tempos near 120.
    const score = (acAt(lag) + 0.5 * acAt(lag * 2) + 0.25 * acAt(lag * 4)) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (score > best.score) best = { lag, score };
  }
  if (!best.lag) return null;
  // Refine: the tempo within 3% whose comb catches the most onsets over the whole song.
  const coarse = 60000 / (best.lag * hopMs);
  let fine = { bpm: coarse, score: -1, phase: 0 };
  for (let bpm = coarse * 0.97; bpm <= coarse * 1.03; bpm += 0.02) {
    const { phase, score } = bestPhase(envelope, lagOf(bpm));
    if (score > fine.score) fine = { bpm, score, phase };
  }
  // Produced music almost always sits on a whole (or half) tempo: take it when it fits as well.
  for (const round of [Math.round(fine.bpm), Math.round(fine.bpm * 2) / 2]) {
    if (Math.abs(round - fine.bpm) > 0.35) continue;
    const { phase, score } = bestPhase(envelope, lagOf(round));
    if (score >= fine.score * 0.985 || Math.abs(round - fine.bpm) <= 0.06) { fine = { bpm: round, score: Math.max(score, fine.score), phase }; break; }
  }
  const period = lagOf(fine.bpm);
  // Fine phase, then which of each four beats carries the bass: the bar's first.
  let phase = fine.phase, top = -1;
  for (let d = -1; d <= 1; d += 0.1) { const s = comb(envelope, period, fine.phase + d); if (s > top) { top = s; phase = fine.phase + d; } }
  const bass = sharpen(source.bass, hopMs);
  let down = 0, downScore = -1;
  for (let k = 0; k < 4; k++) { const s = comb(bass, period * 4, phase + k * period); if (s > downScore) { downScore = s; down = k; } }
  const bar = period * 4 * hopMs;
  let beatOffsetMs = ((phase + down * period) * hopMs + source.firstMs) % bar;
  if (beatOffsetMs < 0) beatOffsetMs += bar;
  // How far the beats stand above the song's average onset level.
  const confidence = Math.max(0, Math.min(1, (fine.score / mean - 1) / 4));
  return { bpm: Math.round(fine.bpm * 100) / 100, beatOffsetMs: Math.round(beatOffsetMs * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}

const letter = (i: number) => String.fromCharCode(65 + i % 26) + (i >= 26 ? String(Math.floor(i / 26) + 1) : '');
/**
 * A rough map of the song: where its texture changes, on bar lines, with parts that sound alike
 * labelled alike. Without a grid, nothing: sections are counted in bars.
 */
export function detectSections(source: Spectral, grid: BeatGrid | null, durationMs: number): SectionGuess[] {
  if (!grid) return [];
  const { hopMs, bands } = source, frames = bands.length / BANDS, barMs = 4 * 60000 / grid.bpm;
  const firstBar = grid.beatOffsetMs, bars = Math.floor((durationMs - firstBar) / barMs);
  if (bars < 8) return [{ startMs: 0, endMs: durationMs, label: 'Part A', group: 0 }];
  // Each bar's mean band energies, each band scaled across the song so loud bands don't dominate.
  const features = Array.from({ length: bars }, (_, b) => {
    const from = Math.max(0, Math.floor((firstBar + b * barMs) / hopMs)), to = Math.min(frames, Math.ceil((firstBar + (b + 1) * barMs) / hopMs));
    const v = new Float64Array(BANDS);
    for (let f = from; f < to; f++) for (let k = 0; k < BANDS; k++) v[k] += bands[f * BANDS + k];
    for (let k = 0; k < BANDS; k++) v[k] /= Math.max(1, to - from);
    return v;
  });
  for (let k = 0; k < BANDS; k++) {
    let mean = 0, variance = 0;
    for (const v of features) mean += v[k];
    mean /= bars;
    for (const v of features) variance += (v[k] - mean) ** 2;
    const deviation = Math.sqrt(variance / bars) || 1;
    for (const v of features) v[k] = (v[k] - mean) / deviation;
  }
  const distance = (a: Float64Array, b: Float64Array) => { let s = 0; for (let k = 0; k < BANDS; k++) s += (a[k] - b[k]) ** 2; return Math.sqrt(s / BANDS); };
  const meanOf = (from: number, to: number) => { const v = new Float64Array(BANDS); for (let b = from; b < to; b++) for (let k = 0; k < BANDS; k++) v[k] += features[b][k] / (to - from); return v; };
  // Novelty at each bar line: how different the four bars after are from the four before.
  const novelty = new Float64Array(bars);
  for (let b = 2; b <= bars - 2; b++) novelty[b] = distance(meanOf(Math.max(0, b - 4), b), meanOf(b, Math.min(bars, b + 4)));
  let mean = 0, variance = 0;
  for (const v of novelty) mean += v;
  mean /= bars;
  for (const v of novelty) variance += (v - mean) ** 2;
  const threshold = mean + 0.5 * Math.sqrt(variance / bars);
  // Boundaries: the strongest peaks first, at least four bars from one already chosen.
  const peaks = [...novelty.keys()].filter(b => novelty[b] > threshold && novelty[b] >= novelty[b - 1] && novelty[b] >= (novelty[b + 1] ?? 0))
    .sort((a, b) => novelty[b] - novelty[a]);
  const cuts = [0, bars];
  for (const b of peaks) if (cuts.every(c => Math.abs(c - b) >= 4)) cuts.push(b);
  cuts.sort((a, b) => a - b);
  // A stretch with no change in it for over sixteen bars is still more than one take: halve it on eight-bar lines.
  for (let i = 0; i + 1 < cuts.length; i++) while (cuts[i + 1] - cuts[i] > 16) cuts.splice(i + 1, 0, cuts[i] + 8);
  const groups: Float64Array[] = [], out: SectionGuess[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const v = meanOf(cuts[i], cuts[i + 1]);
    let group = groups.findIndex(g => distance(g, v) < 0.55);
    if (group < 0) { group = groups.length; groups.push(v); }
    const startMs = i === 0 ? 0 : Math.round(firstBar + cuts[i] * barMs), endMs = i + 2 === cuts.length ? durationMs : Math.round(firstBar + cuts[i + 1] * barMs);
    out.push({ startMs, endMs, label: `Part ${letter(group)}`, group });
  }
  return out;
}
/** The beat grid and section guesses for a song. */
export function analyzeSong(pcm: Float32Array, sampleRate: number, durationMs = pcm.length / sampleRate * 1000): SongAnalysis {
  const source = spectral(pcm, sampleRate), grid = detectBeats(source);
  return { grid, sections: detectSections(source, grid, durationMs) };
}
/** The loudest sample in each of `buckets` equal slices, for drawing a waveform. */
export function waveformPeaks(pcm: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets), size = pcm.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const from = Math.floor(b * size), to = Math.min(pcm.length, Math.max(from + 1, Math.floor((b + 1) * size)));
    // A long slice is sampled, not scanned: a waveform needs its shape, not every sample.
    const stride = Math.max(1, Math.floor((to - from) / 64));
    for (let i = from; i < to; i += stride) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    out[b] = peak;
  }
  return out;
}
