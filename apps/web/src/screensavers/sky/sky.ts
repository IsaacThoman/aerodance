import { moonPhase, moonPosition, solarNoon, sunCrossing, sunPosition } from './astro.ts';
import type { SkyPosition } from './astro.ts';
import { FAIR, WEATHER_PRESETS, WEATHER_TTL_MS, fetchWeather } from './weather.ts';
import type { Weather } from './weather.ts';
import { zonePlace } from './zones.ts';

/*
 * The sky a screensaver lights its scene by: the time of day where the device is (the sun and
 * the moon, from astro.ts), and the weather there (weather.ts), or a time and weather chosen
 * instead (the screensavers' Time and Weather settings). One `sky` for the page: the host sets
 * the choices, and every screensaver reads `sky.state()` each frame.
 *
 * Where the device is: its own location once someone has let the page have it (Use my location
 * on the screensavers' preview; kept, to a tenth of a degree, in the browser), else the place its
 * time zone is named for (zones.ts), else a guess from the clock's offset.
 *
 * The live weather is only asked for while something shows it: a screensaver that follows the
 * weather (its ctx.sky()), or the clock (wantLive()).
 */

export type { SkyPosition } from './astro.ts';
export type { Weather, WeatherKind } from './weather.ts';

/** The light: night, the hour round sunrise, day, and the hour round sunset. */
export type DayPhase = 'night' | 'dawn' | 'day' | 'dusk';
export const DAY_PHASES: readonly DayPhase[] = ['night', 'dawn', 'day', 'dusk'];

/** The Time setting: the real time of day, one held still, or a day going by in four minutes. */
export type TimeChoice = 'live' | 'sunrise' | 'day' | 'sunset' | 'night' | 'timelapse';
/** The Weather setting: the real weather, or one shown whatever it's doing. */
export type WeatherChoice = 'live' | keyof typeof WEATHER_PRESETS;

export const TIME_CHOICES: readonly { value: TimeChoice; label: string }[] = [
  { value: 'live', label: 'Live' }, { value: 'sunrise', label: 'Sunrise' }, { value: 'day', label: 'Day' },
  { value: 'sunset', label: 'Sunset' }, { value: 'night', label: 'Night' }, { value: 'timelapse', label: 'Time-lapse' },
];
export const WEATHER_CHOICES: readonly { value: WeatherChoice; label: string }[] = [
  { value: 'live', label: 'Live' }, { value: 'clear', label: 'Clear' }, { value: 'clouds', label: 'Clouds' }, { value: 'rain', label: 'Rain' },
  { value: 'snow', label: 'Snow' }, { value: 'storm', label: 'Storm' }, { value: 'fog', label: 'Fog' },
];
export const isTimeChoice = (v: unknown): v is TimeChoice => TIME_CHOICES.some((c) => c.value === v);
export const isWeatherChoice = (v: unknown): v is WeatherChoice => WEATHER_CHOICES.some((c) => c.value === v);

/** Where the sky is seen from. */
export interface Place {
  lat: number;
  lon: number;
  /** The time zone's place ("Chicago"), or null for the device's own location or a guess. */
  name: string | null;
  source: 'device' | 'zone' | 'guess';
}

/** The sky as a scene draws it. */
export interface SkyState {
  /** The scene's moment: now, the chosen time of day today, or the time-lapse's. */
  date: Date;
  /** Its local time of day in hours, 0 to 24. */
  hours: number;
  /** Degrees: elevation above the horizon, azimuth clockwise from north. */
  sun: SkyPosition;
  moon: SkyPosition & { phase: number; lit: number };
  /** 0 at night to 1 in full day, smooth through twilight (about 0.5 as the sun sets). */
  daylight: number;
  /** 0 to 1: how golden the light is (the sun low, but up). */
  golden: number;
  phase: DayPhase;
  /** Rising (morning) or setting. */
  rising: boolean;
  weather: Weather;
  place: Place;
  /** Following the real clock, and the real weather. */
  live: { time: boolean; weather: boolean };
}

const RAD = Math.PI / 180;
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// The time-lapse: a day every four minutes.
const TIMELAPSE = 86400 / 240;

