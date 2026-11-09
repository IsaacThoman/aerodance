import assert from 'node:assert/strict';
import test from 'node:test';
import { jobsOption, scenePool } from './pool.ts';
import { task } from './fixtures/pool.ts';

const module = new URL('./fixtures/pool.ts', import.meta.url);
type Item = Parameters<typeof task>[0];
type Result = Awaited<ReturnType<typeof task>>;
const run = (items: Item[], jobs: number) => scenePool<Item, Result>(module, task, items, jobs);

test('scene pool returns scene order despite completion order and reuses bounded workers', async () => {
  const rows = await run([{ value: 0, delay: 100 }, { value: 1 }, { value: 2 }, { value: 3 }], 2);
  assert.deepEqual(rows.map(r => r.value), [0, 1, 2, 3]);
  assert.equal(new Set(rows.map(r => r.pid)).size, 2);
  for (const row of rows) {
    assert.notEqual(row.pid, process.pid);
    assert.ok(Object.hasOwn(row, 'missing'));
    assert.equal(row.missing, undefined);
    assert.ok(Number.isNaN(row.nan));
    assert.equal(row.infinity, Infinity);
  }
});

test('jobs=1 runs sequentially in the parent', async () => {
  const rows = await run([{ value: 1, delay: 10 }, { value: 2 }], 1);
  assert.deepEqual(rows.map(r => [r.value, r.pid]), [[1, process.pid], [2, process.pid]]);
});

for (const jobs of [1, 2]) {
  test(`scene errors reject and clean up the pool (jobs=${jobs})`, async () => {
    await assert.rejects(run([{ value: 0, fail: true }, { value: 1, delay: 30_000 }], jobs), { name: 'TypeError', message: 'bad scene 0' });
  });
}

test('an unexpected successful worker exit rejects instead of hanging', async () => {
  await assert.rejects(run([{ value: 0, exit: true }], 2), /Scene worker exited \(0\)/);
});

test('empty pools and invalid job counts', async () => {
  assert.deepEqual(await run([], 2), []);
  assert.ok(jobsOption() >= 1);
  assert.equal(jobsOption('1'), 1);
  for (const value of ['0', '-1', '1.5', '', 'no', true]) assert.throws(() => jobsOption(value), /positive integer/);
  await assert.rejects(run([], 0), /positive integer/);
});
