// A bounded process pool for independent scenes. Keep reductions and output in the parent:
// completion order must never change floating-point sums, row order or the printed report.
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';

export const DEFAULT_JOBS = Math.max(1, availableParallelism() - 1);

export function jobsOption(value?: string | boolean): number {
  if (value === undefined) return DEFAULT_JOBS;
  const jobs = Number(value);
  if (typeof value !== 'string' || !Number.isSafeInteger(jobs) || jobs < 1) throw Error('--jobs must be a positive integer');
  return jobs;
}

type Reply<T> = { result: T } | { error: { name: string; message: string; stack?: string } };
interface Task<T> { module: string; method: string; item: T; }

function request<T>(child: ChildProcess, task: Task<unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const clean = () => { child.off('message', message); child.off('error', error); child.off('exit', exit); };
    const error = (err: Error) => { clean(); reject(err); };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => error(Error(`Scene worker exited (${signal ?? code})`));
    const message = (reply: Reply<T>) => {
      clean();
      if ('error' in reply) {
        const err = new Error(reply.error.message);
        err.name = reply.error.name; err.stack = reply.error.stack;
        reject(err);
      } else resolve(reply.result);
    };
    child.once('message', message); child.once('error', error); child.once('exit', exit);
    child.send(task, err => { if (err) error(err); });
  });
}

/** The function must be a named export of module and take one item. With one job it runs directly, in order, in this process. */
export async function scenePool<I, O>(module: URL, work: (item: I) => O | Promise<O>, items: readonly I[], jobs = DEFAULT_JOBS): Promise<O[]> {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw Error('--jobs must be a positive integer');
  if (!items.length) return [];
  if (jobs === 1) {
    const results: O[] = [];
    for (const item of items) results.push(await work(item));
    return results;
  }
  const children: ChildProcess[] = [], closed: Promise<void>[] = [];
  const results = new Array<O>(items.length);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
      // Advanced serialisation preserves undefined, NaN and Infinity just as an in-process call.
      const child = fork(new URL(import.meta.url), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push(child);
      closed.push(new Promise(resolve => child.once('close', () => resolve())));
      while (next < items.length) {
        const i = next++;
        results[i] = await request<O>(child, { module: module.href, method: work.name, item: items[i] });
      }
    }));
    return results;
  } finally {
    for (const child of children) child.kill();
    await Promise.all(closed);
  }
}

if (import.meta.main && process.send) {
  process.on('message', async ({ module, method, item }: Task<unknown>) => {
    let reply: Reply<unknown>;
    try { reply = { result: await (await import(module))[method](item) }; }
    catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      reply = { error: { name: err.name, message: err.message, stack: err.stack } };
    }
    process.send!(reply);
  });
}
