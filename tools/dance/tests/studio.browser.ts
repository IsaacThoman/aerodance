// The dance tool end to end in Chromium: a project made from the solo video fixture, the
// Studio editing it (drag a joint, key a pose, undo, live edits from the CLI, review and
// export), the headless renderer's contact sheet and MediaPipe tracking of the video.
//
//   node tools/dance/tests/studio.browser.ts          (needs FFmpeg and Playwright's Chromium)
//
// DANCE_DIST=1 serves the built Studio (npm run dance:build) instead of Vite. Without a GPU set
// PLAY_BROWSER_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader".
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumPath, gpuFlags } from '../../../scripts/chromium.ts';
import { readZip } from '../../../packages/pose/zip.ts';
import { validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import { Bridge, runBrowserCommand } from '../server.ts';
import { initProject } from '../project.ts';
import type { RenderSpec } from '../studio/renderSpec.ts';

const fixture = fileURLToPath(new URL('../../choreography/tests/solo-video-fixture.webm', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), 'dance-studio-'));
const step = (message: string) => process.stdout.write(`· ${message}\n`);
const project = await initProject(path.join(dir, 'routine'), { video: fixture, dancers: 1, title: 'Fixture', artist: 'Test', proxy: false });
let dance = await project.read();
assert.equal(dance.frame.width, 320);
assert.ok(dance.sources.audio, 'the fixture\'s audio becomes the song');
await project.apply({ ops: [{ op: 'dancer', dancer: 'P1', home: [0.5, 0.52] }, { op: 'pose', dancer: 'P1', t: 0, from: 'neutral' },
  { op: 'key', dancer: 'P1', t: 400, set: { leftWrist: { dy: -0.2 } } }] });
