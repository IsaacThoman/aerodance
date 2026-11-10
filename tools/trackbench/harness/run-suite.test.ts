import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_JOBS, orderScenes, parseSuiteArgs, runDone, runJobs } from './run-suite.ts';
import { compareScene, firstDifference, withoutCost, withoutProvenance } from './compare-runs.ts';

test('suite orders longest scenes first without changing the input', () => {
  const scenes = [{ id: 'z', frames: 3 }, { id: 'b', frames: 8 }, { id: 'a', frames: 8 }];
  assert.deepEqual(orderScenes(scenes).map(s => s.id), ['a', 'b', 'z']);
  assert.equal(scenes[0].id, 'z');
});

test('suite separates runner flags, validates jobs and serialises realtime runs', () => {
  assert.equal(parseSuiteArgs(['--id', 'test']).jobs, DEFAULT_JOBS);
  assert.equal(parseSuiteArgs(['--id', 'test', '--jobs', '3']).browsers, 3, 'a browser for each job by default');
  assert.equal(parseSuiteArgs(['--id', 'test', '--jobs', '3', '--browsers', '9']).browsers, 3, 'never more browsers than jobs');
  const suite = parseSuiteArgs(['--id', 'test', '--jobs', '4', 'base-', '--', '--realtime', '--model', 'full']);
  assert.equal(suite.jobs, 1);
  assert.deepEqual(suite.prefixes, ['base-']);
  assert.deepEqual(suite.game, { realtime: true, model: 'full', id: 'test' });
  for (const jobs of ['0', '-1', '1.5', 'NaN', 'Infinity']) assert.throws(() => parseSuiteArgs(['--id', 'test', '--jobs', jobs]));
  assert.throws(() => parseSuiteArgs([]));
  assert.throws(() => parseSuiteArgs(['--id', 'test', '--', '--id', 'other']));
});

test('jobs overlap up to the limit, run each item once, and continue after a failure', async () => {
  let active = 0, peak = 0;
  const visited: number[] = [], failures: number[] = [];
  const count = await runJobs([0, 1, 2, 3, 4], 2, async item => {
    active++; peak = Math.max(peak, active); visited.push(item);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (item === 1) throw Error('scene failed');
  }, item => { failures.push(item); });
  assert.equal(peak, 2);
  assert.deepEqual(visited, [0, 1, 2, 3, 4]);
  assert.deepEqual(failures, [1]);
  assert.equal(count, 1);
  assert.equal(await runJobs([], 3, async () => assert.fail(), () => assert.fail()), 0);
});

test('comparison retains deterministic offline clocks and every inference setting', () => {
  assert.deepEqual(withoutCost({ inference_ms: 10, roundtrip_ms: 11, sent_ms: 2, received_ms: 3, people: [] }), { sent_ms: 2, received_ms: 3, people: [] });
  assert.deepEqual(withoutProvenance({ estimator: 'a', wall_s: 1, at: 'now', settings: { warmup_ms: 9, realtime: false, init: { zoom: true } } }), { settings: { realtime: false, init: { zoom: true } } });
  assert.equal(firstDifference({ people: [{ kp: [[1, 2]] }] }, { people: [{ kp: [[1, 3]] }] }), '$.people[0].kp[0][1]');
  assert.equal(firstDifference({ a: undefined }, {}), '$.a');
  assert.equal(firstDifference([1], [1, 2]), '$.length');
});


test('saved-run comparison ignores cost but detects changed poses, clocks, settings and bytes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'trackbench-compare-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  try {
    for (const [dir, cost] of [[a, 1], [b, 2]] as const) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'detections.jsonl'), JSON.stringify({ frame: 1, inference_ms: cost, roundtrip_ms: cost, people: [{ kp: [[0, 1, 2, 1]] }] }) + '\n');
      writeFileSync(path.join(dir, 'tracked.jsonl'), '{"frame":1,"received_ms":0,"poses":[]}\n');
      writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ estimator: dir, wall_s: cost, settings: { warmup_ms: cost, realtime: false, init: { zoom: true } } }));
    }
    assert.equal(compareScene(a, b), null);
    writeFileSync(path.join(b, 'tracked.jsonl'), '{"frame":1,"received_ms":1,"poses":[]}\n');
    assert.match(compareScene(a, b)!, /tracked.jsonl: line 1, field \$\.received_ms/);
    writeFileSync(path.join(b, 'tracked.jsonl'), '{"frame":1,"received_ms":0,"poses":[]}');
    assert.match(compareScene(a, b)!, /serialisation/);
    writeFileSync(path.join(b, 'tracked.jsonl'), '{"frame":1,"received_ms":0,"poses":[]}\n');
    writeFileSync(path.join(b, 'run.json'), JSON.stringify({ settings: { realtime: false, init: { zoom: false } } }));
    assert.match(compareScene(a, b)!, /run.json: field \$\.settings\.init\.zoom/);
    writeFileSync(path.join(b, 'detections.jsonl'), '{"frame":1,"people":[{"kp":[[9,1,2,1]]}]}\n');
    assert.match(compareScene(a, b)!, /detections.jsonl: line 1, field \$\.people\[0\]\.kp\[0\]\[0\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a scene counts as run only with non-empty tracking no older than its render, from a run that finished', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trackbench-suite-'));
  try {
    const output = path.join(dir, 'tracked.jsonl'), ready = path.join(dir, 'READY');
    assert.equal(runDone(output, ready), false, 'no tracking');
    writeFileSync(output, '');
    assert.equal(runDone(output, ready), false, 'empty tracking');
    writeFileSync(output, '{}\n'); writeFileSync(ready, '');
    utimesSync(output, 1000, 1000); utimesSync(ready, 2000, 2000);
    assert.equal(runDone(output, ready), false, 'the scene was rendered again since');
    utimesSync(output, 3000, 3000);
    assert.equal(runDone(output, ready), true);
    // A run that failed partway kept what it had: that isn't done either.
    writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ completed: false, error: 'the worker died' }));
    assert.equal(runDone(output, ready), false, 'a failed partial run');
    writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ completed: true }));
    assert.equal(runDone(output, ready), true);
    writeFileSync(path.join(dir, 'run.json'), '{');
    assert.equal(runDone(output, ready), false, 'a run record cut short');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
