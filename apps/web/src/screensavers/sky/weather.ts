/*
 * The weather: what the screensavers draw (Weather), the kinds the Weather setting can choose,
 * and the live weather where the device is, from Open-Meteo's forecast API (free, no key, the
 * current conditions only), kept in the browser for a quarter of an hour.
 */

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

/** The weather as a scene draws it. Amounts are 0..1. */
export interface Weather {
  kind: WeatherKind;
  /** How much of the sky is cloud. */
  clouds: number;
  /** How hard it's raining, and snowing (sleet does both). */
  rain: number;
  snow: number;
  /** How thick the fog or mist is. */
  fog: number;
  /** How windy: 1 is a gale (40 km/h or more). */
  wind: number;
  /** Thunder and lightning. */
  lightning: boolean;
  /** Degrees Celsius, for live weather only. */
  temperature: number | null;
  /** What it is, in words: "Light rain". */
  label: string;
}

/** The Weather setting's choices besides Live: each a weather to show whatever it's really doing. */
export const WEATHER_PRESETS: Record<'clear' | 'clouds' | 'rain' | 'snow' | 'storm' | 'fog', Weather> = {
  clear: { kind: 'clear', clouds: 0.08, rain: 0, snow: 0, fog: 0, wind: 0.15, lightning: false, temperature: null, label: 'Clear' },
  clouds: { kind: 'cloudy', clouds: 0.85, rain: 0, snow: 0, fog: 0.1, wind: 0.3, lightning: false, temperature: null, label: 'Cloudy' },
  rain: { kind: 'rain', clouds: 0.95, rain: 0.6, snow: 0, fog: 0.2, wind: 0.35, lightning: false, temperature: null, label: 'Rain' },
  snow: { kind: 'snow', clouds: 0.9, rain: 0, snow: 0.6, fog: 0.25, wind: 0.2, lightning: false, temperature: null, label: 'Snow' },
  storm: { kind: 'storm', clouds: 1, rain: 0.9, snow: 0, fog: 0.3, wind: 0.8, lightning: true, temperature: null, label: 'Thunderstorm' },
  fog: { kind: 'fog', clouds: 0.6, rain: 0, snow: 0, fog: 0.85, wind: 0.05, lightning: false, temperature: null, label: 'Fog' },
};

/** Fair weather, until the live weather comes (or when it can't). */
export const FAIR: Weather = { ...WEATHER_PRESETS.clear, kind: 'partly', clouds: 0.3, label: 'Fair' };

// WMO weather interpretation codes (as Open-Meteo reports them): the kind, the rain or snow, and words.
const CODES: Record<number, [WeatherKind, number, number, string]> = {
  0: ['clear', 0, 0, 'Clear'], 1: ['clear', 0, 0, 'Mostly clear'], 2: ['partly', 0, 0, 'Partly cloudy'], 3: ['cloudy', 0, 0, 'Overcast'],
  45: ['fog', 0, 0, 'Fog'], 48: ['fog', 0, 0, 'Freezing fog'],
  51: ['drizzle', 0.15, 0, 'Light drizzle'], 53: ['drizzle', 0.25, 0, 'Drizzle'], 55: ['drizzle', 0.35, 0, 'Heavy drizzle'],
  56: ['drizzle', 0.2, 0.1, 'Freezing drizzle'], 57: ['drizzle', 0.3, 0.15, 'Freezing drizzle'],
  61: ['rain', 0.35, 0, 'Light rain'], 63: ['rain', 0.6, 0, 'Rain'], 65: ['rain', 0.9, 0, 'Heavy rain'],
  66: ['rain', 0.4, 0.2, 'Freezing rain'], 67: ['rain', 0.7, 0.3, 'Freezing rain'],
  71: ['snow', 0, 0.35, 'Light snow'], 73: ['snow', 0, 0.6, 'Snow'], 75: ['snow', 0, 0.9, 'Heavy snow'], 77: ['snow', 0, 0.3, 'Snow grains'],
  80: ['rain', 0.4, 0, 'Showers'], 81: ['rain', 0.65, 0, 'Showers'], 82: ['rain', 0.95, 0, 'Heavy showers'],
  85: ['snow', 0, 0.45, 'Snow showers'], 86: ['snow', 0, 0.85, 'Heavy snow showers'],
  95: ['storm', 0.8, 0, 'Thunderstorm'], 96: ['storm', 0.85, 0, 'Thunderstorm with hail'], 99: ['storm', 0.95, 0, 'Thunderstorm with hail'],
};

