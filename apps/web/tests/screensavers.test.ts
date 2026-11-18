import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_OPTIONS, SHUFFLE_ID, clockFor, listScreensavers, ownOptions, saverProblem, sceneFor, unusedShared } from '../src/screensavers/definition.ts';
import { ScreensaverHost, shufflePick } from '../src/screensavers/host.ts';
import { previewRows, saveSaverValue, saverValues, sharedValues } from '../src/screensavers/options.ts';
import { svTile, screensaverLayout, SV_PER_PAGE } from '../src/screensavers/layout.ts';
import { MG_MAX_OPTIONS } from '../src/minigames/layout.ts';
import { moonPhase, solarNoon, sunCrossing, sunPosition } from '../src/screensavers/sky/astro.ts';
import { Sky, heldPlace, heldTime, skyAt, skyDirection, zoneGuess } from '../src/screensavers/sky/sky.ts';
import type { Place } from '../src/screensavers/sky/sky.ts';
import { FAIR, WEATHER_PRESETS, formatTemperature, usesFahrenheit, weatherFrom } from '../src/screensavers/sky/weather.ts';
import { zonePlace } from '../src/screensavers/sky/zones.ts';
import { clockText } from '../src/screensavers/clock.ts';
import type { ScreensaverDefinition } from '../src/screensavers/types.ts';

const saver = (patch: Partial<ScreensaverDefinition> = {}): ScreensaverDefinition => ({
  id: 'test-saver', title: 'Test', subtitle: 'A test', icon: () => {}, views: [{ value: 'wide', label: 'Wide' }, { value: 'close', label: 'Close' }],
  load: async () => ({ default: () => null }), ...patch,
});
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}
const CHICAGO: Place = { lat: 41.88, lon: -87.63, name: 'Chicago', source: 'zone' };

// ---- Definitions ----

test('a screensaver definition is checked', () => {
  assert.equal(saverProblem(saver()), '');
  assert.match(saverProblem(saver({ id: 'Bad Id' })), /id/);
  assert.match(saverProblem(saver(), 'other-folder'), /match its folder/);
  assert.match(saverProblem(saver({ id: SHUFFLE_ID })), /list's own/);
  assert.match(saverProblem(saver({ views: [] })), /views/);
  assert.match(saverProblem(saver({ views: [{ value: 'auto', label: 'Auto' }] })), /'auto'/);
  assert.match(saverProblem(saver({ views: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] })), /twice/);
  assert.match(saverProblem(saver({ scenarios: [{ value: 'one', label: 'One' }] })), /scenarios/);
  assert.match(saverProblem(saver({ load: undefined })), /custom/);
  assert.equal(saverProblem(saver({ load: undefined, scene: { background: 'koi' } })), '');
  assert.match(saverProblem(saver({ suits: ['noon' as never] })), /suits/);
  assert.match(saverProblem(saver({ cutEvery: 2 })), /cutEvery/);
});

test('every screensaver folder has a valid definition', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/screensavers');
  const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'index.ts'))).map((d) => d.name);
  assert.ok(folders.length >= 5);
  const found: { folder: string; def: ScreensaverDefinition }[] = [];
  for (const folder of folders) {
    const def = (await import(path.join(dir, folder, 'index.ts'))).default as ScreensaverDefinition;
    assert.equal(saverProblem(def, folder), '', folder);
    // Room on the preview: its own rows and the shared ones.
    assert.ok(previewRows(def).length <= MG_MAX_OPTIONS, `${folder} has too many rows`);
    found.push({ folder, def });
  }
  const listed = listScreensavers(found);
  assert.equal(listed.length, folders.filter((f) => !found.find((x) => x.folder === f)?.def.devOnly).length);
});

test('the list is ordered and leaves out broken and dev-only screensavers', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const list = listScreensavers([
      { folder: 'b', def: saver({ id: 'b', title: 'Bee', order: 2 }) },
      { folder: 'a', def: saver({ id: 'a', title: 'Ant', order: 2 }) },
      { folder: 'c', def: saver({ id: 'c', title: 'Cat', order: 1 }) },
      { folder: 'd', def: saver({ id: 'd', title: 'Dev', devOnly: true }) },
      { folder: 'e', def: { id: 'e' } },
    ]);
    assert.deepEqual(list.map((s) => s.id), ['c', 'a', 'b']);
    assert.ok(listScreensavers([{ folder: 'd', def: saver({ id: 'd', devOnly: true }) }], { dev: true }).length === 1);
  } finally { console.error = quiet; }
});

