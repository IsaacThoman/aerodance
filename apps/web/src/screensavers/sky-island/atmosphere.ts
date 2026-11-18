import { clamp, lerp, smoothstep } from '../../../../../packages/stages/shared/random.ts';
import { skyDirection } from '../sky/sky.ts';

/*
 * The light the sky island is drawn in, from the sky (sky/sky.ts): the sky's colours, the sun's
 * and the moon's light, the clouds, the haze and the night's glows, all from the sun's height and
 * the (eased) weather; and where the sun, the moon and the stars stand in the scene. Pure, so it
 * can be checked without drawing (tests/screensaver-sky-island.test.ts).
 *
 * Colours are linear RGB, as the shaders take them (before bloom and ACES).
 */

export type RGB = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** A '#rrggbb' colour in linear RGB. */
export function linear(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: RGB, b: RGB): RGB => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: RGB, b: RGB): RGB => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

interface ClearSky { zenith: RGB; horizon: RGB; glow: RGB; sun: RGB }

// The clear sky by the sun's elevation in degrees: overhead, at the horizon, the glow low on the
// sun's side, and the sun's light. Deep navy night, a violet then rose dawn, a gold sunrise and
// the Frutiger Aero blue of the day.
const STOPS: readonly (ClearSky & { e: number })[] = [
  { e: -18, zenith: '#030a22', horizon: '#0a2252', glow: '#0c2252', sun: '#000000' },
  { e: -12, zenith: '#04102e', horizon: '#11306a', glow: '#22307a', sun: '#000000' },
  { e: -7, zenith: '#0a1d4e', horizon: '#33468c', glow: '#7a4488', sun: '#2a1020' },
  { e: -3, zenith: '#14306e', horizon: '#8070b0', glow: '#ff6a5a', sun: '#ff5a30' },
  { e: 0.5, zenith: '#1f4ea2', horizon: '#ee9a80', glow: '#ff7a30', sun: '#ff7a2c' },
  { e: 4, zenith: '#245fba', horizon: '#f8c49c', glow: '#ffa450', sun: '#ffa456' },
  { e: 10, zenith: '#1a5ccc', horizon: '#a8d2f4', glow: '#ffe0b0', sun: '#ffdcae' },
  { e: 22, zenith: '#0f50cc', horizon: '#86c4f4', glow: '#e6f6ff', sun: '#fff2e0' },
  { e: 50, zenith: '#0b48c4', horizon: '#7cbcf2', glow: '#eef8ff', sun: '#fff8ee' },
].map((s) => ({ e: s.e, zenith: linear(s.zenith), horizon: linear(s.horizon), glow: linear(s.glow), sun: linear(s.sun) }));

/** The clear sky with the sun `e` degrees up (smooth between the stops). */
export function clearSky(e: number): ClearSky {
  if (!(e > STOPS[0].e)) return STOPS[0];
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1], b = STOPS[i];
    if (e <= b.e) {
      const t = smoothstep(a.e, b.e, e);
      return { zenith: mixRGB(a.zenith, b.zenith, t), horizon: mixRGB(a.horizon, b.horizon, t), glow: mixRGB(a.glow, b.glow, t), sun: mixRGB(a.sun, b.sun, t) };
    }
  }
  return STOPS[STOPS.length - 1];
}

/** What the light is worked out from: degrees up of the sun and the moon, and the weather (0..1, eased). */
export interface AtmosphereInput {
  sun: number;
  moon: number;
  /** The share of the moon's face lit. */
  moonLit: number;
  clouds: number;
  rain: number;
  snow: number;
  fog: number;
  /** A thunderstorm (0..1). */
  storm: number;
}

