/*
 * Where the sun and the moon are in the sky, from a place and a moment: the low-precision
 * formulas of the Astronomical Almanac (good to a fraction of a degree, plenty for lighting a
 * scene). Angles out are degrees: elevation above the horizon, azimuth clockwise from north.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
// Julian day of the Unix epoch, and of J2000.
const J1970 = 2440588;
const J2000 = 2451545;
// The obliquity of the ecliptic.
const OBLIQUITY = 23.4397 * RAD;

/** A body's place in the sky, in degrees. */
export interface SkyPosition { elevation: number; azimuth: number; }

const daysSinceJ2000 = (date: Date) => date.getTime() / DAY_MS - 0.5 + J1970 - J2000;

const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const siderealTime = (d: number, lw: number) => RAD * (280.16 + 360.9856235 * d) - lw;

// Equatorial coordinates (radians) seen from a place: elevation, and azimuth from north.
function horizontal(d: number, lat: number, lon: number, ra: number, dec: number): SkyPosition {
  const phi = lat * RAD, h = siderealTime(d, -lon * RAD) - ra;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h));
  // From the south, westwards; turned to from the north, clockwise.
  const fromSouth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { elevation: elevation / RAD, azimuth: ((fromSouth / RAD + 180) % 360 + 360) % 360 };
}

function sunCoords(d: number) {
  const m = RAD * (357.5291 + 0.98560028 * d);
  const c = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const l = m + c + RAD * 102.9372 + Math.PI;
  return { dec: declination(l, 0), ra: rightAscension(l, 0) };
}

function moonCoords(d: number) {
  const l = RAD * (218.316 + 13.176396 * d);
  const m = RAD * (134.963 + 13.064993 * d);
  const f = RAD * (93.272 + 13.22935 * d);
  const lon = l + RAD * 6.289 * Math.sin(m);
  const lat = RAD * 5.128 * Math.sin(f);
  return { ra: rightAscension(lon, lat), dec: declination(lon, lat), dist: 385001 - 20905 * Math.cos(m) };
}

/** Where the sun is, seen from (lat, lon) at `date`. */
export function sunPosition(date: Date, lat: number, lon: number): SkyPosition {
  const d = daysSinceJ2000(date);
  const { ra, dec } = sunCoords(d);
  return horizontal(d, lat, lon, ra, dec);
}

/** Where the moon is, seen from (lat, lon) at `date`. */
export function moonPosition(date: Date, lat: number, lon: number): SkyPosition {
  const d = daysSinceJ2000(date);
  const { ra, dec } = moonCoords(d);
  return horizontal(d, lat, lon, ra, dec);
}

/**
 * The moon's phase at `date`: `phase` 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter;
 * `lit` the share of its face in sunlight.
 */
export function moonPhase(date: Date): { phase: number; lit: number } {
  const d = daysSinceJ2000(date);
  const s = sunCoords(d), m = moonCoords(d), sunDist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sunDist * Math.sin(phi), m.dist - sunDist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { lit: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
}

/**
 * The moment on `date`'s local day (midnight to midnight, the device's time zone) when the sun
 * crosses `elevation` degrees, rising or setting, or null if it doesn't that day (polar days and
 * nights). Found by stepping through the day and narrowing in.
 */
export function sunCrossing(date: Date, lat: number, lon: number, elevation: number, rising: boolean): Date | null {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const step = 10 * 60000;
  const above = (t: number) => sunPosition(new Date(t), lat, lon).elevation - elevation;
  let prev = above(start.getTime());
  for (let t = start.getTime() + step; t <= start.getTime() + DAY_MS; t += step) {
    const cur = above(t);
    if (rising ? prev < 0 && cur >= 0 : prev >= 0 && cur < 0) {
      let lo = t - step, hi = t;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if ((above(mid) >= 0) === rising) hi = mid; else lo = mid;
      }
      return new Date((lo + hi) / 2);
    }
    prev = cur;
  }
  return null;
}

/** When the sun is highest on `date`'s local day. */
export function solarNoon(date: Date, lat: number, lon: number): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  let best = start.getTime(), high = -Infinity;
  for (let t = start.getTime(); t <= start.getTime() + DAY_MS; t += 15 * 60000) {
    const e = sunPosition(new Date(t), lat, lon).elevation;
    if (e > high) { high = e; best = t; }
  }
  return new Date(best);
}