test('a scene can depend on the scenario', () => {
  const def = saver({ scenarios: [{ value: 'koi', label: 'Koi' }, { value: 'club', label: 'Club' }], scene: (s) => (s === 'club' ? { stage: 'club' } : { background: 'koi' }) });
  assert.deepEqual(sceneFor(def, 'club'), { stage: 'club' });
  assert.deepEqual(sceneFor(def, 'koi'), { background: 'koi' });
  assert.equal(sceneFor(saver(), ''), 'custom');
});

test('the preview rows: View with Auto first only when there are views to choose, then Scene, then the shared ones', () => {
  assert.deepEqual(ownOptions(saver({ views: [{ value: 'only', label: 'Only' }] })), []);
  const rows = ownOptions(saver({ scenarios: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], scenarioLabel: 'Match' }));
  assert.deepEqual(rows.map((r) => r.id), ['view', 'scenario']);
  assert.equal(rows[0].choices[0].value, 'auto');
  assert.equal(rows[0].default, 'auto');
  assert.equal(rows[1].label, 'Match');
  assert.deepEqual(previewRows(saver()).map((r) => r.id), ['view', ...SHARED_OPTIONS.map((o) => o.id)]);
  assert.deepEqual(previewRows(null).map((r) => r.id), ['every', ...SHARED_OPTIONS.map((o) => o.id)]);
  assert.equal(unusedShared(saver(), 'time'), true);
  assert.equal(unusedShared(saver({ follows: { time: true } }), 'time'), false);
  assert.equal(unusedShared(saver(), 'clock'), false);
  assert.equal(unusedShared(null, 'weather'), false);
});

test('In scene is a Clock choice only for a screensaver with a clock of its own', () => {
  const plain = saver(), clocked = saver({ sceneClock: true });
  const clockRow = (s: ScreensaverDefinition | null) => previewRows(s).find((r) => r.id === 'clock')!.choices.map((c) => c.value);
  assert.deepEqual(clockRow(plain), ['corner', 'large', 'off']);
  assert.deepEqual(clockRow(clocked), ['corner', 'large', 'scene', 'off']);
  assert.deepEqual(clockRow(null), ['corner', 'large', 'scene', 'off']);
  // Chosen for all, it's the corner chip on one without a clock.
  assert.equal(clockFor(plain, 'scene'), 'corner');
  assert.equal(clockFor(clocked, 'scene'), 'scene');
  assert.equal(clockFor(plain, 'large'), 'large');
  assert.match(saverProblem(saver({ sceneClock: true, load: undefined, scene: { background: 'koi' } })), /sceneClock/);
  const host = new ScreensaverHost([plain, clocked]);
  host.clockChoice = 'scene';
  assert.equal(host.context({ saver: plain, scenario: '' }).clock(), 'corner');
  assert.equal(host.context({ saver: clocked, scenario: '' }).clock(), 'scene');
});

test('settings are kept per screensaver, and the shared ones for all', () => {
  const storage = memoryStorage();
  const a = saver({ id: 'a' }), b = saver({ id: 'b' });
  assert.equal(saverValues(a, storage).view, 'auto');
  saveSaverValue(a, 'view', 'close', storage);
  saveSaverValue(a, 'weather', 'rain', storage);
  saveSaverValue(null, 'every', '10', storage);
  assert.equal(saverValues(a, storage).view, 'close');
  assert.equal(saverValues(b, storage).view, 'auto');
  assert.equal(sharedValues(storage).weather, 'rain');
  assert.equal(saverValues(null, storage).every, '10');
  // Choices it doesn't offer are ignored, and the minigames' own settings are left alone.
  saveSaverValue(a, 'view', 'nonsense', storage);
  assert.equal(saverValues(a, storage).view, 'close');
  assert.deepEqual([...storage.data.keys()], ['aerodance-screensaver-options']);
});

test('the list layout fits its page above the page controls', () => {
  for (const width of [1600, 1200]) {
    const l = screensaverLayout(width, 5);
    const last = svTile(SV_PER_PAGE - 1, width);
    assert.ok(last.y + last.h < l.SV_PAGE_PREV.y - l.SV_PAGE_PREV.r);
    assert.ok(l.SV_LOCATE.y + l.SV_LOCATE.h < l.SV_START.y, 'Use my location sits above Start');
    assert.ok(l.SV_OPTIONS && l.SV_OPTIONS.y + l.SV_OPTIONS.h < l.SV_NOTE_Y);
  }
});

