import assert from 'node:assert/strict';
import test from 'node:test';
import { atmosphere, clearSky, luminance, moonLighting, rotate, sceneAzimuths, sceneSky, setBearing, solarDeclination, starRotation, SUN_SET_AT } from '../src/screensavers/sky-island/atmosphere.ts';
import type { AtmosphereInput } from '../src/screensavers/sky-island/atmosphere.ts';
import { Lightning, WEATHER_EASE_SECONDS, WeatherEase, flashEnvelope } from '../src/screensavers/sky-island/ease.ts';
import { GREENHOUSE, ISLETS, LAMPS, LIP, LIP_LEVEL, POND, TOWER, TREES, TURBINES, groundHeight, rimRadius, streamPath, undersideProfile } from '../src/screensavers/sky-island/layout.ts';
import skyIsland from '../src/screensavers/sky-island/index.ts';
import { saverProblem } from '../src/screensavers/definition.ts';
import { sunCrossing } from '../src/screensavers/sky/astro.ts';
import { skyAt } from '../src/screensavers/sky/sky.ts';
import type { Place } from '../src/screensavers/sky/sky.ts';
import { WEATHER_PRESETS } from '../src/screensavers/sky/weather.ts';

const NEW_YORK: Place = { lat: 40.7, lon: -74, name: 'New York', source: 'zone' };
const SYDNEY: Place = { lat: -33.9, lon: 151.2, name: 'Sydney', source: 'zone' };
const clear: AtmosphereInput = { sun: 30, moon: -20, moonLit: 0.5, clouds: 0.08, rain: 0, snow: 0, fog: 0, storm: 0 };
const angle = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

test('the sky island is a valid screensaver that follows the time and the weather and has a clock', () => {
  assert.equal(saverProblem(skyIsland, 'sky-island'), '');
  assert.deepEqual(skyIsland.follows, { time: true, weather: true });
  assert.equal(skyIsland.sceneClock, true);
  assert.equal(skyIsland.scene, 'custom');
});

// ---- The light ----

test('the light: day is bright and blue, night dark with stars, the lamps on only when it is dark', () => {
  const day = atmosphere(clear), night = atmosphere({ ...clear, sun: -30 });
  assert.ok(luminance(day.horizon) > 20 * luminance(night.horizon));
  assert.ok(day.zenith[2] > day.zenith[0] * 3, 'a blue day sky');
  assert.ok(luminance(day.key) > 1 && luminance(night.key) < 0.05);
  assert.ok(night.stars > 0.95 && day.stars === 0);
  assert.ok(night.lamps > 0.95 && day.lamps < 0.05);
  assert.ok(night.fireflies > 0.9 && day.fireflies === 0);
  // A storm by day brings the lamps partly on.
  assert.ok(atmosphere({ ...clear, clouds: 1, rain: 0.9, storm: 1 }).lamps > 0.3);
});

test('the light: sunset is warm and golden; the moon lights the night when it is up', () => {
  const sunset = atmosphere({ ...clear, sun: 1 });
  assert.ok(sunset.sunColor[0] > sunset.sunColor[2] * 3, 'a red-gold sun');
  assert.ok(sunset.glowAmount > 0.8);
  const moonlit = atmosphere({ ...clear, sun: -30, moon: 40, moonLit: 1 });
  const moonless = atmosphere({ ...clear, sun: -30, moon: -10, moonLit: 1 });
  assert.ok(luminance(moonlit.key) > 5 * luminance(moonless.key));
  assert.ok(moonlit.moonShare > 0.95);
});

test('the light: cloud hides the sun and greys the sky; fog thickens the haze; storms darken', () => {
  const clouds = atmosphere({ ...clear, clouds: 0.9 });
  const day = atmosphere(clear);
  assert.ok(luminance(clouds.key) < 0.35 * luminance(day.key));
  assert.ok(clouds.sunDisc < 0.05 && day.sunDisc > 0.95);
  const chroma = (c: number[]) => Math.max(...c) - Math.min(...c);
  assert.ok(chroma(clouds.zenith) < 0.5 * chroma(day.zenith), 'grey, not blue');
  assert.ok(atmosphere({ ...clear, fog: 0.85 }).fogDensity > 4 * day.fogDensity);
  assert.ok(luminance(atmosphere({ ...clear, clouds: 1, storm: 1 }).horizon) < 0.6 * luminance(atmosphere({ ...clear, clouds: 1 }).horizon));
});