/** The sky at `date` from `place`, with this weather (pure: tests and scenes alike). */
export function skyAt(date: Date, place: Place, weather: Weather, live = { time: true, weather: true }): SkyState {
  const sun = sunPosition(date, place.lat, place.lon);
  const later = sunPosition(new Date(date.getTime() + 600000), place.lat, place.lon);
  const moon = { ...moonPosition(date, place.lat, place.lon), ...moonPhase(date) };
  const rising = later.elevation >= sun.elevation;
  const e = sun.elevation;
  return {
    date, hours: date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600,
    sun, moon, rising, weather, place, live,
    daylight: smoothstep(-10, 8, e),
    golden: smoothstep(-4, 1, e) * (1 - smoothstep(4, 14, e)),
    phase: e < -6 ? 'night' : e < 10 ? (rising ? 'dawn' : 'dusk') : 'day',
  };
}

/** The direction to a sky position as a unit vector, in a scene's frame: +y up, -z north, +x east. */
export function skyDirection({ elevation, azimuth }: SkyPosition): [number, number, number] {
  const e = elevation * RAD, a = azimuth * RAD;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

// The latitudes the held times are worked out at: nearer the poles the summer sun never sets far
// enough for Night, and in the polar day and night there's no Sunrise or Sunset at all.
const HELD_LATITUDE = 55;
/** The place a held time of day is seen from: the device's, brought within HELD_LATITUDE of the equator. */
export const heldPlace = (place: Place): Place => ({ ...place, lat: Math.max(-HELD_LATITUDE, Math.min(HELD_LATITUDE, place.lat)) });

/** The moment today the Time setting holds still at, from `place` (sunrise and sunset with the sun 4° up, golden). */
export function heldTime(choice: Exclude<TimeChoice, 'live' | 'timelapse'>, now: Date, place: Place): Date {
  const at = (h: number, m = 0) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d; };
  if (choice === 'sunrise') return sunCrossing(now, place.lat, place.lon, 4, true) ?? at(7);
  if (choice === 'sunset') return sunCrossing(now, place.lat, place.lon, 4, false) ?? at(18, 30);
  const noon = solarNoon(now, place.lat, place.lon);
  // Late morning; and the middle of the night, ahead of noon by half a day (back a day if that's tomorrow).
  if (choice === 'day') return new Date(noon.getTime() - 1.5 * 3600000);
  return new Date(noon.getTime() + 12 * 3600000);
}

// ---- Where the device is ----

const PLACE_KEY = 'aerodance-screensaver-place';
const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search);

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { return ''; }
}

/** The place the device's time zone is named for, or a guess from its clock's offset. */
export function zoneGuess(zone = timeZone(), offsetMinutes = new Date().getTimezoneOffset()): Place {
  const named = zonePlace(zone);
  if (named) return { ...named, source: 'zone' };
  return { lat: 35, lon: Math.max(-180, Math.min(180, -offsetMinutes / 4)), name: null, source: 'guess' };
}

function savedPlace(): Place | null {
  // ?place=<lat>,<lon> (tests, and looking at somewhere else's sky).
  const asked = params?.get('place')?.split(',').map(Number);
  if (asked?.length === 2 && asked.every(Number.isFinite)) return { lat: asked[0], lon: asked[1], name: null, source: 'device' };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(PLACE_KEY) ?? 'null') as { lat?: unknown; lon?: unknown } | null;
    if (typeof saved?.lat === 'number' && typeof saved.lon === 'number') return { lat: saved.lat, lon: saved.lon, name: null, source: 'device' };
  } catch { /* storage unavailable */ }
  return null;
}

/** Live weather: off (not asked for), being fetched, had, or not to be had (offline, refused). */
export type WeatherStatus = 'off' | 'loading' | 'live' | 'unavailable';

/**
 * The page's sky: the Time and Weather settings, where the device is, and the live weather,
 * fetched while a screensaver showing asks for it (state() with the Weather setting on Live).
 */
export class Sky {
  time: TimeChoice = 'live';
  weatherChoice: WeatherChoice = 'live';
  private place: Place = savedPlace() ?? zoneGuess();
  private live: Weather | null = null;
  private liveAt = 0;
  private fetching = false;
  private failedAt = 0;
  private lapse = { from: 0, real: 0 };
  private cached: { key: string; at: number; state: SkyState } | null = null;
  status: WeatherStatus = 'off';
  /** Bumped when anything the picker shows about the sky changes (the place, the weather's status). */
  revision = 0;