export interface Atmosphere {
  zenith: RGB; horizon: RGB;
  /** The haze below the horizon, over the sea of clouds. */
  below: RGB;
  /** The warm glow low on the sun's side of the sky, and how strong it is. */
  glow: RGB; glowAmount: number;
  /** The sun's colour (its disc and glints), and how bright its disc shows (0 hidden). */
  sunColor: RGB; sunDisc: number;
  /** The light from the sun or the moon, and how much of it is the moon's (for its direction). */
  key: RGB; moonShare: number;
  /** Light from the sky above, and bounced up from the clouds below. */
  ambSky: RGB; ambGround: RGB;
  /** Clouds: their sunlit and shaded sides. */
  cloudLit: RGB; cloudShade: RGB;
  /** How much the sky is overcast (0..1). */
  overcast: number;
  fogColor: RGB; fogDensity: number;
  stars: number; moonVis: number;
  /** 0 day to 1 night; lamps and the greenhouse's glow (also on in dark weather); fireflies. */
  night: number; lamps: number; fireflies: number;
  daylight: number;
}

const MOON: RGB = linear('#9fb8ff');
const OVERCAST: RGB = linear('#aab4c0');
const SNOW_SKY: RGB = linear('#c6ced8');
const STORM_TINT: RGB = [0.78, 0.88, 1.0];
const FOG: RGB = linear('#dfe8f0');

/** The light for a sun `sun` degrees up (and the moon, and the weather). */
export function atmosphere(i: AtmosphereInput): Atmosphere {
  const e = Number.isFinite(i.sun) ? i.sun : -30;
  const c = clearSky(e);
  const storm = clamp(i.storm), fog = clamp(i.fog), rain = clamp(i.rain), snow = clamp(i.snow);
  const daylight = smoothstep(-10, 8, e);
  const over = smoothstep(0.32, 1, clamp(i.clouds));
  // How bright the sky is: the clear horizon's brightness.
  const bright = luminance(c.horizon);
  // Overcast: a sheet of grey about as bright as the clear horizon, whiter in snow, slate in a storm.
  let grey = mixRGB(OVERCAST, SNOW_SKY, clamp(snow * 1.6));
  grey = scale(grey, (bright / luminance(grey)) * 0.92 * (1 - 0.62 * storm));
  grey = mixRGB(grey, mul(grey, STORM_TINT), storm);
  // And a whiter haze in fog.
  const haze = scale(FOG, bright / luminance(FOG) * 0.95);

  let zenith = mixRGB(c.zenith, scale(grey, 0.78), over);
  let horizon = mixRGB(c.horizon, grey, over);
  zenith = mixRGB(zenith, haze, fog * 0.45);
  horizon = mixRGB(horizon, haze, fog * 0.8);
  const glowAmount = smoothstep(-15, -4, e) * (1 - smoothstep(6, 20, e)) * (1 - 0.85 * over) * (1 - 0.7 * fog);
  const below = mixRGB(horizon, scale(horizon, 0.82), 0.5);

  const sunUp = smoothstep(-2.5, 4, e);
  const direct = (1 - 0.86 * over) * (1 - 0.55 * fog) * (1 - 0.4 * storm);
  const sunLight = sunUp * lerp(1.5, 2.7, smoothstep(4, 35, e)) * direct;
  const moonUp = smoothstep(-1, 10, Number.isFinite(i.moon) ? i.moon : -30);
  const moonLight = clamp(i.moonLit) * moonUp * (1 - daylight) * 0.42 * (1 - 0.8 * over) * (1 - 0.5 * fog);
  const sunColor = c.sun;
  const key = add(scale(sunColor, sunLight), scale(MOON, moonLight));
  const moonShare = moonLight / (sunLight + moonLight + 1e-4);

  // Sky light: the clear sky's blue, or the overcast's grey (brighter, the sun's light spread through it).
  const clearAmb = scale(mixRGB(c.zenith, c.horizon, 0.55), 0.85);
  const nightFloor: RGB = [0.03, 0.05, 0.13];
  const ambSky = add(add(mixRGB(clearAmb, scale(grey, 1.05), over), nightFloor), scale(MOON, moonLight * 0.18));

  // Clouds: white in the sun (gold when it's low), the shade blue; grey when overcast; moonlit at night.
  const golden = sunUp * (1 - smoothstep(4, 16, e));
  const sunTint = mixRGB([1, 1, 1], scale(sunColor, 1 / Math.max(1e-3, Math.max(...sunColor))), golden * 0.85);
  const litBright = lerp(0.02, 1.15, smoothstep(-8, 6, e));
  let cloudLit = add(scale(sunTint, litBright), scale(MOON, moonLight * 0.5));
  cloudLit = mixRGB(cloudLit, scale(grey, 1.12), over);
  let cloudShade = add(mul(scale(clearAmb, 0.95), [0.95, 0.97, 1.1]), nightFloor);
  cloudShade = mixRGB(cloudShade, scale(grey, 0.62), over);
  cloudLit = scale(cloudLit, 1 - 0.35 * storm);
  cloudShade = scale(cloudShade, 1 - 0.4 * storm);
  const ambGround = scale(mixRGB(cloudLit, cloudShade, 0.4), 0.42);

  const fogColor = mixRGB(horizon, haze, 0.75);
  // (Light haze in rain or snow; real fog thick enough that the island stands out of it.)
  const fogDensity = 0.0011 + Math.pow(smoothstep(0.25, 1, fog), 1.5) * 0.0085 + rain * 0.0016 + snow * 0.0026 + over * 0.0009;

  const night = 1 - smoothstep(-8, 3, e);
  return {
    zenith, horizon, below, glow: c.glow, glowAmount,
    sunColor, sunDisc: (1 - over) * (1 - over) * (1 - 0.85 * fog) * smoothstep(-1.5, 0.5, e),
    key, moonShare,
    ambSky, ambGround,
    cloudLit, cloudShade, overcast: over,
    fogColor, fogDensity,
    stars: (1 - smoothstep(-13, -4, e)) * (1 - over) * (1 - 0.85 * fog),
    moonVis: smoothstep(-1.5, 1.5, Number.isFinite(i.moon) ? i.moon : -30) * (1 - 0.92 * over) * (1 - 0.8 * fog),
    night,
    lamps: clamp(night + (1 - night) * (0.3 * over + 0.4 * storm + 0.3 * fog)),
    fireflies: night * (1 - smoothstep(0.08, 0.35, rain)) * (1 - smoothstep(0.08, 0.35, snow)) * (1 - 0.7 * storm),
    daylight,
  };
}

