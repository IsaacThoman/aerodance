// Hooks for client-tvos/bench/aeroBench.ts: its config comes from the launch config, and its
// reports gain the host's own frame timings (JavaScript, submit, executor, GPU) before they are
// POSTed to the launch config's report URL.
import { Q, native } from './native.ts';

type BenchHost = { bench?: { measureS?: number } & Record<string, unknown>; report?: string; label?: string };

export function installBench(g: Record<string, unknown>, config: BenchHost) {
  if (!config.bench) return;
  g.__benchConfig = { label: config.label, ...config.bench };
  const measureMs = (config.bench.measureS ?? 30) * 1000;
  g.__benchReport = (json: string) => {
    const r = JSON.parse(json) as Record<string, unknown>;
    r.host = { runtime: 'jsc-gles', mode: ['direct', 'batched', 'threaded'][native.mode] };
    if (r.type === 'scenario') Object.assign(r.host as object, JSON.parse(native.query(Q.frameStats, measureMs) as string));
    if (!config.report) return;
    fetch(config.report, { method: 'POST', body: JSON.stringify(r) }).catch((e: unknown) => console.warn('report failed', String(e)));
  };
}