  /** Sets the Time and Weather settings. */
  choose(time: TimeChoice, weather: WeatherChoice) {
    if (time === 'timelapse' && this.time !== 'timelapse') this.lapse = { from: Date.now(), real: performance.now() };
    this.time = time;
    this.weatherChoice = weather;
  }

  where(): Place { return this.place; }

  /** The device can be asked where it is (navigator.geolocation). */
  canLocate(): boolean { return typeof navigator !== 'undefined' && !!navigator.geolocation; }

  /**
   * Asks the device where it is (the browser asks the person first): from a press of Use my
   * location only. Kept to a tenth of a degree, in the browser, for next time.
   */
  locate(): Promise<Place> {
    return new Promise((resolve, reject) => {
      if (!this.canLocate()) { reject(Error('no geolocation')); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const place: Place = { lat: Math.round(pos.coords.latitude * 10) / 10, lon: Math.round(pos.coords.longitude * 10) / 10, name: null, source: 'device' };
        try { globalThis.localStorage?.setItem(PLACE_KEY, JSON.stringify({ lat: place.lat, lon: place.lon })); } catch { /* storage unavailable */ }
        this.place = place;
        this.live = null;
        this.liveAt = 0;
        this.failedAt = 0;
        this.revision++;
        resolve(place);
      }, (error) => reject(Error(error.message)), { enableHighAccuracy: false, maximumAge: 3600000, timeout: 15000 });
    });
  }

  /** The live weather, fetched now if it's missing or old (and not just failed). */
  private refresh(now: number) {
    if (this.fetching || (this.live && now - this.liveAt < WEATHER_TTL_MS) || now - this.failedAt < 120000) return;
    this.fetching = true;
    if (!this.live) { this.status = 'loading'; this.revision++; }
    const { lat, lon } = this.place;
    const asked = this.place;
    fetchWeather(lat, lon, now).then(({ weather, at }) => {
      // (Use my location moved the place meanwhile: this was for the old one.)
      if (this.place !== asked) return;
      this.live = weather;
      this.liveAt = at;
      this.status = 'live';
    }, (error: unknown) => {
      console.warn('[screensavers] live weather:', error instanceof Error ? error.message : error);
      this.failedAt = now;
      if (!this.live) this.status = 'unavailable';
    }).finally(() => { this.fetching = false; this.revision++; });
  }

  /** The weather as chosen: the live weather (fair until it comes; fetched if `fetch`), or a preset. */
  weather(fetch = false): Weather {
    if (this.weatherChoice !== 'live') return WEATHER_PRESETS[this.weatherChoice];
    if (fetch) this.refresh(Date.now());
    return this.live ?? FAIR;
  }

  /** The real weather, if it's been had (for the clock's corner), whatever the Weather setting. */
  liveWeather(): Weather | null { return this.live; }

  /** Live weather is wanted (the clock shows it) even while a preset is showing: fetch it. */
  wantLive() { this.refresh(Date.now()); }

  /**
   * The sky now, as the settings have it. Cheap to call every frame: it's worked out a few times a
   * second. `fetch`: something draws the weather, so fetch the live weather if it's wanted and
   * missing or old.
   */
  state({ fetch = false }: { fetch?: boolean } = {}): SkyState {
    const nowMs = Date.now();
    const weather = this.weather(fetch);
    const key = `${this.time}|${this.weatherChoice}|${this.place.lat},${this.place.lon}|${this.status}|${this.liveAt}`;
    // (The time-lapse moves too fast to keep.)
    if (this.cached && this.cached.key === key && this.time !== 'timelapse' && nowMs - this.cached.at < 250) return this.cached.state;
    const now = new Date(nowMs);
    const held = this.time !== 'live' && this.time !== 'timelapse';
    const place = held ? heldPlace(this.place) : this.place;
    const date = this.time === 'live' ? now
      : this.time === 'timelapse' ? new Date(this.lapse.from + (performance.now() - this.lapse.real) * TIMELAPSE)
        : heldTime(this.time as Exclude<TimeChoice, 'live' | 'timelapse'>, now, place);
    const state = skyAt(date, place, weather, { time: this.time === 'live', weather: this.weatherChoice === 'live' });
    this.cached = { key, at: nowMs, state };
    return state;
  }
}

/** The page's sky (the screensavers share it). */
export const sky = new Sky();