const bridge = await Bridge.start(project, { dist: process.env.DANCE_DIST === '1' });
const browser = await chromium.launch({ headless: true, executablePath: chromiumPath(false), args: gpuFlags() });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
page.setDefaultTimeout(90000);
const revision = () => page.locator('.studio').getAttribute('data-revision').then(Number);
const waitRevision = (n: number) => page.waitForSelector(`.studio[data-revision="${n}"][data-busy="false"]`);
try {
  step('the Studio opens the dance');
  await page.goto(bridge.url);
  await waitRevision(1);
  assert.equal(await page.locator('.song-title strong').textContent(), 'Fixture');

  step('dragging a joint keys it at the playhead');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.studio[data-time="200"]');
  const wrist = await page.evaluate(() => (window as unknown as { danceStudio: { jointOnPage(d: string, c: string): { x: number; y: number } } }).danceStudio.jointOnPage('P1', 'leftWrist'));
  await page.mouse.move(wrist.x, wrist.y);
  await page.mouse.down();
  await page.mouse.move(wrist.x + 20, wrist.y - 30, { steps: 6 });
  await page.mouse.up();
  await waitRevision(2);
  dance = await project.read();
  const keyed = dance.dancers[0].layers[0].channels.leftWrist.find(k => k.t === 200);
  assert.ok(keyed, 'a left wrist key at 200 ms');
  assert.equal(await page.locator('.studio').getAttribute('data-control'), 'leftWrist');

  step('K keys the whole pose; undo takes it back');
  await page.keyboard.press('k');
  await waitRevision(3);
  assert.equal((await project.read()).dancers[0].layers[0].channels.head.some(k => k.t === 200), true);
  await page.keyboard.press('Control+z');
  await waitRevision(4);
  assert.equal((await project.read()).dancers[0].layers[0].channels.head.some(k => k.t === 200), false);

  step('edits from the CLI appear while the Studio is open');
  await project.apply({ ops: [{ op: 'song', set: { title: 'Edited elsewhere', bpm: 120 } }] });
  await page.waitForFunction(() => document.querySelector('.song-title strong')?.textContent === 'Edited elsewhere');
  assert.equal(await revision(), 5);

  step('the inspector types exact values');
  const x = page.getByLabel('x', { exact: true });
  await x.fill('0.61');
  await x.press('Enter');
  await waitRevision(6);
  const typed = (await project.read()).dancers[0].layers[0].channels.leftWrist.find(k => k.t === 200)!;
  assert.equal((typed.v as number[])[0], 0.61);

  step('the timeline retimes a key by dragging it');
  const key = await page.evaluate(() => (window as unknown as { danceTimeline: { keyOnPage(d: string, c: string | null, t: number): { x: number; y: number } } })
    .danceTimeline.keyOnPage('P1', 'leftWrist', 400));
  await page.mouse.move(key.x, key.y);
  await page.mouse.down();
  await page.mouse.move(key.x + 25, key.y, { steps: 5 });
  await page.mouse.up();
  await waitRevision(7);
  const times = (await project.read()).dancers[0].layers[0].channels.leftWrist.map(k => k.t);
  assert.ok(!times.includes(400) && times.some(t => t > 420 && t < 520), `the key moved later: ${times.join(', ')}`);

  step('review checks the dance and exports a song the game accepts');
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Check' }).click();
  await page.waitForSelector('.findings, .card .hint >> text=warnings');
  await page.getByRole('button', { name: 'Export song ZIP' }).click();
  await page.waitForSelector('text=Download ZIP');
  const exports = (await readFile(project.meta('exports', (await import('node:fs')).readdirSync(project.meta('exports'))[0]))).subarray();
  const zip = await readZip(new Uint8Array(exports));
  const songPath = [...zip.keys()].find(p => p.endsWith('/song.json'))!;
  const song = validateSong(JSON.parse(new TextDecoder().decode(zip.get(songPath))));
  validateSongChoreography(song, zip.get(songPath.replace('song.json', 'choreography.adpose'))!);
  assert.equal(song.dancers, 1);

  step('the 3D views render (characters and the game stage)');
  await page.getByRole('button', { name: 'Game', exact: true }).click();
  await page.waitForSelector('.studio[data-mode="game"]');
  await page.waitForSelector('.game-frame canvas');
  await page.screenshot({ path: path.join(dir, 'studio.png') });
  assert.deepEqual(errors, []);

  step('the renderer draws a contact sheet');
  dance = await project.read();
  const spec: RenderSpec = { revision: dance.revision, times: [0, 200, 400], views: ['overlay', 'character'], dancers: null, focus: null, zoom: null,
    cellWidth: 200, reference: false, ghosts: true, mirror: false, labels: true, grid: true, title: 'test' };
  const png = await bridge.render(spec);
  assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  // A label column, the 200 px video cell and a 4:3 character cell, three rows of 300 px each.
  assert.equal(width, 132 + 200 + 6 + 400 + 6);
  assert.equal(height, 40 + 3 * (300 + 6));

  step('tracking finds the dancer in the video');
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runBrowserCommand('track', project, await project.read(), { fps: '10' }, true); }
  finally { process.stdout.write = out; }
  dance = await project.read();
  assert.equal(dance.sources.tracking.length, 1);
  const tracking = await project.tracking('t1', dance);
  const found = Array.from(tracking.times, (_, i) => tracking.poseAtFrame(0, i)).filter(Boolean).length;
  assert.ok(found >= tracking.times.length - 1, `found the dancer in ${found} of ${tracking.times.length} frames`);

  step('tracking keeps two dancers in their own slots');
  const duet = await initProject(path.join(dir, 'duet'), { video: fileURLToPath(new URL('../../choreography/tests/video-fixture.webm', import.meta.url)),
    dancers: 2, proxy: false, durationMs: 800 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runBrowserCommand('track', duet, await duet.read(), { fps: '10' }, true); }
  finally { process.stdout.write = out; }
  const both = await duet.tracking('t1');
  const sides = [0, 1].map(slot => Array.from(both.times, (_, i) => both.poseAtFrame(slot, i)).filter(Boolean)
    .map(l => (l![23].x + l![24].x) / 2));
  assert.ok(sides.every(s => s.length >= both.times.length - 1), `each slot found: ${sides.map(s => s.length).join(', ')} of ${both.times.length}`);
  assert.ok(Math.max(...sides[0]) < 0.5 && Math.min(...sides[1]) > 0.5, 'P1 is the dancer on the left, P2 on the right');
  step('passed');
} finally {
  await browser.close();
  await bridge.close();
  if (process.exitCode) process.stdout.write(`kept ${dir} for inspection\n`);
  else await rm(dir, { recursive: true, force: true });
}
