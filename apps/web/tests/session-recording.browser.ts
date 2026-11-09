// Drives the real app and MediaRecorder through play.ts, including its GPU renderer.
// Run: node apps/web/tests/session-recording.browser.ts. Evidence stays in .cache/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readSession, summarizeSession } from '../../../tools/replay/session.ts';

const env = { ...process.env, PLAY_SESSION: 'recorder' };
function play(...args: string[]) {
  return execFileSync(process.execPath, ['scripts/play.ts', ...args], { env, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 }).trim();
}
function evaluate<T>(code: string): T { return JSON.parse(play('eval', code)) as T; }
function round() {
  play('click', 'MINIGAMES');
  play('wait', 'minigameScreen=list', 'minigameSelectReady=true');
  play('click', 'mgTile.0');
  play('wait', 'minigameScreen=preview', 'minigameSelectReady=true');
  play('click', 'MG_PLAY');
  play('wait', 'minigamePhase=calibrating', 'minigameReady=true');
  play('click', 'GAME_CALIBRATION_PREVIEW');
  play('wait', 'minigamePhase=howto', '--timeout', '20000');
  play('click', 'MG_HOWTO_START');
  play('wait', 'minigamePhase=playing', '--timeout', '8000');
}
function measure() {
  return evaluate<number>(`new Promise(resolve => {
    const times = [];
    const off = minigame.source.subscribeRecords(event => { if ('record' in event) times.push(performance.now()); });
    setTimeout(() => { off(); resolve((times.length - 1) * 1000 / (times.at(-1) - times[0])); }, 20000);
  })`);
}
const evidence = '.cache/session-recording';
await mkdir(evidence, { recursive: true });
try {
  console.log(play('start', '--url', '/?input=puppet'));
  round();
  assert.equal(evaluate("typeof minigame.record === 'undefined' && minigame.source.webcam.source.frameListeners.size === 0"), true);
  const baselineHz = measure();
  play('key', 'Escape'); play('click', 'GAME_QUIT');
  play('goto', '/?input=puppet&record=session');
  // Exercise streaming with real filesystem handles (OPFS stands in for the user's directory).
  evaluate(`window.pickerCalls = 0; window.showDirectoryPicker = async () => { pickerCalls++; return navigator.storage.getDirectory(); }; true`);
  round();
  const recordingHz = measure();
  evaluate(`minigame.report({ recorderTest: 1 }); minigame.report({ recorderTest: 1 }); minigame.record('paddle-test', { side: 'left' }); true`);
  play('shot', `${evidence}/rec.png`, '--frame');
  play('key', 'Escape');
  play('click', 'GAME_QUIT');
  const files = evaluate<{ name: string; text?: string; base64?: string }[]>(`(async () => {
    const root = await navigator.storage.getDirectory();
    for (let i = 0; i < 100; i++) {
      const files = [];
      for await (const [name, handle] of root.entries()) {
        if (!name.startsWith('aerodance-')) continue;
        const f = await handle.getFile();
        files.push(name.endsWith('.jsonl') ? { name, text: await f.text() } : { name, base64: await new Promise(resolve => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(f);
        }) });
      }
      if (files.some(f => f.text?.includes('"type":"end"')) && files.some(f => f.base64?.length)) return files;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('Session files did not close');
  })()`);
  const log = files.find(f => f.text)!;
  assert.ok(log);
  for (const f of files) await writeFile(`${evidence}/${f.name}`, f.text ?? Buffer.from(f.base64!, 'base64'));
  const session = await readSession(`${evidence}/${log.name}`);
  for (const type of ['header', 'video-start', 'frame', 'pose', 'phase', 'report', 'stats', 'paddle-test', 'end'])
    assert.ok(session.records.some(line => line.type === type), `has ${type}`);
  assert.ok(!('deviceId' in session.header.camera));
  assert.equal((session.records.at(-1) as { data: { reason: string } }).data.reason, 'disposed');
  assert.equal(session.records.filter(line => line.type === 'report' && 'data' in line && JSON.stringify(line.data).includes('recorderTest')).length, 1);
  assert.ok(session.records.every((line, i) => !i || line.t >= session.records[i - 1].t));
  assert.equal(evaluate('pickerCalls'), 1);
  const summary = summarizeSession(session);
  const report = { baselineHz, recordingHz, summary };
  await writeFile(`${evidence}/summary.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  // A second round reuses the chosen directory, and results finish it without quitting.
  play('wait', 'minigameScreen=preview', 'minigameSelectReady=true');
  play('click', 'MG_PLAY');
  play('wait', 'minigamePhase=howto', '--timeout', '20000');
  play('click', 'MG_HOWTO_START');
  play('wait', 'minigamePhase=playing', '--timeout', '8000');
  evaluate(`minigame.finish(); true`);
  play('wait', 'minigamePhase=results');
  assert.equal(evaluate('pickerCalls'), 1);
  assert.equal(evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    for (let i = 0; i < 100; i++) {
      for await (const [name, handle] of root.entries()) {
        if (name.endsWith('.jsonl') && (await (await handle.getFile()).text()).includes('"reason":"results"')) return true;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  })()`), true);
  // Exercise VP9 when MP4 is unavailable, and two downloads when the page hides.
  play('goto', '/?input=puppet&record=session');
  evaluate(`window.showDirectoryPicker = undefined; window.savedDownloads = [];
    const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
    MediaRecorder.isTypeSupported = type => !type.includes('mp4') && supported(type);
    HTMLAnchorElement.prototype.click = function() { savedDownloads.push({ name: this.download, url: this.href }); }; true`);
  round();
  evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); true`);
  const downloads = evaluate<{ name: string; size: number; text?: string }[]>(`(async () => {
    for (let i = 0; i < 100 && savedDownloads.length < 2; i++) await new Promise(r => setTimeout(r, 50));
    return Promise.all(savedDownloads.map(async f => {
      const blob = await (await fetch(f.url)).blob();
      return { name: f.name, size: blob.size, text: f.name.endsWith('.jsonl') ? await blob.text() : undefined };
    }));
  })()`);
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(f => f.size > 0));
  assert.ok(downloads.some(f => f.name.endsWith('.webm')));
  assert.ok(downloads.some(f => f.text?.includes('"reason":"hidden"')));
  console.log('Session recording browser checks passed (streaming, reuse, quit, results, hidden, download fallback).');
} finally { console.log(play('stop')); }