/** Open-Meteo's current conditions, as much of them as is used. */
export interface CurrentConditions {
  weather_code: number;
  temperature_2m?: number;
  cloud_cover?: number;
  wind_speed_10m?: number;
}

/** The weather to draw for Open-Meteo's current conditions. */
export function weatherFrom(current: CurrentConditions): Weather {
  const [kind, rain, snow, label] = CODES[current.weather_code] ?? CODES[2];
  const cover = typeof current.cloud_cover === 'number' ? current.cloud_cover / 100 : null;
  const clouds = cover ?? (kind === 'clear' ? 0.1 : kind === 'partly' ? 0.45 : 0.9);
  return {
    kind, rain, snow, label,
    clouds: Math.min(1, Math.max(0, kind === 'clear' ? Math.min(clouds, 0.25) : clouds)),
    fog: kind === 'fog' ? 0.85 : rain > 0.5 || snow > 0.5 ? 0.3 : 0.05,
    wind: Math.min(1, Math.max(0, (current.wind_speed_10m ?? 10) / 40)),
    lightning: kind === 'storm',
    temperature: typeof current.temperature_2m === 'number' ? current.temperature_2m : null,
  };
}

const CACHE_KEY = 'aerodance-screensaver-weather';
/** How long the live weather is kept before it's asked for again. */
export const WEATHER_TTL_MS = 15 * 60000;

interface Cached { lat: number; lon: number; at: number; current: CurrentConditions }

function readCache(lat: number, lon: number, now: number): Cached | null {
  try {
    const c = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) ?? 'null') as Cached | null;
    if (!c || typeof c.at !== 'number' || typeof c.current?.weather_code !== 'number') return null;
    // The same place, to the precision it was asked for, and fresh.
    if (Math.abs(c.lat - lat) > 0.06 || Math.abs(c.lon - lon) > 0.06 || now - c.at > WEATHER_TTL_MS || c.at > now) return null;
    return c;
  } catch { return null; }
}

/**
 * The live weather at (lat, lon), and when it was had: from the browser's copy if it's fresh, else
 * from Open-Meteo. The place is sent rounded to a tenth of a degree (about 10 km). Rejects when it
 * can't be had.
 */
export async function fetchWeather(lat: number, lon: number, now = Date.now()): Promise<{ weather: Weather; at: number }> {
  const la = Math.round(lat * 10) / 10, lo = Math.round(lon * 10) / 10;
  const cached = readCache(la, lo, now);
  if (cached) return { weather: weatherFrom(cached.current), at: cached.at };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m`;
  const response = await fetch(url);
  if (!response.ok) throw Error(`weather: HTTP ${response.status}`);
  const body = await response.json() as { current?: CurrentConditions };
  if (typeof body.current?.weather_code !== 'number') throw Error('weather: no current conditions');
  try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ lat: la, lon: lo, at: now, current: body.current } satisfies Cached)); } catch { /* storage unavailable */ }
  return { weather: weatherFrom(body.current), at: now };
}

/** Fahrenheit where people read it (the United States and a few others), else Celsius. */
export function usesFahrenheit(locale = typeof navigator === 'undefined' ? 'en-GB' : navigator.language): boolean {
  const region = /-([A-Z]{2})\b/.exec(locale)?.[1] ?? (locale === 'en' ? 'US' : '');
  return ['US', 'LR', 'MM', 'BS', 'KY', 'PW', 'FM', 'MH'].includes(region);
}

/** A temperature as the device's region reads it: "12°" (Celsius) or "54°" (Fahrenheit). */
export const formatTemperature = (celsius: number, fahrenheit = usesFahrenheit()) => `${Math.round(fahrenheit ? celsius * 1.8 + 32 : celsius)}°`;