// ---- The sky ----

test('the sun and the moon are where they should be', () => {
  // Chicago at the June solstice's solar noon: about 71.5° up, due south.
  const sun = sunPosition(new Date('2026-06-21T18:00:00Z'), CHICAGO.lat, CHICAGO.lon);
  assert.ok(Math.abs(sun.elevation - 71.5) < 1, String(sun.elevation));
  assert.ok(Math.abs(sun.azimuth - 180) < 10, String(sun.azimuth));
  // Midnight there: well below the horizon.
  assert.ok(sunPosition(new Date('2026-06-22T05:00:00Z'), CHICAGO.lat, CHICAGO.lon).elevation < -15);
  // The full moon of 24 November 2026, and the new moon of 9 November.
  assert.ok(moonPhase(new Date('2026-11-24T15:00:00Z')).lit > 0.98);
  assert.ok(moonPhase(new Date('2026-11-09T07:00:00Z')).lit < 0.02);
  // East is +x, north −z, up +y.
  const east = skyDirection({ elevation: 0, azimuth: 90 }), north = skyDirection({ elevation: 0, azimuth: 0 });
  assert.ok(east[0] > 0.99 && Math.abs(north[2] + 1) < 1e-9);
});

test('sunrise, sunset and noon come out in the right order, where there are any', () => {
  // (In the device's own day, so from where its time zone is.)
  const here = zoneGuess();
  const day = new Date(2026, 10, 16, 12);
  const rise = sunCrossing(day, here.lat, here.lon, -0.833, true)!;
  const set = sunCrossing(day, here.lat, here.lon, -0.833, false)!;
  const noon = solarNoon(day, here.lat, here.lon);
  assert.ok(rise < noon && noon < set);
  assert.ok(Math.abs(sunPosition(rise, here.lat, here.lon).elevation + 0.833) < 0.05);
  // The polar night: no sunrise at all.
  assert.equal(sunCrossing(new Date(2026, 11, 21, 12), 80, 15, 0, true), null);
});

test('the Time setting holds the sun where its name says', () => {
  const now = new Date(2026, 10, 16, 12), here = zoneGuess();
  const at = (choice: Parameters<typeof heldTime>[0]) => skyAt(heldTime(choice, now, here), here, FAIR);
  const sunrise = at('sunrise'), sunset = at('sunset'), day = at('day'), night = at('night');
  assert.ok(Math.abs(sunrise.sun.elevation - 4) < 0.5 && sunrise.rising && sunrise.phase === 'dawn');
  assert.ok(Math.abs(sunset.sun.elevation - 4) < 0.5 && !sunset.rising && sunset.phase === 'dusk');
  assert.equal(day.phase, 'day');
  assert.ok(day.daylight > 0.99);
  assert.equal(night.phase, 'night');
  assert.ok(night.daylight < 0.01);
  assert.ok(sunset.golden > 0.5 && day.golden < 0.1);
});

test('the place is the time zone\'s, or a guess from the clock', () => {
  assert.equal(zonePlace('America/Chicago')?.name, 'Chicago');
  assert.equal(zonePlace('Asia/Calcutta')?.name, 'Kolkata');
  assert.equal(zonePlace('America/Argentina/Buenos_Aires')?.name, 'Buenos Aires');
  assert.equal(zonePlace('Etc/GMT+5'), null);
  const chicago = zoneGuess('America/Chicago', 360);
  assert.equal(chicago.source, 'zone');
  assert.ok(Math.abs(chicago.lat - 41.9) < 0.2 && Math.abs(chicago.lon + 87.6) < 0.2);
  const guess = zoneGuess('UTC', 300);
  assert.equal(guess.source, 'guess');
  assert.equal(guess.lon, -75);
});

test('the weather reads Open-Meteo\'s codes', () => {
  const rain = weatherFrom({ weather_code: 63, temperature_2m: 11.4, cloud_cover: 100, wind_speed_10m: 20 });
  assert.equal(rain.kind, 'rain');
  assert.ok(rain.rain > 0.5 && rain.snow === 0 && rain.clouds === 1 && rain.wind === 0.5);
  assert.equal(rain.temperature, 11.4);
  assert.equal(weatherFrom({ weather_code: 75 }).kind, 'snow');
  assert.equal(weatherFrom({ weather_code: 95 }).lightning, true);
  assert.equal(weatherFrom({ weather_code: 45 }).fog > 0.5, true);
  // A clear sky stays clear whatever the cloud cover says; an unknown code is fair.
  assert.ok(weatherFrom({ weather_code: 0, cloud_cover: 80 }).clouds <= 0.25);
  assert.equal(weatherFrom({ weather_code: 1234 }).kind, 'partly');
  for (const preset of Object.values(WEATHER_PRESETS)) assert.equal(preset.temperature, null);
});

