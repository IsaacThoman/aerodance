import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticStudio, browserStore } from './static-helpers.ts';
import { baseUrl, found, openSidebar, songFolder, zipPose } from './helpers.ts';
import { validateTake, validateTrackData } from '../core.ts';
import { readZip } from '../server/zip.ts';
import { VideoWave } from '../web/videoAudio.ts';

const { app, dispose } = await staticStudio(), server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-accelerated-video-decode'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(60000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'])
        if (name in Type.prototype) Reflect.set(Type.prototype, name, () => {});
    }
  });
  await page.goto(baseUrl(server));
  await page.getByRole('heading', { name: 'Preview' }).waitFor();
  const store = browserStore(page), projectId = found((await store.list())[0]).projectId;
  await openSidebar(page, 'Import');
  await page.getByLabel('Import song audio', { exact: true }).setInputFiles({ name: 'original.wav', mimeType: 'audio/wav', buffer: Buffer.from(new VideoWave(8000, 1, 800).bytes) });
  await page.getByText(/Audio imported/).waitFor();
  const originalAudio = (await store.project(projectId)).audio;
  assert.equal(await page.getByRole('button', { name: 'Replace audio', exact: true }).count(), 0);
  // A silent source reports an error before processing poses or replacing music.
  await openSidebar(page, 'Import');
  await page.getByLabel('Import video', { exact: true }).setInputFiles(path.resolve('tools/choreography/tests/video-fixture.webm'));
  await page.getByLabel('Video pose model').selectOption('full');
  await page.getByLabel('Use video audio as song audio').check();
  await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>('dialog video')?.readyState ?? 0) >= 2);
  await page.getByRole('button', { name: 'Use current frame for calibration' }).click();
  await page.getByText(/Calibration at .*P1 and P2 ready/).waitFor();
  await page.getByRole('button', { name: 'Process video', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: /no audio track/ }).waitFor();
  assert.deepEqual((await store.project(projectId)).audio, originalAudio);
  assert.equal((await store.project(projectId)).takes.length, 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openSidebar(page, 'Import');
  await page.getByLabel('Import video', { exact: true }).setInputFiles(path.resolve('tools/choreography/tests/solo-video-fixture.webm'));
  const panel = page.getByRole('dialog', { name: 'Import video' });
  await panel.waitFor();
  assert.equal(await page.getByLabel('Use video audio as song audio').isChecked(), false);
  await page.getByLabel('Video players').selectOption('p2');
  await page.getByLabel('Video pose model').selectOption('full');
  await page.getByLabel('Use video audio as song audio').check();
  await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>('dialog video')?.readyState ?? 0) >= 2);
  await page.getByRole('button', { name: 'Use current frame for calibration' }).click();
  await page.getByText(/Calibration at .*P2 ready/).waitFor();
  assert.equal(await page.getByText(/P1 not detected/).count(), 0);
  // Simulate storage failure at the combined audio/library commit, after pose finalization.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const value: unknown = args[0];
      const key: unknown = args[1];
      if (typeof key === 'string' && key.endsWith('/project.json') && value && typeof value === 'object' && 'bytes' in value) {
        IDBObjectStore.prototype.put = original;
        throw new DOMException('Injected combined save failure', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Process video', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: /storage is full/ }).waitFor();
  let saved = await store.project(projectId);
  assert.deepEqual(saved.audio, originalAudio); assert.equal(saved.takes.length, 0);
  await page.getByRole('button', { name: 'Save take', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  saved = await store.project(projectId);
  assert.equal(saved.takes.length, 1);
  assert.equal(saved.audio?.name, 'solo-video-fixture.wav');
  assert.equal(saved.audio.extension, 'wav');
  assert.ok(saved.durationMs >= 790 && saved.durationMs <= 850);
  assert.ok(saved.tracks.every(t => t.dataId === null));
  const take = validateTake(await store.take(projectId, saved.takes[0].takeId));
  assert.equal(take.provenance?.captureMode, 'p2');
  assert.ok(take.samples.every(s => s.poses.every(p => p.playerId === 1)));
  assert.ok(take.samples.some(s => s.poses.length));
  assert.deepEqual(found(take.calibrationFrame).poses.map(p => p.playerId), [1]);
  const wave = await store.bytes(store.location(projectId, 'assets', `${saved.audio.sha256}.wav`));
  assert.ok(wave.slice(44).some(value => value !== 0), 'extracted audio must contain the sine tone');
  assert.equal(await page.getByRole('button', { name: 'Replace audio', exact: true }).count(), 0);
  await page.getByLabel('Take actions: solo-video-fixture.webm', { exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Overwrite P1 track', exact: true }).isDisabled(), true);
  await page.getByRole('menuitem', { name: 'Overwrite P2 track', exact: true }).click();
  await page.getByRole('button', { name: 'Select P2', exact: true }).click();
  await page.getByRole('button', { name: 'P2 track options', exact: true }).click();
  await page.getByRole('button', { name: 'Mirror P2 track to P1', exact: true }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  saved = await store.project(projectId);
  assert.ok(saved.tracks.every(t => t.dataId));
  const destination = validateTrackData(await store.track(projectId, found(saved.tracks[0].dataId)));
  assert.ok(destination.samples.every(s => s.poses.every(p => p.playerId === 0)));
  await page.getByRole('button', { name: '↶ Undo', exact: true }).click();
  await page.getByRole('button', { name: '↷ Redo', exact: true }).click();
  // Review the mirrored destination using the actual editor, then complete song metadata in storage.
  await page.getByRole('button', { name: 'Select P1', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByLabel('Review reason').fill('Checked the reflected solo performance');
  await page.getByRole('button', { name: '✓ Approve selected references', exact: true }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  saved = await store.project(projectId);
  saved.metadata.artist = 'Solo fixture'; saved.alignmentReviewed = true;
  saved.playableStartMs = take.samples[0].takeTimeMs;
  saved.playableEndMs = found(take.samples.at(-1)).takeTimeMs;
  saved = await store.save(saved, saved.revision);
  await page.reload(); await page.getByRole('heading', { name: 'Preview' }).waitFor();
  const bundle = readZip(await store.download(projectId, 'export')), folder = songFolder(bundle);
  const choreography = zipPose(bundle, `${folder}/choreography.adpose`);
  assert.equal(choreography.playerSlots, 2);
  assert.deepEqual(found(choreography.tracks).map(t => t.playerId), [0, 1]);
  assert.ok(Array.from(choreography.present).every(mask => mask === 3));
  assert.ok(bundle.has(`${folder}/audio.wav`));
  const backup = await store.download(projectId, 'backup'), restored = await store.restore(backup);
  assert.deepEqual(restored.tracks, saved.tracks);
  assert.equal(restored.audio?.sha256, saved.audio?.sha256);
  assert.deepEqual(errors, []);
  console.log('Solo workflow passed: whole-frame P2 import, video audio, atomic failure/retry, mirror to P1, review, reopen, two-player export and backup restore.');
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/aerodance-solo-workflow-failure.png' });
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await dispose();
}