test('the light changes smoothly with the sun (a time-lapse never jumps) and never goes NaN', () => {
  const keys = ['zenith', 'horizon', 'glow', 'key', 'ambSky', 'cloudLit', 'fogColor'] as const;
  let last = atmosphere({ ...clear, sun: -40, moon: 20 });
  for (let e = -39.9; e <= 70; e += 0.1) {
    const now = atmosphere({ ...clear, sun: e, moon: 20 });
    for (const k of keys) {
      for (let c = 0; c < 3; c++) {
        assert.ok(Number.isFinite(now[k][c]), `${k} at ${e.toFixed(1)}`);
        assert.ok(Math.abs(now[k][c] - last[k][c]) < 0.06, `${k}[${c}] jumps at ${e.toFixed(1)}°`);
      }
    }
    last = now;
  }
  for (const odd of [{ sun: Number.NaN }, { sun: 90, clouds: 1, rain: 1, snow: 1, fog: 1, storm: 1 }, { sun: -90, moon: Number.NaN, moonLit: 2 }]) {
    const a = atmosphere({ ...clear, ...odd });
    for (const v of Object.values(a)) for (const x of Array.isArray(v) ? v : [v]) assert.ok(Number.isFinite(x));
  }
  assert.deepEqual(clearSky(-90), clearSky(-18));
});

// ---- Where the sun, the moon and the stars stand ----

test('the sun rises a little right of the hero view and sets a little left of it, whatever the season, highest behind it', () => {
  for (const place of [NEW_YORK, SYDNEY, { ...NEW_YORK, lat: 60 }]) {
    for (const month of [0, 3, 5, 8, 11]) {
      const day = new Date(2026, month, 15, 12);
      const dec = solarDeclination(day);
      for (const rising of [true, false]) {
        const at = sunCrossing(day, place.lat, place.lon, 0, rising);
        if (!at) continue;
        const s = skyAt(at, place, WEATHER_PRESETS.clear);
        const az = sceneAzimuths(s.sun.azimuth, s.moon.azimuth, place.lat, dec).sun;
        // In front (north, 0) by about 180 - SUN_SET_AT, rising right (east) north of the equator.
        assert.ok(angle(az, 0) < 180 - SUN_SET_AT + 9, `${place.lat} ${month} ${rising ? 'rise' : 'set'} at ${az.toFixed(1)}`);
        const right = Math.sin((az * Math.PI) / 180) > 0;
        assert.equal(right, rising === place.lat >= 0);
      }
      const noon = sceneAzimuths(place.lat >= 0 ? 180 : 0, 0, place.lat, dec).sun;
      assert.ok(angle(noon, 180) < 1e-9);
    }
  }
});

test('the sun moves round the scene without jumping, through the day and the night', () => {
  for (const place of [NEW_YORK, SYDNEY]) {
    const dec = solarDeclination(new Date(2026, 10, 16));
    let last = sceneAzimuths(0, 0, place.lat, dec).sun;
    for (let a = 0.5; a <= 360; a += 0.5) {
      const now = sceneAzimuths(a, 0, place.lat, dec).sun;
      assert.ok(angle(now, last) < 3, `jumps at ${a}`);
      last = now;
    }
  }
  assert.equal(setBearing(40, 0).toFixed(3), '90.000');
  assert.ok(setBearing(40, 23) > 110 && setBearing(40, -23) < 70);
  assert.equal(setBearing(80, 23), 180);
  assert.equal(setBearing(80, -23), 0);
});

test('the moon is lit from the sun: full when opposite it, new beside it', () => {
  const full = moonLighting([0, 0.2, 0.98], [0, 0.2, -0.98]);
  assert.ok(full[2] > 0.9);
  const fresh = moonLighting([0.1, 0.1, -0.99], [0, 0.12, -0.99]);
  assert.ok(fresh[2] < -0.9);
  const quarter = moonLighting([1, 0, 0], [0, 0, -1]);
  assert.ok(Math.abs(quarter[2]) < 1e-9 && Math.abs(quarter[0]) > 0.99);
  // The real sky's phase comes through sceneSky.
  const s = skyAt(new Date(2026, 10, 16, 18), NEW_YORK, WEATHER_PRESETS.clear);
  const scene = sceneSky(s);
  assert.ok(Math.abs(Math.hypot(...scene.moonSun) - 1) < 1e-9);
  assert.ok(Math.abs((scene.moonSun[2] + 1) / 2 - s.moon.lit) < 0.02, 'lit share matches the real phase');
});

test('the stars turn about the pole, rising on the right and setting on the left', () => {
  const t0 = new Date(2026, 10, 16, 22), t1 = new Date(t0.getTime() + 600000);
  const a = starRotation(t0, 40.7), b = starRotation(t1, 40.7);
  // A star high above the pole (ahead of the hero view) moves left (-x).
  const star: [number, number, number] = [0, 0.95, -0.31];
  const p0 = rotate(star, a.axis, a.angle), p1 = rotate(star, b.axis, b.angle);
  assert.ok(p1[0] < p0[0]);
  // The pole itself stays put, as high as the latitude.
  assert.ok(Math.abs(Math.asin(a.axis[1]) * (180 / Math.PI) - 40.7) < 1e-9);
});

// ---- The weather ----