test('temperatures and the clock read as the device does', () => {
  assert.equal(usesFahrenheit('en-US'), true);
  assert.equal(usesFahrenheit('en-GB'), false);
  assert.equal(usesFahrenheit('de'), false);
  assert.equal(formatTemperature(10, true), '50°');
  assert.equal(formatTemperature(-2.4, false), '-2°');
  const { time, day } = clockText(new Date(2026, 10, 16, 21, 41));
  assert.match(time, /41/);
  assert.ok(day.length > 5);
});

// ---- The host ----

// Steps a host until `until` holds (or a time limit), with its scene ready or not.
function run(host: ScreensaverHost, seconds: number, sceneReady = true, until?: () => boolean) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    host.step(1 / 60, sceneReady);
    if (until?.()) return;
  }
}

test('a change of screensaver goes behind the veil, and waits for the new one to be ready', () => {
  const a = saver({ id: 'a' }), b = saver({ id: 'b', scene: { background: 'koi' }, load: undefined });
  const host = new ScreensaverHost([a, b]);
  let changes = 0;
  host.onChange(() => changes++);
  host.show(a);
  run(host, 0.2);
  assert.ok(host.fade.value > 0.3);
  assert.equal(host.shown, null);
  const shown = () => host.shown?.saver ?? null;
  run(host, 1, true, () => shown() === a);
  assert.equal(shown(), a);
  assert.equal(host.fade.value, 1);
  assert.equal(changes, 1);
  // A custom world waits for ctx.ready(), whatever its scene says.
  run(host, 2);
  assert.equal(host.fade.value, 1);
  host.context(host.shown!).ready();
  run(host, 2);
  assert.equal(host.fade.value, 0);
  assert.ok(host.settled());
  // A background one: its part mounted, and its scene showing.
  host.show(b);
  run(host, 1, false, () => host.shown?.saver === b);
  host.context(host.shown!).ready();
  run(host, 2, false);
  assert.equal(host.fade.value, 1);
  run(host, 2, true);
  assert.ok(host.settled());
});

test('leaving waits for the veil, then for the menus\' background', () => {
  const a = saver({ id: 'a' });
  const host = new ScreensaverHost([a]);
  host.show(a);
  run(host, 1, true, () => host.shown?.saver === a);
  host.context(host.shown!).ready();
  run(host, 2);
  let left = false;
  host.leave(() => { left = true; });
  run(host, 1, true, () => left);
  assert.equal(left, true);
  assert.equal(host.shown, null);
  assert.equal(host.scene(), null);
  run(host, 2, false);
  assert.equal(host.fade.value, 1);
  run(host, 2, true);
  assert.equal(host.fade.value, 0);
});

test('Auto cuts between the views, and the arrows step them', () => {
  const a = saver({ id: 'a', cutEvery: 10, views: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'three', label: 'Three' }] });
  const host = new ScreensaverHost([a]);
  host.show(a);
  run(host, 1, true, () => host.shown?.saver === a);
  const ctx = host.context(host.shown!);
  ctx.ready();
  assert.equal(ctx.view(), 'one');
  run(host, 10.5);
  assert.equal(ctx.view(), 'two');
  assert.ok(ctx.viewTime() < 1);
  host.stepView(1);
  assert.equal(ctx.view(), 'three');
  host.stepView(1);
  assert.equal(ctx.view(), 'one');
  host.chooseView('two');
  run(host, 30);
  assert.equal(ctx.view(), 'two');
});

test('the picture moves right while the preview covers the left', () => {
  const a = saver({ id: 'a' });
  const host = new ScreensaverHost([a]);
  host.show(a);
  run(host, 1, true, () => host.shown?.saver === a);
  const ctx = host.context(host.shown!);
  ctx.ready();
  host.covered = true;
  run(host, 3);
  assert.ok(ctx.shift() > 0.15);
  host.full = true;
  run(host, 3);
  assert.ok(ctx.shift() < 0.01);
});

