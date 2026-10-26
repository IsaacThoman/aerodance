#!/usr/bin/env node
// dance: animate Aerodance dancers to a video from the command line (docs/dance-cli.md).
//
//   node tools/dance/cli.ts <command> <project> [options]     (npm run dance -- …)
//
// Every command prints a compact, readable summary, or JSON with --json. Edits go through
// `apply` (or undo/redo) and are checked, atomic and revisioned; previews render in a headless
// browser, kept running by `dance studio` so repeated previews are quick.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkDance, compareToTracking } from './check.ts';
import type { Finding } from './check.ts';
import { compileDance } from './compile.ts';
import { createEvaluator, keyTimes } from './evaluate.ts';
import { CONTROLS, GROUPS, POINTS, SCALARS, aspectOf, expandControls, findDancer, isMidJoint } from './format.ts';
import type { AnyKey, Dance, Dancer } from './format.ts';
import { OP_NAMES, channelFilter, channelNames } from './ops.ts';
import { DanceProject, RevisionConflict, attachSources, initProject } from './project.ts';
import type { ApplyResult } from './project.ts';
import { rigToLandmarks } from './rig.ts';
import { scoreAgainstTracking } from './score.ts';
import { beatAt, formatTime, parseRange, parseTime } from './time.ts';
import { JOINT_NAMES } from '../../packages/pose/choreography.ts';
import { createPerformanceSampler } from '../../packages/pose/performance.ts';

const USAGE = `dance: animate Aerodance dancers to a video (docs/dance-cli.md)

  node tools/dance/cli.ts <command> <project> [options]

Project
  init <dir> [--video v.mp4] [--audio a.wav] [--dancers 1-4] [--title t] [--artist a]
             [--link] [--no-proxy] [--no-video-audio] [--duration 30s]
  attach <dir> [--audio a.wav] [--video v.mp4] [--link]   add or replace the song audio or video
  show <dir>                          song, sources, dancers, layers, key counts
  log <dir>                           the undo and redo history

Read the animation
  keys <dir> [--dancer P1] [--range a:b] [--controls c,…] [--layer id] [--performance]
  pose <dir> --at t [--dancer P1] [--landmarks | --performance]     every control's value at t
  sample <dir> --range a:b [--every 100] [--dancer P1] --controls c,…   values over time

Edit (atomic; prints what changed)
  apply <dir> [patch.json | -] [--op '{"op":"key",…}']… [--expect-revision n] [--op-id id] [--dry-run]
  undo <dir> | redo <dir> [--expect-revision n]

Look (needs Chromium; \`dance studio\` keeps one running)
  frames <dir> (--at t,… | --range a:b [--every 250]) [--views overlay,character] [--dancer P1]
               [--zoom body|P1|P1:hands|P1:feet|P1:head|x,y,w,h] [--grid] [--reference] [--ghosts] [--mirror]
               [--trails [ms]] [--before <revision>] [--width 360] [--out f.png]
  render <dir> --range a:b [--fps 30] [--views overlay,character] [--no-audio] [--out clip.mp4]
  track <dir> [--fps 15] [--range a:b] [--no-strips]   track the dancers with MediaPipe Lite (several
                                               dancers each get a strip of the picture around their home)
  studio <dir> [--port 5310] [--dist]          the Studio (and a fast renderer for the CLI)

Review and publish
  check <dir> [--range a:b] [--dancer P1]      likely problems, each with a time and a fix
  score <dir>                                  the game's scorer, with the tracked video as the player
  compare <dir> [--range a:b] [--every 500]    how far each scored limb points from the tracked video
  export <dir> [--out song.zip] [--install] [--folder dir]

Times: 4200 (ms), 4.2s, 1:02.5, b17 (beat 17; needs the song's bpm). Ranges: a:b or a..b.
Ops: ${OP_NAMES.join(', ')}.
Controls: ${CONTROLS.join(', ')}.
Groups: ${Object.keys(GROUPS).join(', ')}.
Add --json to any command for machine-readable output.`;