test('the weather eases in over a few seconds, starting where it is', () => {
  const e = new WeatherEase();
  e.step(WEATHER_PRESETS.clear, 1 / 60);
  assert.equal(e.clouds, WEATHER_PRESETS.clear.clouds);
  e.step(WEATHER_PRESETS.storm, 1 / 60);
  assert.ok(e.clouds < 0.12 && e.storm < 0.01, 'no jump');
  for (let t = 0; t < WEATHER_EASE_SECONDS * 3; t += 1 / 60) e.step(WEATHER_PRESETS.storm, 1 / 60);
  assert.ok(Math.abs(e.clouds - 1) < 0.06 && e.storm > 0.94 && e.rain > 0.85);
  assert.ok(e.wet > 0.9);
});

test('snow settles on the island while it snows and melts after; rain wets it and it dries', () => {
  const e = new WeatherEase();
  e.step(WEATHER_PRESETS.clear, 1 / 60);
  assert.equal(e.snowCover, 0);
  for (let t = 0; t < 60; t += 0.1) e.step(WEATHER_PRESETS.snow, 0.1);
  assert.ok(e.snowCover > 0.6);
  for (let t = 0; t < 60; t += 0.1) e.step(WEATHER_PRESETS.clear, 0.1);
  assert.equal(e.snowCover, 0);
  const snowing = new WeatherEase();
  snowing.step(WEATHER_PRESETS.snow, 1 / 60);
  assert.ok(snowing.snowCover > 0.5, 'already lying when it starts out snowing');
  for (let t = 0; t < 120; t += 0.1) e.step(WEATHER_PRESETS.clear, 0.1);
  assert.equal(e.wet, 0);
});

test('lightning strikes every few seconds in a storm, never without one', () => {
  const calm = new Lightning(3);
  for (let t = 0; t < 60; t += 1 / 30) { calm.step(1 / 30, 0); assert.equal(calm.flash, 0); }
  assert.equal(calm.strikes, 0);
  const storm = new Lightning(3);
  let brightest = 0;
  for (let t = 0; t < 60; t += 1 / 30) { storm.step(1 / 30, 1); brightest = Math.max(brightest, storm.flash); assert.ok(storm.flash >= 0 && storm.flash <= 1); }
  assert.ok(storm.strikes >= 4 && storm.strikes <= 20, `${storm.strikes} strikes a minute`);
  assert.ok(brightest > 0.8);
  assert.equal(flashEnvelope(0), 1);
  assert.equal(flashEnvelope(1.5), 0);
  assert.equal(flashEnvelope(-1), 0);
});

// ---- The island ----

test('everything stands on the island, and the stream runs downhill from the pond over the edge', () => {
  const inside = (x: number, z: number, margin = 1) => Math.hypot(x, z) < rimRadius(Math.atan2(z, x)) - margin;
  for (const [x, z, s] of TREES) assert.ok(inside(x, z, 2 * s), `tree at ${x}, ${z}`);
  for (const [x, z] of LAMPS) assert.ok(inside(x, z));
  for (const t of TURBINES) assert.ok(inside(t.x, t.z, 2));
  assert.ok(inside(GREENHOUSE.x, GREENHOUSE.z, GREENHOUSE.r));
  assert.ok(inside(TOWER.x, TOWER.z, TOWER.half + 1));
  assert.ok(inside(POND.x, POND.z, POND.r + 1));
  // The pond's water sits below its banks, and above its bed.
  assert.ok(groundHeight(POND.x, POND.z) < POND.level);
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    const bank = groundHeight(POND.x + Math.cos(a) * POND.r * 1.15, POND.z + Math.sin(a) * POND.r * 1.15);
    const toLip = Math.cos(a - Math.atan2(LIP[1] - POND.z, LIP[0] - POND.x));
    if (toLip < 0.9) assert.ok(bank > POND.level, `bank at ${a.toFixed(1)}`);
  }
  const path = streamPath();
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i][1] <= path[i - 1][1] + 1e-9, 'downhill');
    assert.ok(groundHeight(path[i][0], path[i][2]) < path[i][1], 'its bed below its water');
  }
  assert.equal(path.at(-1)![1], LIP_LEVEL);
  assert.ok(Math.abs(Math.hypot(...LIP) - rimRadius(Math.atan2(LIP[1], LIP[0]))) < 1);
  // The islets stand clear of the island.
  for (const [x, , z, r] of ISLETS) assert.ok(Math.hypot(x, z) - r > 26);
});

test('the island narrows down to its tip, its ground everywhere finite', () => {
  // (Its rock is lumpy, so on average round it.)
  const mean = (t: number) => { let r = 0; for (let a = 0; a < 64; a++) r += undersideProfile(t, (a / 64) * Math.PI * 2).radius; return r / 64; };
  let last = { y: undersideProfile(0, 1).y, radius: mean(0) };
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const p = { y: undersideProfile(t, 1).y, radius: mean(t) };
    assert.ok(p.y < last.y, 'going down');
    assert.ok(p.radius < last.radius, 'narrowing');
    last = p;
  }
  assert.ok(last.radius < 1e-6);
  for (let x = -25; x <= 25; x += 2.5) for (let z = -25; z <= 25; z += 2.5) assert.ok(Number.isFinite(groundHeight(x, z)));
});