test('Left and Right go round the list; Shuffle passes over ones that don\'t suit the time of day', () => {
  const a = saver({ id: 'a' }), b = saver({ id: 'b', suits: ['night'] }), c = saver({ id: 'c', scenarios: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] });
  const host = new ScreensaverHost([a, b, c]);
  host.show(a);
  host.stepSaver(1);
  assert.equal(host.wanted()?.saver, b);
  host.stepSaver(-1);
  host.stepSaver(-1);
  assert.equal(host.wanted()?.saver, c);
  assert.equal(host.wanted()?.scenario, 'x');
  assert.equal(shufflePick([a, b, c], 'a', 1, { phase: 'day' }, () => 0.9)?.saver, c);
  assert.equal(shufflePick([a, b, c], 'a', 1, { phase: 'day' }, () => 0.9)?.scenario, 'y');
  assert.equal(shufflePick([a, b, c], 'a', 1, { phase: 'night' })?.saver, b);
  // Nothing suits: the next one anyway.
  assert.equal(shufflePick([b], null, 1, { phase: 'day' })?.saver, b);
});

test('a View chosen for the screensaver coming on waits for it, and leaves the one going alone', () => {
  const views = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }];
  const a = saver({ id: 'a', views }), b = saver({ id: 'b', views });
  const host = new ScreensaverHost([a, b]);
  host.show(a, '', 'one');
  run(host, 1, true, () => host.shown?.saver === a);
  host.context(host.shown!).ready();
  run(host, 2);
  assert.equal(host.view(), 'one');
  host.show(b, '', 'two');
  run(host, 0.1);
  assert.equal(host.view(), 'one', 'the one going keeps its view');
  run(host, 1, true, () => host.shown?.saver === b);
  assert.equal(host.view(), 'two');
});

test('Left and Right bring each screensaver on with its own Scene and View; Shuffle steps from the one on its way', () => {
  const views = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }];
  const a = saver({ id: 'a', views }), b = saver({ id: 'b', views, scenarios: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] }), c = saver({ id: 'c' });
  const host = new ScreensaverHost([a, b, c]);
  host.show(a);
  host.stepSaver(1, (s) => (s === b ? { scenario: 'y', view: 'two' } : {}));
  assert.deepEqual([host.wanted()?.saver, host.wanted()?.scenario, host.wanted()?.view], [b, 'y', 'two']);
  host.shuffle.on = true;
  host.stepSaver(1);
  host.stepSaver(1);
  // Two quick presses: two along from b (c, then a), not c twice.
  assert.equal(host.wanted()?.saver, a);
});

test('only the screensaver showing reports, and only changes count', () => {
  const a = saver({ id: 'a' }), b = saver({ id: 'b' });
  const host = new ScreensaverHost([a, b]);
  host.show(a);
  run(host, 1, true, () => host.shown?.saver === a);
  const old = host.context(host.shown!);
  old.report({ score: 3 });
  const version = host.reportsVersion;
  old.report({ score: 3 });
  assert.equal(host.reportsVersion, version);
  assert.equal(host.takeReports().svScore, '3');
  host.show(b);
  run(host, 1, true, () => host.shown?.saver === b);
  old.report({ score: 4 });
  assert.equal(host.takeReports().svScore, undefined);
});

test('a held Night is night and a held Sunrise is a sunrise, even near the poles in summer', () => {
  const reykjavik: Place = { lat: 64.1, lon: -21.9, name: 'Reykjavik', source: 'zone' };
  const june = new Date(2026, 5, 21, 12);
  const at = (choice: Parameters<typeof heldTime>[0]) => skyAt(heldTime(choice, june, heldPlace(reykjavik)), heldPlace(reykjavik), FAIR);
  assert.equal(at('night').phase, 'night');
  assert.ok(Math.abs(at('sunrise').sun.elevation - 4) < 0.5);
  assert.equal(heldPlace(CHICAGO).lat, CHICAGO.lat);
});

test('the live weather is only fetched for something that shows it', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ current: { weather_code: 61, temperature_2m: 9 } })); }) as typeof fetch;
  try {
    const s = new Sky();
    s.choose('live', 'live');
    s.state();
    s.weather();
    assert.equal(calls, 0);
    s.state({ fetch: true });
    assert.equal(calls, 1);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(s.liveWeather()?.kind, 'rain');
    // Fresh: not fetched again.
    s.wantLive();
    assert.equal(calls, 1);
  } finally { globalThis.fetch = real; }
});