type Values = Record<string, string | boolean | string[] | undefined>;
const OPTIONS = {
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  video: { type: 'string' }, audio: { type: 'string' }, dancers: { type: 'string' }, title: { type: 'string' }, artist: { type: 'string' },
  link: { type: 'boolean' }, 'no-proxy': { type: 'boolean' }, 'no-video-audio': { type: 'boolean' }, duration: { type: 'string' },
  dancer: { type: 'string' }, range: { type: 'string' }, controls: { type: 'string' }, layer: { type: 'string' },
  at: { type: 'string' }, landmarks: { type: 'boolean' }, every: { type: 'string' },
  performance: { type: 'boolean' },
  op: { type: 'string', multiple: true }, 'expect-revision': { type: 'string' }, 'op-id': { type: 'string' }, 'dry-run': { type: 'boolean' }, label: { type: 'string' },
  views: { type: 'string' }, zoom: { type: 'string' }, reference: { type: 'boolean' }, mirror: { type: 'boolean' }, width: { type: 'string' },
  out: { type: 'string' }, fps: { type: 'string' }, 'no-audio': { type: 'boolean' }, port: { type: 'string' }, dist: { type: 'boolean' },
  install: { type: 'boolean' }, folder: { type: 'string' }, open: { type: 'boolean' }, stage: { type: 'string' }, ghosts: { type: 'boolean' }, grid: { type: 'boolean' },
  trails: { type: 'string' }, before: { type: 'string' }, 'no-strips': { type: 'boolean' },
} as const;

const fixed = (v: number, d = 4) => Number(v.toFixed(d));
const print = (v: unknown) => process.stdout.write(typeof v === 'string' ? v.endsWith('\n') ? v : v + '\n' : JSON.stringify(v, null, 2) + '\n');
const fmtPoint = (v: readonly number[]) => `[${v.map(n => fixed(n)).join(', ')}]`;
function opt(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}
function need(values: Values, name: string): string {
  const v = opt(values, name);
  if (v === undefined) throw Error(`--${name} is required`);
  return v;
}

