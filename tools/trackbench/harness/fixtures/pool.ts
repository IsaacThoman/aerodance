// Exercises asynchronous completion, failed tasks and worker exits without loading scene data.
export async function task({ value, delay = 0, fail = false, exit = false }: { value: number; delay?: number; fail?: boolean; exit?: boolean }) {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (exit) process.exit(0);
  if (fail) throw new TypeError(`bad scene ${value}`);
  return { value, pid: process.pid, missing: undefined, nan: NaN, infinity: Infinity };
}
