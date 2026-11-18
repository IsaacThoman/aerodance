import { mulberry32 } from '../../../../../packages/stages/shared/random.ts';
import type { Weather } from '../sky/weather.ts';

/*
 * The weather as the island shows it: eased over several seconds from what the sky says (so a
 * change of weather, live or chosen, drifts in rather than cutting), with what builds up and goes
 * away more slowly (snow lying on the ground, wet surfaces), and a thunderstorm's lightning.
 */

/** Seconds for the weather to move most of the way (a time constant: about 95% in three). */
export const WEATHER_EASE_SECONDS = 3.2;

export class WeatherEase {
  clouds = 0;
  rain = 0;
  snow = 0;
  fog = 0;
  wind = 0;
  /** A thunderstorm, 0..1. */
  storm = 0;
  /** Snow lying on the ground, 0..1: it settles while it snows and melts once it stops. */
  snowCover = 0;
  /** How wet everything is, 0..1: soaked while it rains, drying after. */
  wet = 0;
  private started = false;

  /** One frame of `dt` seconds towards `w`. The first starts there (snow already lying if it's snowing). */
  step(w: Weather, dt: number) {
    const storm = w.lightning ? 1 : 0;
    if (!this.started) {
      this.started = true;
      Object.assign(this, { clouds: w.clouds, rain: w.rain, snow: w.snow, fog: w.fog, wind: w.wind, storm });
      this.snowCover = w.snow > 0.15 ? 0.7 : 0;
      this.wet = w.rain > 0.1 ? 1 : 0;
      return;
    }
    const k = 1 - Math.exp(-Math.max(0, dt) / WEATHER_EASE_SECONDS);
    this.clouds += (w.clouds - this.clouds) * k;
    this.rain += (w.rain - this.rain) * k;
    this.snow += (w.snow - this.snow) * k;
    this.fog += (w.fog - this.fog) * k;
    this.wind += (w.wind - this.wind) * k;
    this.storm += (storm - this.storm) * k;
    // Snow whitens the island over a minute or so of steady snow, and melts in about forty seconds
    // after it stops (faster in rain or warmth).
    const warm = w.temperature !== null && w.temperature > 2 ? 1 : 0;
    if (this.snow > 0.12) this.snowCover = Math.min(1, this.snowCover + dt * this.snow / 40);
    else this.snowCover = Math.max(0, this.snowCover - dt * (1 / 40 + this.rain / 15 + warm / 60));
    if (this.rain > 0.08) this.wet = Math.min(1, this.wet + dt * (0.05 + this.rain / 6));
    else this.wet = Math.max(0, this.wet - dt / 45);
  }
}

/** A lightning strike's flash, `t` seconds after it: a bright stroke and two flickers after it (0..1). */
export function flashEnvelope(t: number): number {
  if (!(t >= 0) || t > 1.2) return 0;
  const pulse = (at: number, height: number, decay: number) => (t >= at ? height * Math.exp(-(t - at) * decay) : 0);
  return Math.min(1, pulse(0, 1, 14) + pulse(0.09, 0.55, 20) + pulse(0.24, 0.8, 11));
}

/**
 * A thunderstorm's lightning: strikes every few seconds while `storm` is up, each somewhere new.
 * Deterministic from its seed.
 */
export class Lightning {
  /** The light of the flash now (0..1), scaled by the storm. */
  flash = 0;
  /** Strikes so far: a new one when this changes. */
  strikes = 0;
  /** Where the bolt is: -1..1 across the view, 0..1 near to far, and a shape seed 0..1. */
  across = 0;
  far = 0;
  shape = 0;
  private since = Infinity;
  private wait: number;
  private readonly rand: () => number;

  constructor(seed = 11) {
    this.rand = mulberry32(seed);
    this.wait = 1.5 + this.rand() * 3;
  }

  step(dt: number, storm: number) {
    this.since += Math.max(0, dt);
    if (storm > 0.5) {
      this.wait -= dt;
      if (this.wait <= 0) {
        this.since = 0;
        this.strikes++;
        this.across = this.rand() * 2 - 1;
        this.far = this.rand();
        this.shape = this.rand();
        this.wait = 3.5 + this.rand() * 8;
      }
    }
    this.flash = flashEnvelope(this.since) * Math.min(1, Math.max(0, storm));
  }

  /** The bolt itself shows for the stroke's first moment. */
  bolt(): number { return this.since < 0.32 ? Math.min(1, flashEnvelope(this.since) * 1.6) : 0; }
}