function showDance(dance: Dance, project: DanceProject): string {
  const s = dance.song, lines: string[] = [];
  lines.push(`${s.title || '(untitled)'}${s.artist ? ` · ${s.artist}` : ''}   revision ${dance.revision}   ${project.dir}`);
  lines.push(`song ${formatTime(s.durationMs)}, playable ${formatTime(s.playableStartMs)}–${formatTime(s.playableEndMs)}, stage ${s.stage}` +
    (s.bpm ? `, ${s.bpm} bpm from ${s.beatOffsetMs} ms` : ', no bpm'));
  lines.push(`frame ${dance.frame.width}×${dance.frame.height} (aspect ${fixed(aspectOf(dance), 3)})`);
  const v = dance.sources.video;
  lines.push(v ? `video ${v.path} ${v.width}×${v.height} ${v.fps} fps ${formatTime(v.durationMs)}, plays from song ${v.startMs} ms at rate ${v.rate}${v.proxy ? `, proxy ${v.proxy}` : ''}` : 'video none');
  lines.push(dance.sources.audio ? `audio ${dance.sources.audio.path} ${formatTime(dance.sources.audio.durationMs)}` : 'audio none (needed to export)');
  for (const t of dance.sources.tracking) lines.push(`tracking ${t.id}: ${t.path}, ${t.fps} fps, slots → ${t.dancers.map((d, i) => `${i}:${d ?? '-'}`).join(' ')}`);
  for (const d of dance.dancers) {
    lines.push(`${d.id} "${d.label}" home ${fmtPoint(d.home)} offset ${d.timeOffsetMs} ms`);
    for (const layer of d.layers) {
      const channels = channelNames(layer).map(n => `${n}:${layer.channels[n].length}`);
      const times = keyTimes(d, d.layers.indexOf(layer));
      lines.push(`  layer ${layer.id}${layer.mode === 'additive' ? ` (additive ×${layer.weight}${layer.enabled ? '' : ', off'})` : ''}: ` +
        (times.length ? `${times.length} key times ${formatTime(times[0])}–${formatTime(times[times.length - 1])}; ${channels.join(' ')}` : 'no keys'));
    }
    if (d.contacts.length) lines.push(`  contacts ${d.contacts.map(c => `${c.id} ${c.control} ${c.startMs}–${c.endMs}`).join(', ')}`);
    if (d.exclusions.length) lines.push(`  unscored ${d.exclusions.map(x => `${x.id} ${x.startMs}–${x.endMs}${x.controls ? ` ${x.controls.join('+')}` : ''} (${x.reason})`).join(', ')}`);
    for (const c of d.performance ?? []) lines.push(`  performance ${c.id}: ${c.keys.length} character poses ${formatTime(c.startMs)}–${formatTime(c.endMs)}`);
  }
  if (dance.phrases.length) lines.push(`phrases ${dance.phrases.map(p => `${p.id} "${p.label}" ${p.startMs}–${p.endMs}${p.dancer ? ` ${p.dancer}` : ''}`).join(', ')}`);
  if (dance.markers.length) lines.push(`markers ${dance.markers.map(m => `${m.timeMs} ${m.kind}${m.label ? ` "${m.label}"` : ''}`).join(', ')}`);
  return lines.join('\n');
}
/** A layer's keys, on the dancer's own clock like the ops that make them (song time minus its offset). */
function keysTable(dance: Dance, dancer: Dancer, layerId: string | undefined, range: [number, number] | null, controls: string[] | null): { text: string; json: unknown } {
  const layer = layerId ? dancer.layers.find(l => l.id === layerId) : dancer.layers[0];
  if (!layer) throw Error(`${dancer.id} has no layer ${layerId}`);
  const selects = channelFilter({ op: 'keys', ...(controls ? { controls } : {}) }, layer);
  const names = channelNames(layer).filter(selects);
  const json: Record<string, AnyKey[]> = {};
  const offset = dancer.timeOffsetMs;
  const lines = [`${dancer.id} layer ${layer.id} (${layer.mode})${range ? ` ${range[0]}–${range[1]} ms` : ''}` +
    (offset ? `; times on ${dancer.id}'s clock: each plays ${offset > 0 ? `${offset} ms later` : `${-offset} ms earlier`} in the song` : '')];
  for (const n of names) {
    const keys = layer.channels[n].filter(k => !range || k.t >= range[0] && k.t <= range[1]);
    if (!keys.length) continue;
    json[n] = keys;
    lines.push(`${n} (${keys.length})`);
    for (const k of keys) {
      const beat = beatAt(dance, k.t);
      lines.push(`  ${String(k.t).padStart(8)}${beat === null ? '' : ` b${fixed(beat, 2)}`}${offset ? ` (song ${k.t + offset})` : ''}  ${Array.isArray(k.v) ? fmtPoint(k.v) : `${k.v}°`}` +
        `${k.interp ? ` ${k.interp}` : ''}${k.ease ? ` ease:${k.ease}` : ''}`);
    }
  }
  return { text: lines.join('\n'), json: { dancer: dancer.id, layer: layer.id, channels: json } };
}
function poseReport(dance: Dance, dancers: Dancer[], t: number, landmarks: boolean) {
  return dancers.map(d => {
    const e = createEvaluator(dance, d), rig = e.rig(t);
    const points = Object.fromEntries(POINTS.map(p => [p, rig.points[p].map(v => fixed(v))]));
    const out: Record<string, unknown> = { dancer: d.id, songTimeMs: t, points, turn: fixed(rig.turn, 2), headYaw: fixed(rig.headYaw, 2),
      headPitch: fixed(rig.headPitch, 2), headRoll: fixed(rig.headRoll, 2),
      auto: Object.keys(points).filter(p => isMidJoint(p) && !(d.layers[0].channels[p]?.length)) };
    if (landmarks) out.landmarks = rigToLandmarks(rig, d.body, aspectOf(dance)).map((l, i) => ({ i, name: JOINT_NAMES[i], x: fixed(l.x), y: fixed(l.y), z: fixed(l.z) }));
    return out;
  });
}
function formatFindings(findings: Finding[], dance: Dance): string {
  if (!findings.length) return 'No findings.';
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const lines = findings.map(f => `${f.severity.padEnd(7)} ${formatTime(f.startMs, dance)}${f.endMs > f.startMs ? `–${formatTime(f.endMs)}` : ''}` +
    `  ${f.kind}${f.control ? ` ${f.control}` : ''}: ${f.message}${f.fix ? `\n          try: ${f.fix}` : ''}`);
  return [...lines, `${counts.error} errors, ${counts.warning} warnings, ${counts.info} notes`].join('\n');
}
export function formatApply(result: ApplyResult, dance: Dance): string {
  const { keys, dancers, range, notes } = result.summary;
  return [`revision ${result.previousRevision} → ${result.revision}${result.replayed ? ' (already applied: same op id)' : ''}: ` +
    `${result.summary.ops} op${result.summary.ops === 1 ? '' : 's'}, keys +${keys.added} ~${keys.changed} -${keys.removed}` +
    (dancers.length ? `, dancers ${dancers.join(', ')}` : '') + (range ? `, ${formatTime(range[0], dance)}–${formatTime(range[1], dance)}` : ''),
  ...notes.map(n => `  ${n}`)].join('\n');
}
function revisionArg(v: string): number {
  if (!/^\d+$/.test(v)) throw Error(`--expect-revision takes a revision number, not "${v}"`);
  return Number(v);
}
async function readOps(values: Values, file: string | undefined): Promise<{ ops: unknown[]; expectRevision?: number; opId?: string; label?: string }> {
  const ops: unknown[] = [];
  let meta: { expectRevision?: number; opId?: string; label?: string } = {};
  if (file) {
    const text = file === '-' ? await new Promise<string>((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { data += c; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    }) : await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) ops.push(...parsed);
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ops?: unknown }).ops)) {
      const p = parsed as { ops: unknown[]; expectRevision?: number; opId?: string; label?: string };
      ops.push(...p.ops);
      meta = { expectRevision: p.expectRevision, opId: p.opId, label: p.label };
    } else ops.push(parsed);
  }
  for (const o of (values.op as string[] | undefined) ?? []) {
    const parsed: unknown = JSON.parse(o);
    if (Array.isArray(parsed)) ops.push(...parsed); else ops.push(parsed);
  }
  if (!ops.length) throw Error('No ops: pass a patch file, - for stdin, or --op \'{"op":…}\'');
  const expect = opt(values, 'expect-revision');
  return { ops, expectRevision: expect !== undefined ? revisionArg(expect) : meta.expectRevision, opId: opt(values, 'op-id') ?? meta.opId,
    label: opt(values, 'label') ?? meta.label };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command, dir, ...rest] = positionals;
  if (!command || command === 'help' || values.help) { print(USAGE); return 0; }
  if (!dir) throw Error(`Which project? dance ${command} <project folder>`);
  const json = values.json === true;
  if (command === 'init') {
    const project = await initProject(dir, {
      video: opt(values, 'video'), audio: opt(values, 'audio'), audioFromVideo: values['no-video-audio'] ? false : undefined,
      dancers: opt(values, 'dancers') ? Number(opt(values, 'dancers')) : undefined, title: opt(values, 'title'), artist: opt(values, 'artist'),
      link: values.link === true, proxy: values['no-proxy'] ? false : undefined,
      durationMs: opt(values, 'duration') ? parseTime(opt(values, 'duration')) : undefined,
      log: m => { if (!json) process.stderr.write(m + '\n'); },
    });
    const dance = await project.read();
    print(json ? { project: project.dir, dance } : `Created ${project.dir}\n${showDance(dance, project)}`);
    return 0;
  }
  const project = new DanceProject(dir);
  const dance = await project.read();
  const dancersArg = opt(values, 'dancer');
  const dancers = dancersArg ? dancersArg.split(',').map(d => findDancer(dance, d)) : dance.dancers;
  const range = opt(values, 'range') ? parseRange(opt(values, 'range'), dance) : null;
  // As given (a group can name an additive layer's channel); checked here.
  const controls = opt(values, 'controls') ? opt(values, 'controls')!.split(',').map(c => c.trim()) : null;
  if (controls) expandControls(controls);
  switch (command) {
    case 'show': print(json ? dance : showDance(dance, project)); return 0;
    case 'attach': {
      if (!opt(values, 'audio') && !opt(values, 'video')) throw Error('attach needs --audio and/or --video');
      const next = await attachSources(project, { audio: opt(values, 'audio'), video: opt(values, 'video'), link: values.link === true,
        proxy: values['no-proxy'] ? false : undefined, log: m => { if (!json) process.stderr.write(m + '\n'); } });
      print(json ? next : showDance(next, project));
      return 0;
    }
    case 'log': {
      const log = await project.log();
      print(json ? log : [`undo (latest last):`, ...log.undo.slice(-20).map(e => `  r${e.revision} ${e.label}`), `redo:`, ...log.redo.map(e => `  r${e.revision} ${e.label}`)].join('\n'));
      return 0;
    }
    case 'keys': {
      if (values.performance) {
        print(dancers.map(d => ({ dancer: d.id, timeOffsetMs: d.timeOffsetMs, clips: (d.performance ?? []).filter(c => !range || c.endMs >= range[0] && c.startMs <= range[1]) })));
        return 0;
      }
      const tables = dancers.map(d => keysTable(dance, d, opt(values, 'layer'), range, controls));
      print(json ? tables.map(t => t.json) : tables.map(t => t.text).join('\n'));
      return 0;
    }
    case 'pose': {
      const at = parseTime(need(values, 'at'), dance);
      if (values.performance) {
        print(dancers.map(d => ({ dancer: d.id, songTimeMs: at, performance: createPerformanceSampler(d.performance ?? [])(at - d.timeOffsetMs) })));
        return 0;
      }
      const report = poseReport(dance, dancers, at, values.landmarks === true);
      if (json) { print(report); return 0; }
      for (const r of report) {
        const points = r.points as Record<string, number[]>;
        print(`${r.dancer} at ${formatTime(at, dance)}  turn ${r.turn}° head yaw ${r.headYaw}° pitch ${r.headPitch}° roll ${r.headRoll}°` +
          `${(r.auto as string[]).length ? `  (automatic: ${(r.auto as string[]).join(', ')})` : ''}`);
        for (const [p, v] of Object.entries(points)) print(`  ${p.padEnd(14)} ${fmtPoint(v)}`);
        if (r.landmarks) for (const l of r.landmarks as { i: number; name: string; x: number; y: number; z: number }[]) print(`  ${String(l.i).padStart(2)} ${l.name.padEnd(17)} [${l.x}, ${l.y}, ${l.z}]`);
      }
      return 0;
    }
    case 'sample': {
      if (!range) throw Error('--range is required');
      const every = opt(values, 'every') ? parseTime(opt(values, 'every'), dance) : 100;
      if (!(every >= 1)) throw Error('--every must be at least 1 ms');
      const names = controls ? expandControls(controls) as string[] : ['leftWrist', 'rightWrist'];
      const rows: Record<string, unknown>[] = [];
      for (const d of dancers) {
        const e = createEvaluator(dance, d);
        for (let t = range[0]; t <= range[1] + 1e-6; t += every) {
          const rig = e.rig(t);
          rows.push({ dancer: d.id, t: fixed(t, 1), ...Object.fromEntries(names.map(n => [n, (POINTS as readonly string[]).includes(n)
            ? rig.points[n as keyof typeof rig.points].map(v => fixed(v)) : fixed(rig[n as 'turn'], 2)])) });
        }
      }
      print(json ? rows : rows.map(r => `${r.dancer} ${String(r.t).padStart(8)}  ${names.map(n => `${n} ${Array.isArray(r[n]) ? fmtPoint(r[n] as number[]) : r[n]}`).join('  ')}`).join('\n'));
      return 0;
    }
    case 'apply': {
      const request = await readOps(values, rest[0]);
      if (values['dry-run']) {
        const { applyOps } = await import('./ops.ts');
        const tracking = new Map<string, Awaited<ReturnType<DanceProject['tracking']>>>();
        for (const t of dance.sources.tracking) tracking.set(t.id, await project.tracking(t.id, dance));
        const { summary } = applyOps(dance, request.ops, { tracking: id => tracking.get(id) ?? (() => { throw Error(`No tracking ${id}`); })() });
        print(json ? summary : formatApply({ revision: dance.revision, previousRevision: dance.revision, summary, replayed: false }, dance) + '\n(dry run: nothing written)');
        return 0;
      }
      try {
        const result = await project.apply(request);
        print(json ? result : formatApply(result, await project.read()));
        return 0;
      } catch (e) {
        if (e instanceof RevisionConflict) { print(json ? { error: e.message, currentRevision: e.current } : e.message); return 3; }
        throw e;
      }
    }
    case 'undo': case 'redo': {
      const expect = opt(values, 'expect-revision');
      try {
        const result = await project.step(command, expect === undefined ? undefined : revisionArg(expect));
        print(json ? result : result ? `${command === 'undo' ? 'Undid' : 'Redid'} "${result.label}" → revision ${result.revision}` : `Nothing to ${command}`);
        return 0;
      } catch (e) {
        if (e instanceof RevisionConflict) { print(json ? { error: e.message, currentRevision: e.current } : e.message); return 3; }
        throw e;
      }
    }
    case 'check': {
      await project.loadTracking(dance);
      const tracking = new Map<string, Awaited<ReturnType<DanceProject['tracking']>>>();
      for (const t of dance.sources.tracking) tracking.set(t.id, await project.tracking(t.id, dance));
      const findings = checkDance(dance, { range: range ?? undefined, tracking: id => tracking.get(id) ?? null })
        .filter(f => !dancersArg || dancers.some(d => d.id === f.dancer));
      print(json ? findings : formatFindings(findings, dance));
      return findings.some(f => f.severity === 'error') ? 1 : 0;
    }
    case 'compare': {
      const tracking = new Map<string, Awaited<ReturnType<DanceProject['tracking']>>>();
      for (const t of dance.sources.tracking) tracking.set(t.id, await project.tracking(t.id, dance));
      const windowMs = opt(values, 'every') ? parseTime(opt(values, 'every'), dance) : 500;
      if (!(windowMs >= 50)) throw Error('--every must be at least 50 ms');
      const result = compareToTracking(dance, id => tracking.get(id) ?? null, { range: range ?? undefined, windowMs })
        .filter(c => !dancersArg || dancers.some(d => d.id === c.dancer));
      if (!result.length) throw Error('No tracking follows these dancers; run `dance track` first');
      if (json) { print(result); return 0; }
      const short: Record<string, string> = { 'left-upper-arm': 'L up', 'left-forearm': 'L fore', 'right-upper-arm': 'R up', 'right-forearm': 'R fore',
        'left-thigh': 'L thigh', 'left-shin': 'L shin', 'right-thigh': 'R thigh', 'right-shin': 'R shin', torso: 'torso', shoulders: 'shldrs' };
      for (const c of result) {
        const ids = Object.keys(c.limbs);
        print(`${c.dancer}: degrees between the dance's limbs and the tracked video's (mean per window; 15° is a close match, 30° a clear miss)`);
        print(`${'window'.padEnd(18)} ${'mean'.padStart(5)}  ${ids.map(i => short[i].padStart(7)).join('')}`);
        for (const w of c.windows) print(`${`${formatTime(w.startMs)}`.padEnd(18)} ${String(w.mean).padStart(5)}  ${ids.map(i => String(w.limbs[i] ?? '-').padStart(7)).join('')}`);
        print(`${'all'.padEnd(18)} ${''.padStart(5)}  ${ids.map(i => String(c.limbs[i] ?? '-').padStart(7)).join('')}`);
      }
      return 0;
    }
    case 'score': {
      const tracking = new Map<string, Awaited<ReturnType<DanceProject['tracking']>>>();
      for (const t of dance.sources.tracking) tracking.set(t.id, await project.tracking(t.id, dance));
      const scores = scoreAgainstTracking(dance, id => tracking.get(id)!);
      if (json) { print(scores); return 0; }
      for (const s of scores) {
        const r = s.result;
        print(`${s.dancer}: ${r.score.toLocaleString('en-US')} / ${r.maxScore.toLocaleString('en-US')}, accuracy ${(r.accuracy * 100).toFixed(1)}%, grade ${r.grade}, ` +
          `timing ${r.meanOffsetMs.toFixed(0)} ms, tracked ${(r.coverage * 100).toFixed(0)}%  ` +
          `(perfect ${r.judgements.perfect}, good ${r.judgements.good}, ok ${r.judgements.ok}, miss ${r.judgements.miss}, lost ${r.judgements.lost})`);
        const weak = s.seconds.filter(x => x.judgement === 'miss' || x.judgement === 'ok' || x.judgement === 'lost');
        if (weak.length) print(`  weakest seconds: ${weak.sort((a, b) => a.score - b.score).slice(0, 8).map(x => `${formatTime(x.songTimeMs - 1000)}–${formatTime(x.songTimeMs)} ${x.judgement} ${x.score}`).join(', ')}`);
      }
      return 0;
    }
    case 'export': {
      const { songBundle, bundleZip, installBundle } = await import('./bundle.ts');
      const bundle = await songBundle(project, dance);
      const out = opt(values, 'out') ?? path.join(project.meta('exports'), `${bundle.songId}-r${bundle.song.bundleRevision}.aerodance-song.zip`);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, bundleZip(bundle));
      const lines = [`Song ${bundle.songId} (revision ${bundle.song.bundleRevision}): ${bundle.compiled.stats.frames} frames from ${bundle.compiled.stats.candidates} samples`, `ZIP ${out}`];
      const folder = opt(values, 'folder');
      if (folder) lines.push(`Folder ${await installBundle(bundle, path.resolve(folder))}`);
      if (values.install) lines.push(`Installed ${await installBundle(bundle, undefined, project)} (open Song Select to see it; don't commit it)`);
      print(json ? { songId: bundle.songId, revision: bundle.song.bundleRevision, zip: out, stats: bundle.compiled.stats, entry: bundle.entry } : lines.join('\n'));
      return 0;
    }
    case 'compile': {
      const compiled = compileDance(dance);
      print(json ? compiled.stats : `${compiled.stats.frames} frames from ${compiled.stats.candidates} samples`);
      return 0;
    }
    case 'frames': case 'render': case 'track': case 'studio': {
      const { runBrowserCommand } = await import('./server.ts');
      return runBrowserCommand(command, project, dance, values as Values, json);
    }
    default: throw Error(`Unknown command "${command}"; see \`dance help\``);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tools/dance/cli.ts')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (e: unknown) => {
    process.stderr.write(`dance: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
export { USAGE, SCALARS };
