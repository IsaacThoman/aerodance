// The dance tool end to end in Chromium: a project made from the solo video fixture, the
// Studio editing it (drag a joint, key a pose, undo, live edits from the CLI, review and
// export), the headless renderer's contact sheet and MediaPipe tracking of the video; then the
// Studio making a dance in an empty folder, replacing its song, recording the (fake) webcam as
// its video, tracking it and keying the dancer from it.
//
//   node tools/dance/tests/studio.browser.ts          (needs FFmpeg and Playwright's Chromium)
//
// DANCE_DIST=1 serves the built Studio (npm run dance:build) instead of Vite. Without a GPU set
// PLAY_BROWSER_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader".
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumPath, gpuFlags } from '../../../scripts/chromium.ts';
import { readZip } from '../../../packages/pose/zip.ts';
import { validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import { neutralCharacterPose } from '../../../packages/pose/performance.ts';
import { Bridge, runBrowserCommand } from '../server.ts';
import { DanceProject, formatJson, initProject } from '../project.ts';
import { normalizeRecording, probeVideo, run } from '../media.ts';
import type { RenderSpec } from '../studio/renderSpec.ts';

const fixture = fileURLToPath(new URL('../../../packages/pose/tests/fixtures/solo-video-fixture.webm', import.meta.url));
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
const closers: (() => Promise<void>)[] = [];
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

  type Studio = { danceStudio: { jointOnPage(d: string, c: string): { x: number; y: number } } };
  const joint = (control: string) => page.evaluate(c => (window as unknown as Studio).danceStudio.jointOnPage('P1', c), control);
  const settled = () => page.waitForSelector('.studio[data-busy="false"]');

  step('a click selects a joint without keying it');
  const before = await revision();
  const right = await joint('rightWrist');
  await page.mouse.click(right.x + 2, right.y + 1);
  await page.waitForSelector('.studio[data-control="rightWrist"]');
  await page.waitForTimeout(500);
  assert.equal(await revision(), before);

  step('a drag keys the dancer\'s own time and drops the joint where the pointer leaves it');
  await project.apply({ ops: [{ op: 'dancer', dancer: 'P1', timeOffsetMs: 100 }, { op: 'nudge', dancer: 'P1', t: 300, fadeMs: 0, set: { leftWrist: [0.03, 0] } }] });
  await page.goto(`${bridge.url}?t=500`);
  await waitRevision(before + 1);
  const grab = await joint('leftWrist');
  await page.mouse.move(grab.x + 3, grab.y + 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + 23, grab.y - 18, { steps: 6 });
  await page.mouse.up();
  await waitRevision(before + 2);
  const dropped = await joint('leftWrist');
  assert.ok(Math.hypot(dropped.x - (grab.x + 20), dropped.y - (grab.y - 20)) <= 1.5, `dropped at ${JSON.stringify(dropped)}, grabbed ${JSON.stringify(grab)}`);
  assert.ok((await project.read()).dancers[0].layers[0].channels.leftWrist.some(k => k.t === 400), 'keyed at dancer time 400 (song 500 minus the offset)');

  step('quick successive edits all land, in order');
  const slider = page.getByLabel('Fixes weight');
  await slider.focus();
  for (let i = 0; i < 5; i++) await slider.press('ArrowLeft');
  await settled();
  await page.waitForFunction(() => !document.querySelector('.studio [data-busy="true"]'));
  await page.waitForTimeout(300);
  await settled();
  assert.equal((await project.read()).dancers[0].layers[1].weight, 0.75);
  assert.equal(await page.locator('.message.error').count(), 0);

  step('a drag that can\'t apply is undone on screen, and later edits from elsewhere still show');
  const keyTimesNow = (await project.read()).dancers[0].layers[0].channels.leftWrist.map(k => k.t);
  const [k1, k2] = keyTimesNow.slice(-2);
  type Timeline = { danceTimeline: { keyOnPage(d: string, c: string | null, t: number): { x: number; y: number } } };
  const from = await page.evaluate(([t]) => (window as unknown as Timeline).danceTimeline.keyOnPage('P1', 'leftWrist', t), [k1]);
  const onto = await page.evaluate(([t]) => (window as unknown as Timeline).danceTimeline.keyOnPage('P1', 'leftWrist', t), [k2]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(onto.x, onto.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector('.message.error');
  const elsewhere = await project.apply({ ops: [{ op: 'song', set: { title: 'After a failed drag' } }] });
  await page.waitForSelector(`.studio[data-revision="${elsewhere.revision}"][data-saved-revision="${elsewhere.revision}"]`);
  assert.equal(await page.locator('.song-title strong').textContent(), 'After a failed drag');
  await page.locator('.message button').click();

  step('Studio and CLI edits made at the same time all land');
  // The fixture's song is 0.8 s long: start early enough for six distinct frames.
  await page.goto(`${bridge.url}?t=100`);
  await page.waitForSelector('.studio[data-time="100"]');
  await settled();
  const headKeys = (await project.read()).dancers[0].layers[0].channels.head.length;
  const cli = (async () => {
    for (let i = 0; i < 6; i++) { await project.apply({ ops: [{ op: 'key', dancer: 'P1', t: 2000 + i * 50, set: { headRoll: i } }] }); await new Promise(r => setTimeout(r, 15)); }
  })();
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('k'); }
  await cli;
  await settled();
  await page.waitForTimeout(500);
  await settled();
  const final = await project.read();
  assert.equal(final.dancers[0].layers[0].channels.headRoll.filter(k => k.t >= 2000 && k.t < 2300).length, 6, 'every CLI key');
  assert.equal(final.dancers[0].layers[0].channels.head.length, headKeys + 6, 'and every Studio pose key');
  assert.equal(await page.locator('.message.error').count(), 0);

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

  step('renders asked for at once all finish, and follow hand edits that keep the revision');
  const stampNow = async () => (await import('node:crypto')).createHash('sha1').update(await readFile(project.file)).digest('hex').slice(0, 16);
  const small = (cellWidth: number, stamp: string): RenderSpec => ({ ...spec, revision: dance.revision, stamp, times: [200], views: ['character'], cellWidth, labels: false });
  const atOnce = await Promise.race([Promise.all([bridge.render(small(160, await stampNow())), bridge.render(small(200, await stampNow()))]),
    new Promise<never>((_, reject) => setTimeout(() => reject(Error('concurrent renders hung')), 60000))]);
  assert.equal(atOnce.length, 2);
  const overlay = (stamp: string): RenderSpec => ({ ...spec, revision: dance.revision, stamp, times: [200], views: ['skeleton'], cellWidth: 200, labels: false });
  const plain = await bridge.render(overlay(await stampNow()));
  const text = await readFile(project.file, 'utf8');
  // Moved by hand, revision unchanged.
  const handEdited = JSON.parse(text) as typeof dance;
  for (const k of handEdited.dancers[0].layers[0].channels.leftWrist) (k.v as number[])[0] += 0.15;
  await (await import('node:fs/promises')).writeFile(project.file, formatJson(handEdited) + '\n');
  const edited = await bridge.render(overlay(await stampNow()));
  assert.notDeepEqual(edited, plain, 'the hand edit shows');
  await (await import('node:fs/promises')).writeFile(project.file, text);

  step('dancer selection hides authored performances as well as landmark poses');
  const blank = await bridge.render({ ...small(160, await stampNow()), dancers: [] });
  const reach = neutralCharacterPose();
  reach.leftHand = [1.2, 3.7, .6];
  await project.apply({ ops: [{ op: 'performance', dancer: 'P1', id: 'reach', start: 0, end: 800,
    keys: [{ t: 0, pose: reach }, { t: 800, pose: reach }] }] });
  dance = await project.read();
  const selected = await bridge.render({ ...small(160, await stampNow()), dancers: ['P1'] });
  const excluded = await bridge.render({ ...small(160, await stampNow()), dancers: [] });
  assert.notDeepEqual(selected, blank, 'the included dancer renders its authored performance');
  assert.deepEqual(excluded, blank, 'an excluded authored dancer leaves the same empty scene');
  await project.apply({ ops: [{ op: 'performance', dancer: 'P1', id: 'reach', action: 'remove' }] });

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
  const duet = await initProject(path.join(dir, 'duet'), { video: fileURLToPath(new URL('../../../packages/pose/tests/fixtures/video-fixture.webm', import.meta.url)),
    dancers: 2, proxy: false, durationMs: 800 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runBrowserCommand('track', duet, await duet.read(), { fps: '10' }, true); }
  finally { process.stdout.write = out; }
  const both = await duet.tracking('t1');
  const sides = [0, 1].map(slot => Array.from(both.times, (_, i) => both.poseAtFrame(slot, i)).filter(Boolean)
    .map(l => (l![23].x + l![24].x) / 2));
  assert.ok(sides.every(s => s.length >= both.times.length - 1), `each slot found: ${sides.map(s => s.length).join(', ')} of ${both.times.length}`);
  assert.ok(Math.max(...sides[0]) < 0.5 && Math.min(...sides[1]) > 0.5, 'P1 is the dancer on the left, P2 on the right');
  step('the Studio makes a dance in a folder with none');
  const fresh = new DanceProject(path.join(dir, 'fresh'));
  const freshBridge = await Bridge.start(fresh, { dist: process.env.DANCE_DIST === '1' });
  closers.push(() => freshBridge.close());
  const camera = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const cameraErrors: string[] = [];
  camera.on('pageerror', e => cameraErrors.push(e.message));
  camera.on('console', m => { if (m.type() === 'error') cameraErrors.push(m.text()); });
  camera.setDefaultTimeout(120000);
  // A webcam that shows the MediaPipe fixture photo, as scripts/play.ts fakes it.
  const photo = `data:image/jpeg;base64,${(await readFile(fileURLToPath(new URL('../../../apps/web/tests/fixtures/mediapipe-pose.jpg', import.meta.url)))).toString('base64')}`;
  await camera.addInitScript((image: string) => {
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fixture', label: 'Fixture camera', groupId: '' }],
      getUserMedia: async () => {
        const picture = new Image(); picture.src = image; await picture.decode();
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
        const g = canvas.getContext('2d')!;
        let count = 0;
        const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480); g.drawImage(picture, 200, 0, 600, 667, 160 + Math.sin(count++ / 5) * 4, 40, 320, 356); };
        draw();
        const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
        for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); }; }
        return stream;
      },
      addEventListener() {}, removeEventListener() {},
    } });
  }, photo);
  await camera.goto(freshBridge.url);
  await camera.getByRole('form', { name: 'New dance' }).waitFor();
  await camera.getByLabel('Title', { exact: true }).fill('Made in the Studio');
  await camera.getByLabel('Artist', { exact: true }).fill('Test');
  await camera.getByLabel('Video', { exact: true }).setInputFiles(fixture);
  await camera.getByRole('button', { name: 'Create the dance' }).click();
  await camera.waitForSelector('.studio[data-revision]');
  let made = await fresh.read();
  assert.equal(made.song.title, 'Made in the Studio');
  assert.equal(made.dancers.length, 1);
  assert.equal(made.sources.video?.width, 320);
  assert.ok(made.sources.audio, 'the video\'s sound becomes the song');
  assert.equal(await camera.locator('.song-title strong').textContent(), 'Made in the Studio');

  step('the Song tab replaces the song');
  // A second and a half of 440 Hz, as 16-bit mono WAV.
  const rate = 48000, samples = rate * 1.5, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  const tone = path.join(dir, 'tone.wav');
  await writeFile(tone, wav);
  await camera.getByRole('tab', { name: 'Song' }).click();
  const created = made.revision;
  await camera.getByLabel('Song audio file', { exact: true }).setInputFiles(tone);
  await camera.waitForSelector(`.studio[data-revision="${created + 1}"]`);
  made = await fresh.read();
  assert.notEqual(made.sources.audio?.sha256, undefined);
  assert.equal(made.sources.audio?.durationMs, 1500);
  assert.match(made.sources.audio!.path, /^sources\/audio-[0-9a-f]{12}\.wav$/);
  assert.equal(made.song.durationMs, 800, 'replacing the song keeps its length');

  step('a recording handed frames from before it started keeps only what it recorded');
  // Three seconds of frames from a recorder that ran for one: the first two are cut.
  const backlog = path.join(dir, 'backlog.webm');
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=20:duration=3', '-c:v', 'libvpx', backlog]);
  for (const [ran, kept] of [[1000, 1000], [3000, 3000], [undefined, 3000]] as const) {
    await normalizeRecording(backlog, path.join(dir, 'normalized.webm'), 20, { durationMs: ran });
    const { durationMs } = await probeVideo(path.join(dir, 'normalized.webm'));
    assert.ok(Math.abs(durationMs - kept) <= 100, `ran ${ran} ms: kept ${durationMs} ms, not ${kept}`);
  }

  step('recording the webcam makes the video, lined up with the song');
  await fresh.apply({ ops: [{ op: 'song', set: { durationMs: 1500, playableEndMs: 1500 } }] });
  await camera.waitForSelector(`.studio[data-revision="${created + 2}"]`);
  await camera.getByRole('button', { name: 'Start the camera' }).click();
  await camera.getByLabel('Countdown seconds').fill('0');
  await camera.getByRole('button', { name: 'Record', exact: true }).click();
  await camera.getByText(/^Recorded /).waitFor();
  made = await fresh.read();
  const recorded = made.sources.video!;
  assert.notEqual(recorded.sha256, (await fresh.revisionAt(created)).sources.video?.sha256, 'the recording replaces the video');
  assert.equal(recorded.width, 640);
  assert.equal(recorded.fps, 20);
  assert.equal(recorded.proxy, null, 'a recording plays in the browser as it is');
  // It stops with the 1.5 s song, and keeps no more than it recorded. How much of that a browser
  // starved by software rendering gets is up to it: this fake camera draws on the main thread.
  assert.ok(recorded.durationMs > 0 && recorded.durationMs <= 2000, `recorded ${recorded.durationMs} ms of a 1500 ms song`);
  assert.ok(recorded.startMs >= 0 && recorded.startMs < 400, `starts at ${recorded.startMs} ms of the song`);

  step('the Studio tracks the recording and keys the dancer from it');
  await camera.getByRole('button', { name: 'Track the video' }).click();
  await camera.getByText(/^Tracked \d+ frames: P1 in/).waitFor();
  made = await fresh.read();
  assert.equal(made.sources.tracking.length, 1);
  await camera.getByRole('button', { name: 'Key dancers from tracking' }).click();
  await camera.getByText(/^Keyed P1 from the tracking/).waitFor();
  made = await fresh.read();
  assert.ok(made.dancers[0].layers[0].channels.leftWrist.length >= 2, 'the left wrist is keyed from the recording');
  await camera.screenshot({ path: path.join(dir, 'recorded.png') });
  assert.deepEqual(cameraErrors, []);
  step('passed');
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  await browser.close();
  await bridge.close();
  if (process.exitCode) process.stdout.write(`kept ${dir} for inspection\n`);
  else await rm(dir, { recursive: true, force: true });
}