// ---- Where the sun, the moon and the stars stand in the scene ----

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const RAD = Math.PI / 180;

/** The sun's declination (degrees) on `date`'s day: near enough for where it rises and sets. */
export function solarDeclination(date: Date): number {
  const day = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000;
  return -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (day + 10));
}

/**
 * How far round from its noon bearing (degrees) the sun sets (and rises, the other way) at
 * `latitude` on a day of `declination`: 90 at the equinoxes, more in summer, less in winter; 180
 * under a midnight sun, near 0 in a polar night.
 */
export function setBearing(latitude: number, declination: number): number {
  const c = Math.sin(declination * RAD) / Math.cos(latitude * RAD);
  if (!(c > -1)) return latitude >= 0 ? 0 : 180;
  if (!(c < 1)) return latitude >= 0 ? 180 : 0;
  // The setting point's bearing from north, measured from where it's highest.
  const fromNorth = Math.acos(c) / RAD;
  return latitude >= 0 ? 180 - fromNorth : fromNorth;
}

/** Where sunrise and sunset stand in the scene: this far round from behind the hero view (so 16 degrees either side of its middle). */
export const SUN_SET_AT = 164;
/** How much narrower the moon's way across the scene's sky is than the real one, about where it's highest. */
export const MOON_SPREAD = 0.6;

