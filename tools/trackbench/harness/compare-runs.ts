// Compare saved results exactly, apart from measured cost and run provenance.
//   node tools/trackbench/harness/compare-runs.ts <runA> <runB> [scene...]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA } from './common.ts';

type JsonObject = Record<string, unknown>;

/** Offline received_ms is the frame time, not a measurement: it must still match. */
export function withoutCost(row: JsonObject): JsonObject {
  const { inference_ms: _inference, roundtrip_ms: _roundtrip, ...rest } = row;
  return rest;
}

/** Keep all inference and tracking settings; ignore only cost and where/when the run was made. */
export function withoutProvenance(run: JsonObject): JsonObject {
  const { estimator: _id, dist: _dist, machine: _machine, at: _at, wall_s: _wall, inference_ms_mean: _inference, settings, ...rest } = run;
  const { warmup_ms: _warmup, ...stableSettings } = settings as JsonObject;
  return { ...rest, settings: stableSettings };
}

/** The first differing leaf, including absent fields and array lengths. */
export function firstDifference(a: unknown, b: unknown, field = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return field;
  if (Array.isArray(a) !== Array.isArray(b)) return field;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return `${field}.length`;
  const left = a as JsonObject, right = b as JsonObject;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const child = `${field}${Array.isArray(a) ? `[${key}]` : `.${key}`}`;
    if (Object.hasOwn(left, key) !== Object.hasOwn(right, key)) return child;
    const difference = firstDifference(left[key], right[key], child);
    if (difference) return difference;
  }
  return null;
}

export function compareScene(a: string, b: string): string | null {
  for (const file of ['detections.jsonl', 'tracked.jsonl', 'run.json']) {
    const left = path.join(a, file), right = path.join(b, file);
    if (!existsSync(left) || !existsSync(right)) return `${file}: missing ${!existsSync(left) ? left : right}`;
    if (file === 'run.json') {
      const l = withoutProvenance(JSON.parse(readFileSync(left, 'utf8'))), r = withoutProvenance(JSON.parse(readFileSync(right, 'utf8')));
      const field = firstDifference(l, r);
      if (field) return `${file}: field ${field}`;
      continue;
    }
    const leftText = readFileSync(left, 'utf8'), rightText = readFileSync(right, 'utf8');
    const lines = (text: string) => text.trimEnd().split('\n').filter(Boolean);
    const l = lines(leftText), r = lines(rightText);
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
      if (l[i] === undefined || r[i] === undefined) return `${file}: line ${i + 1}, field $ (missing line)`;
      const clean = (line: string) => file === 'detections.jsonl' ? withoutCost(JSON.parse(line)) : JSON.parse(line);
      const x = clean(l[i]), y = clean(r[i]);
      if (file === 'tracked.jsonl' ? l[i] !== r[i] : JSON.stringify(x) !== JSON.stringify(y)) return `${file}: line ${i + 1}, field ${firstDifference(x, y) ?? '$ (serialisation)'}`;
    }
    if (file === 'tracked.jsonl' && leftText !== rightText) return `${file}: line ${l.length}, field $ (serialisation)`;
  }
  return null;
}

function main() {
  const [runA, runB, ...requested] = process.argv.slice(2);
  if (!runA || !runB) throw Error('usage: node compare-runs.ts <runA> <runB> [scene...]');
  const dir = (id: string) => path.isAbsolute(id) ? id : path.join(DATA, 'runs', id);
  const a = dir(runA), b = dir(runB);
  const scenes = requested.length ? requested : [...new Set([a, b].flatMap(root => readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name)))].sort();
  let different = 0;
  for (const scene of scenes) {
    const difference = compareScene(path.join(a, scene), path.join(b, scene));
    if (difference) different++;
    console.log(`${scene}: ${difference ? `different: ${difference}` : 'identical'}`);
  }
  console.log(`${scenes.length - different}/${scenes.length} scenes identical (measured inference/roundtrip cost and run provenance excluded; received_ms retained)`);
  if (different) process.exitCode = 1;
}

if (import.meta.main) main();