/**
 * The scene's azimuths (degrees, clockwise from the scene's north, -z, ahead of the hero view) for
 * the real sun and moon. Their heights are kept as they are (they light everything); their
 * bearings are drawn round so that, whatever the season, the sun rises a little right of the hero
 * view's middle and sets a little left of it, highest behind it at noon (lighting the island's
 * face); and the moon is highest in front of it. Both rise on the right and set on the left (north
 * of the equator; the other way south of it, as the real ones do facing the pole).
 */
export function sceneAzimuths(sunAzimuth: number, moonAzimuth: number, latitude: number, declination: number): { sun: number; moon: number } {
  // Where they're highest: due south north of the equator, due north south of it.
  const transit = latitude >= 0 ? 180 : 0;
  const d = wrap180(sunAzimuth - transit);
  const set = Math.max(4, setBearing(latitude, declination));
  // Day: evenly from noon to sunset; night: the rest of the way round, meeting at midnight.
  const x = Math.abs(d) / set, far = 180 / set;
  const g = far <= 1.02 ? Math.abs(d) : x <= 1 ? SUN_SET_AT * x : SUN_SET_AT + ((180 - SUN_SET_AT) * (x - 1)) / (far - 1);
  return { sun: 180 + Math.sign(d) * Math.min(180, g), moon: -MOON_SPREAD * wrap180(moonAzimuth - transit) };
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A disc's frame on the sky at `dir`: right and up across it, as seen looking at it. */
export function discBasis(dir: V3): { right: V3; up: V3 } {
  let right = cross(dir, [0, 1, 0]);
  if (Math.hypot(...right) < 1e-4) right = [1, 0, 0];
  right = normalize(right);
  return { right, up: cross(right, dir) };
}

/**
 * The sun's direction as the moon's face sees it, in the moon's disc frame (x right, y up, z
 * towards us): what lights its phase. From the real sun and moon, so the phase is the real one;
 * `mirrored` when the scene's moon is mirrored (sceneAzimuths' moon is), so its lit side faces the
 * scene's sun.
 */
export function moonLighting(sun: V3, moon: V3, mirrored = true): V3 {
  const { right, up } = discBasis(moon);
  return normalize([dot(sun, right) * (mirrored ? -1 : 1), dot(sun, up), -dot(sun, moon)]);
}

/** The scene's sun and moon directions (+y up, -z ahead of the hero view), and the moon's lighting. */
export function sceneSky(sky: { date: Date; sun: { elevation: number; azimuth: number }; moon: { elevation: number; azimuth: number }; place: { lat: number } }): { sun: V3; moon: V3; moonSun: V3 } {
  const az = sceneAzimuths(sky.sun.azimuth, sky.moon.azimuth, sky.place.lat, solarDeclination(sky.date));
  const sun = skyDirection({ elevation: sky.sun.elevation, azimuth: az.sun });
  const moon = skyDirection({ elevation: sky.moon.elevation, azimuth: az.moon });
  const moonSun = moonLighting(skyDirection(sky.sun), skyDirection(sky.moon));
  return { sun, moon, moonSun };
}

const SIDEREAL_DAY_MS = 86164091;
/**
 * The stars' turn at `date`: about the visible celestial pole (ahead of the hero view, as high as
 * the latitude), by the angle (radians) a star at `dir` is turned to dir · rotation(axis, angle).
 * They rise on the right and set on the left, as the sun and moon do in the scene.
 */
export function starRotation(date: Date, latitude: number): { axis: V3; angle: number } {
  const axis = skyDirection({ elevation: Math.abs(latitude), azimuth: 0 });
  const turns = (date.getTime() % SIDEREAL_DAY_MS) / SIDEREAL_DAY_MS;
  return { axis, angle: (latitude >= 0 ? -1 : 1) * turns * Math.PI * 2 };
}

/** `v` turned `angle` radians about the unit `axis` (right-handed). */
export function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v) * (1 - c), x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}
