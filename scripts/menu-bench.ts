// Profiles the bundled production game through the tvOS host's report/logUrl/drive hooks.
// Build separately: node scripts/tvos.ts build --game [--sim]. Do not use --release: local
// reporting needs the development build's local network permission. No debugger is attached.
// Saved native sound/graphics preferences are kept; each summary records the stats overlay.
// Simulator FPS is software rendering, not Apple TV performance. --profile and --gpu-timing
// add overhead; compare runs with the same flags, saved preferences and physical device.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { STAGE_LIST } from '../packages/stages/catalog.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const USAGE = `Usage: node scripts/menu-bench.ts (--device UDID | --sim UDID) --label NAME [options]

  --out DIR          results directory (default .cache/menu-bench/NAME); use a fresh directory
  --app PATH         existing aerodance.app (default apps/tvos/build/Build/Products/
                     Release-appletvos/aerodance.app, or Release-appletvsimulator for --sim)
  --seconds N        seconds measured per screen (default 16, minimum 6)
  --warmup N         seconds to settle before each measurement (default 6, may be 0)
  --host HOST        Mac address reachable from the TV (default first LAN IPv4 on en*;
                     127.0.0.1 for a simulator); hostname/IP only, without scheme or port
  --port N           report/log receiver port (default 4897)
  --profile          enable WebGL/2D method profiling (adds overhead)
  --gpu-timing       glFinish every frame (adds overhead; replay execMs is still not GPU time)
  --scenes           also play every dance stage (build with --game --bench-scenes first)
  --stages IDS       measure only these stages, comma separated, in catalog order
  --players N        players in stage runs (1–4, default 2); menu samples stay 2/4
  --file-report      pull reports over the paired device connection instead of the LAN

Measures main-idle, main-focused, players2, players4, settings and song-list. Installs and
relaunches the app without --console, then terminates that process on exit. The requested
simulator is booted if necessary and left running. TVOS_BUNDLE_ID, if set, must match the app.
Build first with node scripts/tvos.ts build --game [--sim]; --release lacks local reporting.
Keep the TV and Mac on the same LAN and allow the app's local network access.
Writes reports.ndjson, logs.ndjson, run.json and summary.json, plus launch.json on a device.
The first report in each mark is discarded; p95 values are maxima of native two-second
window p95s, not pooled percentiles. Simulator results are not hardware performance.`;

type ObjectValue = Record<string, unknown>;
type Report = ObjectValue & { type: string };
type State = Record<string, string>;
type Step = ['wait', State, number] | ['key', string] | ['sleep', number] | ['report', string];
type Options = {
  kind: 'device' | 'sim'; udid: string; label: string; out: string; app: string;
  seconds: number; warmup: number; host: string; port: number; profile: boolean; gpuTiming: boolean; scenes: boolean; fileReport: boolean; stages: string[]; players: number;
};
type Scenario = { mark: string; expected: State };

const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const processId = (value: unknown) => {
  const n = number(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
const mean = (value: unknown) => number(value) ?? number(object(value).mean);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const round = (value: number | null) => value === null ? null : Math.round(value * 1000) / 1000;

function options(args: string[]): Options | null {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return null; }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const names = ['--device', '--sim', '--label', '--out', '--app', '--seconds', '--warmup', '--host', '--port', '--stages', '--players'];
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (values.has(name) || flags.has(name)) throw Error(`Duplicate option ${name}`);
    if (['--profile', '--gpu-timing', '--scenes', '--file-report'].includes(name)) { flags.add(name); continue; }
    if (!names.includes(name)) throw Error(`Unknown option ${name}; use --help`);
    const value = args[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) throw Error(`${name} needs a value`);
    values.set(name, value);
  }
  if (values.has('--device') === values.has('--sim')) throw Error('Choose exactly one of --device UDID or --sim UDID');
  const kind = values.has('--device') ? 'device' : 'sim';
  if (flags.has('--file-report') && kind !== 'device') throw Error('--file-report requires --device');
  const udid = values.get(`--${kind}`)!;
  if (!/^[\da-f][\da-f-]{7,63}$/i.test(udid)) throw Error(`--${kind} needs a UDID, not a device name`);
  const label = values.get('--label') ?? '';
  if (!/^[a-z\d][a-z\d._-]{0,79}$/i.test(label) || label.includes('..')) {
    throw Error('--label is required: 1–80 letters/digits, dots, underscores or hyphens; start with a letter/digit and omit ".."');
  }
  const numeric = (name: string, fallback: number, min: number, max: number, integer = false) => {
    const raw = values.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (raw?.trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
    }
    return value;
  };
  const seconds = numeric('--seconds', 16, 6, 3600);
  const warmup = numeric('--warmup', 6, 0, 3600);
  const players = numeric('--players', 2, 1, 4, true);
  const stages = values.get('--stages')?.split(',') ?? [];
  if (values.has('--stages') && (!stages.length || new Set(stages).size !== stages.length || stages.some((id) => !STAGE_LIST.some((s) => s.id === id)))) throw Error('--stages must name distinct stage IDs');
  const port = numeric('--port', 4897, 1, 65535, true);
  const lan = () => Object.entries(os.networkInterfaces()).filter(([name]) => name.startsWith('en'))
    .flatMap(([, addresses]) => addresses ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address;
  const host = values.get('--host') ?? (kind === 'sim' || flags.has('--file-report') ? '127.0.0.1' : lan());
  if (!host) throw Error('No LAN IPv4 address on an en* interface; pass --host with this Mac\'s address reachable from the TV');
  if (!isIP(host) && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host)) {
    throw Error('--host must be a hostname or IP address, without a scheme, path or port');
  }
  if (host === '0.0.0.0' || host === '::') throw Error('--host must be a reachable address, not a wildcard address');
  // Also reject malformed numeric IPs which otherwise resemble a DNS name.
  new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`);
  const app = path.resolve(values.get('--app') ?? path.join(root,
    `apps/tvos/build/Build/Products/Release-${kind === 'sim' ? 'appletvsimulator' : 'appletvos'}/aerodance.app`));
  if (!app.endsWith('.app') || !existsSync(app) || !statSync(app).isDirectory()) {
    throw Error(`App bundle not found: ${app}\nBuild first: node scripts/tvos.ts build --game${kind === 'sim' ? ' --sim' : ''}`);
  }
  for (const file of ['Info.plist', 'www/game.js', 'www/runtime.js', 'www/config.json']) {
    if (!existsSync(path.join(app, file)) || !statSync(path.join(app, file)).isFile()) throw Error(`App is missing ${file}; build the game first`);
  }
  return { kind, udid, label, out: path.resolve(values.get('--out') ?? path.join(root, '.cache/menu-bench', label)),
    app, seconds, warmup, host, port, profile: flags.has('--profile'), gpuTiming: flags.has('--gpu-timing'), scenes: flags.has('--scenes') || stages.length > 0, fileReport: flags.has('--file-report'), stages, players };
}

/** The order in MainMenu.WIDGETS is also the arrow-key navigation graph (useCanvasUI). */
function flow(o: Options) {
  const timeout = o.kind === 'sim' ? 900_000 : 120_000;
  const main = { menuScreen: 'main', menuReady: 'true', songReady: 'false' };
  const players = (n: number) => ({ menuScreen: 'players', menuReady: 'true', menuPlayers: String(n), songReady: 'false' });
  const settings = { menuScreen: 'settings', menuReady: 'true', songReady: 'false' };
  const songs = { songScreen: 'list', songReady: 'true', catalog: 'ready', menuReady: 'false' };
  const steps: Step[] = [['report', '']];
  const scenarios: Scenario[] = [];
  const wait = (state: State) => steps.push(['wait', state, timeout]);
  const key = (value: string) => { steps.push(['key', value], ['sleep', 300]); };
  const measure = (mark: string, expected: State) => {
    if (o.stages.length && !STAGE_LIST.some(({ id }) => mark.startsWith(`${id}-`))) { wait(expected); return; }
    scenarios.push({ mark, expected });
    wait(expected);
    steps.push(['sleep', o.warmup * 1000]);
    wait(expected);
    steps.push(['report', mark], ['sleep', o.seconds * 1000], ['report', '']);
  };
  measure('main-idle', main); // No key input: no focus ring.
  key('ArrowDown'); // With no cursor, the first arrow focuses the primary (Start).
  measure('main-focused', main);
  key('Enter'); // Start resets the dial to 2; players opens focused on Let's dance.
  measure('players2', players(2));
  key('ArrowUp'); // [back, minus, plus, go]: go -> plus.
  key('Enter'); wait(players(3));
  key('Enter'); wait(players(4));
  key('ArrowDown'); // plus -> go: same focus as the two-player sample.
  measure('players4', players(4));
  key('Escape'); wait(main); // Restores focus to Start.
  key('ArrowDown'); key('Enter');
  measure('settings', settings); // No settings controls are activated.
  key('Escape'); wait(main); // Restores focus to Settings, not Start.
  key('ArrowUp'); key('Enter'); wait(players(2));
  if (o.scenes && o.players !== 2) {
    key('ArrowUp'); // go -> plus
    if (o.players === 1) { key('ArrowUp'); key('Enter'); key('ArrowDown'); }
    else for (let n = 2; n < o.players; n++) { key('Enter'); wait(players(n + 1)); }
    key('ArrowDown'); // plus -> go
    wait(players(o.players));
  }
  key('Enter');
  measure('song-list', songs);
  if (o.scenes) {
    let selected = 0;
    for (const [i, { id: stage }] of STAGE_LIST.entries()) {
      if (o.stages.length && !o.stages.includes(stage)) continue;
      key('ArrowDown'); // The hidden list dropped its cursor; focus the chosen primary row.
      for (let j = selected; j < i; j++) {
        key('ArrowDown');
        if (j === 3) { key('Enter'); wait(songs); } // next page, focused on its first song
      }
      key('Enter');
      const preview = { songScreen: 'preview', songReady: 'true', stage, stageReady: 'true' };
      measure(`${stage}-preview`, preview);
      key('Enter'); // Dance is the preview's primary button.
      measure(`${stage}-playing`, { stage, stageReady: 'true', gamePhase: 'playing' });
      wait({ stage, gamePhase: 'results' });
      measure(`${stage}-results`, { stage, stageReady: 'true', gamePhase: 'results' });
      key('Escape'); wait(songs);
      // Reopening Song Select resets pagination. A chosen song off page zero
      // can't be its primary row, so navigation starts again at the first song.
      selected = i < 4 ? i : 0;
    }
  }
  steps.push(['sleep', 1500]); // Let the host flush its final log batch before "done".
  return { steps, scenarios, timeout };
}

// Raw reports remain open-ended: host versions may add numeric stats or nested host samples.
// In particular, don't coerce null/missing values to zero or assume all stats are objects.
function metric(report: Report, key: string) { return report[key] ?? object(report.host)[key]; }
function weighted(reports: Report[], value: (r: Report) => number | null, intervals = false) {
  let sum = 0, count = 0;
  for (const report of reports) {
    const v = value(report), frames = number(metric(report, 'frames')) ?? 0;
    const weight = Math.max(0, frames - (intervals ? 1 : 0));
    if (v === null || v < 0 || !weight) continue;
    sum += v * weight; count += weight;
  }
  return count ? sum / count : null;
}
function maxWindow(reports: Report[], ...keys: string[]) {
  const values = reports.map((r) => keys.map((key) => number(object(metric(r, key)).p95)).find((v) => v !== null) ?? null)
    .filter((v): v is number => v !== null && v >= 0);
  return values.length ? Math.max(...values) : null;
}
function summarize(reports: Report[], scenarios: Scenario[]) {
  return scenarios.map(({ mark, expected }) => {
    const marked = reports.filter((r) => r.type === 'game' && r.mark === mark)
      .sort((a, b) => (number(a.t) ?? 0) - (number(b.t) ?? 0));
    // The mark changes between reports. Its first window includes pre-mark frames and must
    // be dropped BEFORE filtering state. Clear marks before transitions to exclude the end.
    const rest = marked.slice(1);
    const matching = rest.filter((r) => Object.entries(expected).every(([k, v]) => object(r.dataset)[k] === v));
    const kept = matching.filter((r) => {
      const frames = number(metric(r, 'frames'));
      return frames !== null && Number.isInteger(frames) && frames > 0;
    });
    // Current report.ts forwards FPS derived from native intervalMs.mean (rounded to 0.1),
    // rather than intervalMs itself. Prefer the original interval if a host supplies it.
    const interval = weighted(kept, (r) => {
      const native = mean(metric(r, 'intervalMs'));
      const fps = number(r.fps);
      return native !== null && native > 0 ? native : fps !== null && fps > 0 ? 1000 / fps : null;
    }, true);
    const statsModes = [...new Set(kept.map((r) => object(r.dataset).statsMode ?? 'off'))];
    return {
      mark, expectedState: expected, reports: marked.length, droppedBoundaryReports: Math.min(1, marked.length),
      droppedStateReports: rest.length - matching.length, droppedInvalidFrameReports: matching.length - kept.length,
      windows: kept.length, frames: kept.reduce((n, r) => n + (number(metric(r, 'frames')) ?? 0), 0),
      statsMode: statsModes.length === 1 ? statsModes[0] : statsModes,
      fps: round(interval !== null && interval > 0 ? 1000 / interval : null),
      meanNativeIntervalMs: round(interval),
      meanJsMs: round(weighted(kept, (r) => mean(metric(r, 'jsMs')))),
      meanRenderReplayExecMs: round(weighted(kept, (r) => mean(metric(r, 'execMs')))),
      meanDrawsPerFrame: round(weighted(kept, (r) => mean(metric(r, 'drawsPerFrame')))),
      meanTextureUploadsPerFrame: round(weighted(kept, (r) => number(object(r.perFrame).textureUploads))),
      maxWindowJsP95Ms: round(maxWindow(kept, 'jsMs')),
      maxWindowFrameIntervalP95Ms: round(maxWindow(kept, 'intervalMs', 'frameMs')),
      meanGpuFinishMs: round(weighted(kept, (r) => mean(metric(r, 'gpuFinishMs')))),
    };
  });
}

async function benchmark(o: Options) {
  const abort = new AbortController();
  const reports: Report[] = [];
  const files: number[] = [];
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const { steps, scenarios, timeout } = flow(o);
  let failure: Error | undefined;
  let done = false;
  let lastReportAt: number;
  let bundleId = '', appPid: number | undefined;
  let reportFile: number | undefined, logFile: number | undefined;
  let receiver: http.Server | undefined;
  let signalExitCode: number | undefined;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : Error(String(error));
    abort.abort(failure);
  };
  const interrupted = (signal: NodeJS.Signals) => {
    signalExitCode = signal === 'SIGINT' ? 130 : 143;
    fail(Error(`Interrupted by ${signal}`));
  };
  const onInt = () => interrupted('SIGINT'), onTerm = () => interrupted('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const log = (text: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${text}`);
  const receiveReport = (line: string) => {
    const r = object(JSON.parse(line));
    if (typeof r.type !== 'string' || r.label !== o.label) throw Error('Invalid report type or mismatched label');
    const report = r as Report;
    appendFileSync(reportFile!, `${JSON.stringify(report)}\n`);
    reports.push(report); lastReportAt = Date.now();
    if (report.type === 'error') fail(Error(`App report: ${String(report.message ?? 'unknown error')}`));
    if (report.type === 'done') { done = true; log('drive finished'); }
    if (report.type === 'game') {
      const d = object(report.dataset);
      log(`${String(report.mark || '(settling)')} · ${String(report.fps ?? '?')} fps · menu=${String(d.menuScreen ?? '?')} stage=${String(d.stage ?? '?')} phase=${String(d.gamePhase ?? '?')}`);
    }
  };

  /** All native commands have deadlines; no shell, console attachment or debugger. */
  const command = (args: string[], timeoutMs = 120_000, ignoreAbort = false, executable = 'xcrun'): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs, killSignal: 'SIGKILL', ...(ignoreAbort ? {} : { signal: abort.signal }) });
      let stdout = '', stderr = '';
      let commandError: Error | undefined;
      child.stdout.on('data', (data: Buffer) => { stdout = (stdout + data.toString()).slice(-1024 * 1024); });
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-1024 * 1024); });
      // Await close even after abort so a launch PID printed just before an error is retained.
      child.on('error', (error) => { commandError = error; });
      child.on('close', (code, signal) => {
        if (!commandError && code === 0) resolve(stdout);
        else reject(Object.assign(commandError ?? Error(`${executable} ${args.slice(0, 4).join(' ')} failed (${signal ?? `exit ${code}`}):\n${stderr || stdout}`), { stdout, stderr }));
      });
    });

  try {
    // Reject occupied output files instead of silently overwriting another run's evidence.
    for (const file of ['reports.ndjson', 'logs.ndjson', 'run.json', 'summary.json', 'launch.json']) {
      if (existsSync(path.join(o.out, file))) throw Error(`${path.join(o.out, file)} already exists; choose a fresh --label or --out`);
    }
    mkdirSync(o.out, { recursive: true });
    reportFile = openSync(path.join(o.out, 'reports.ndjson'), 'wx'); files.push(reportFile);
    logFile = openSync(path.join(o.out, 'logs.ndjson'), 'wx'); files.push(logFile);
    receiver = http.createServer((req, res) => {
      if (req.method !== 'POST' || !['/__report', '/__log'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.on('error', (error) => { fail(error); res.destroy(); });
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail(Error('Report/log POST exceeded 1 MiB')); res.writeHead(413).end(); req.destroy(); }
        else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          if (req.url === '/__log') {
            for (const line of body.split(/\r?\n/).filter(Boolean)) {
              appendFileSync(logFile!, `${JSON.stringify({ receivedAt: new Date().toISOString(), line })}\n`);
              if (/^(?:\d+(?:\.\d+)?\s+)?error:/.test(line) || line.includes('drive: timed out')) fail(Error(`App log: ${line}`));
            }
          } else {
            // The host posts one JSON object per request; also accept newline-delimited batches.
            for (const line of body.split(/\r?\n/).filter((line) => line.trim())) {
              receiveReport(line);
            }
          }
          res.writeHead(204).end();
        } catch (error) { fail(Error(`Receiver: ${message(error)}`)); res.writeHead(400).end(); }
      });
    });
    if (o.fileReport) receiver = undefined;
    else {
      receiver.requestTimeout = 15_000;
      receiver.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        const server = receiver!;
        server.once('error', reject);
        server.listen(o.port, o.kind === 'device' || o.host !== '127.0.0.1' ? '::' : '127.0.0.1', () => {
          server.off('error', reject); server.on('error', fail); resolve();
        });
      });
    }
    const here = `http://${isIP(o.host) === 6 ? `[${o.host}]` : o.host}:${o.port}`;
    log(`${o.fileReport ? 'paired file reports' : `receiver ${here}`}; output ${o.out}`);

    const info = object(JSON.parse(await command(['-convert', 'json', '-o', '-', path.join(o.app, 'Info.plist')], 10_000, false, 'plutil')));
    if (typeof info.CFBundleIdentifier !== 'string' || !/^[a-z\d.-]+$/i.test(info.CFBundleIdentifier)) throw Error('App has no valid CFBundleIdentifier');
    bundleId = info.CFBundleIdentifier;
    if (process.env.TVOS_BUNDLE_ID && process.env.TVOS_BUNDLE_ID !== bundleId) throw Error('TVOS_BUNDLE_ID does not match the app\'s CFBundleIdentifier');
    if (!o.fileReport && (!object(info.NSAppTransportSecurity).NSAllowsLocalNetworking || !info.NSLocalNetworkUsageDescription)) {
      throw Error('App lacks local network reporting permission; build with --game without --release');
    }
    const bundled = object(JSON.parse(readFileSync(path.join(o.app, 'www/config.json'), 'utf8')));
    if (o.scenes) {
      const catalog = object(JSON.parse(readFileSync(path.join(o.app, 'www/songs/manifest.json'), 'utf8')));
      const entries = Array.isArray(catalog.songs) ? catalog.songs.map(object) : [];
      for (const [i, { id }] of STAGE_LIST.entries()) {
        if (entries[i]?.id !== `bench-${i}-${id}`) throw Error('--scenes needs an app built with --game --bench-scenes');
      }
      if (o.seconds + o.warmup > 24) throw Error('--scenes needs --seconds + --warmup <= 24 to measure within the 30-second song');
    }
    const config = { script: 'game.js', url: `http://aerodance.local/${o.scenes ? '?input=ghost' : ''}`,
      ...(typeof bundled.site === 'string' ? { site: bundled.site } : {}), fit: 'fill', pixelated: true,
      label: o.label, report: o.fileReport ? 'file' : `${here}/__report`, ...(o.fileReport ? {} : { logUrl: `${here}/__log` }), drive: steps,
      profile: o.profile, gpuTiming: o.gpuTiming };
    writeFileSync(path.join(o.out, 'run.json'), JSON.stringify({ startedAt, ...o, bundleId, config }, null, 2) + '\n', { flag: 'wx' });

    if (o.kind === 'sim') {
      const list = object(JSON.parse(await command(['simctl', 'list', 'devices', 'available', '--json'])));
      const tvs = Object.entries(object(list.devices)).filter(([runtime]) => runtime.includes('tvOS'))
        .flatMap(([, devices]) => Array.isArray(devices) ? devices.map(object) : []);
      const sim = tvs.find((device) => String(device.udid).toLowerCase() === o.udid.toLowerCase());
      if (!sim) throw Error(`No available tvOS simulator with UDID ${o.udid}`);
      if (sim.state !== 'Booted') await command(['simctl', 'boot', o.udid]);
      await command(['simctl', 'bootstatus', o.udid, '-b'], 180_000);
      await command(['simctl', 'install', o.udid, o.app], 180_000);
      // Let the short-lived launcher finish even on Ctrl-C so cleanup can identify its app.
      abort.signal.throwIfAborted();
      let output: string;
      try {
        output = await command(['simctl', 'launch', '--terminate-running-process', o.udid, bundleId, '--config', JSON.stringify(config)], 60_000, true);
      } catch (error) {
        appPid = processId(Number(/:\s*(\d+)\s*$/m.exec(String(object(error).stdout ?? ''))?.[1]));
        throw error;
      }
      appPid = processId(Number(/:\s*(\d+)\s*$/m.exec(output)?.[1]));
      if (!appPid) throw Error(`simctl did not return the launched app PID: ${output}`);
    } else {
      await command(['devicectl', 'device', 'install', 'app', '--device', o.udid, '--quiet', o.app], 180_000);
      const launchFile = path.join(o.out, 'launch.json');
      // Capture the real app PID: devicectl exits after launching when --console is absent.
      abort.signal.throwIfAborted();
      try {
        await command(['devicectl', 'device', 'process', 'launch', '--device', o.udid, '--terminate-existing',
          '--quiet', '--json-output', launchFile, bundleId, '--config', JSON.stringify(config)], 60_000, true);
      } finally {
        if (existsSync(launchFile)) {
          const result = object(object(JSON.parse(readFileSync(launchFile, 'utf8'))).result);
          appPid = processId(object(result.process).processIdentifier) ?? processId(result.processIdentifier);
        }
      }
      if (!appPid) throw Error('devicectl did not return the launched app PID; inspect launch.json');
    }
    log(`launched ${bundleId}, PID ${appPid}; no console/debugger attached`);
    lastReportAt = Date.now();
    let readLines = 0, pullAt = Date.now() + 4000;
    const deadline = Date.now() + steps.reduce((ms, step) => ms + (step[0] === 'wait' ? step[2] : step[0] === 'sleep' ? step[1] : 0), 0) + 30_000;
    while (!done) {
      if (o.fileReport && Date.now() >= pullAt) {
        const pulled = path.join(o.out, 'device-reports.ndjson');
        if (o.kind !== 'device') throw Error('--file-report currently requires --device');
        for (let attempt = 0; ; attempt++) {
          try {
            await command(['devicectl', 'device', 'copy', 'from', '--device', o.udid, '--domain-type', 'appDataContainer',
              '--domain-identifier', bundleId, '--source', 'Library/Caches/aerodance-bench.ndjson', '--destination', pulled, '--quiet', '--timeout', '20'], 25_000);
            break;
          } catch (error) {
            if (attempt >= 2 || abort.signal.aborted) throw error;
            log(`report transfer failed; retrying (${attempt + 1}/2): ${message(error).split('\n')[0]}`);
            await sleep(1000, undefined, { signal: abort.signal });
          }
        }
        const lines = readFileSync(pulled, 'utf8').split('\n');
        lines.pop(); // A concurrent append may leave an incomplete final line.
        for (const line of lines.slice(readLines)) receiveReport(line);
        readLines = lines.length;
        pullAt = Date.now() + 4000;
      }
      if (Date.now() - lastReportAt > timeout) throw Error(`No app reports for ${timeout / 1000}s; check --host, LAN access and the app's local network permission`);
      if (Date.now() > deadline) throw Error('Timed out waiting for drive completion');
      await sleep(200, undefined, { signal: abort.signal });
    }
    await sleep(1000, undefined, { signal: abort.signal }); // Drain requests already in flight.
    const summaries = summarize(reports, scenarios);
    for (const summary of summaries) {
      if (!summary.windows || [summary.fps, summary.meanJsMs, summary.meanRenderReplayExecMs,
        summary.meanDrawsPerFrame, summary.meanTextureUploadsPerFrame].some((v) => v === null)) {
        throw Error(`No complete usable measurement for ${summary.mark}; inspect raw reports and increase --seconds if needed`);
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    // Kill only the launched process, never the simulator or an unrelated app by bundle ID.
    if (appPid) {
      try {
        if (o.kind === 'device') await command(['devicectl', 'device', 'process', 'terminate', '--device', o.udid, '--pid', String(appPid), '--quiet'], 30_000, true);
        else process.kill(appPid, 'SIGTERM'); // Simulator application PIDs belong to this Mac.
        log(`terminated benchmark app PID ${appPid}`);
      } catch (error) {
        // An app that already exited needs no termination. Other cleanup failures are visible.
        if (object(error).code !== 'ESRCH') fail(Error(`Could not terminate benchmark app PID ${appPid}: ${message(error)}`));
      }
    }
    if (receiver) {
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver!.close(() => resolve()));
    }
    if (reportFile !== undefined && logFile !== undefined) {
      try {
        const summary = { label: o.label, target: { kind: o.kind, udid: o.udid }, app: o.app, bundleId,
          appPid, startedAt, finishedAt: new Date().toISOString(), status: failure ? 'failed' : 'complete',
          ...(failure ? { error: failure.message } : {}), seconds: o.seconds, warmup: o.warmup,
          profile: o.profile, gpuTiming: o.gpuTiming, scenes: o.scenes, done, reportCount: reports.length,
          modes: [...new Set(reports.filter((r) => r.type === 'start').map((r) => r.mode))],
          methodology: {
            windowMs: 2000, boundaries: 'Drop first report in each mark before filtering expected state; clear mark before transitions.',
            means: 'Frame-weighted native window means. Draw/upload counters are already rounded by the host.',
            fps: '1000 / weighted native interval mean, weighted by frames - 1. If intervalMs is absent, invert host FPS (rounded to 0.1).',
            renderReplay: 'execMs measures CPU execution of rendering commands, not GPU duration.',
            p95: 'maxWindow*P95Ms is the maximum two-second-window p95, NOT a pooled p95.',
            statsMode: 'Saved preference preserved. Missing dataset.statsMode means overlay off.',
            gpu: 'gpuFinishMs is null unless the host forwards it; --gpu-timing still enables glFinish and changes performance.',
          }, scenarios: summarize(reports, scenarios) };
        writeFileSync(path.join(o.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
        console.table(summary.scenarios.map((s) => ({ mark: s.mark, windows: s.windows, statsMode: s.statsMode,
          fps: s.fps, jsMs: s.meanJsMs, renderReplayMs: s.meanRenderReplayExecMs, draws: s.meanDrawsPerFrame,
          textureUploads: s.meanTextureUploadsPerFrame, maxWindowJsP95Ms: s.maxWindowJsP95Ms,
          maxWindowIntervalP95Ms: s.maxWindowFrameIntervalP95Ms })));
        log(`${summary.status}: ${path.join(o.out, 'summary.json')}`);
      } catch (error) { fail(error); }
    }
    for (const file of files) closeSync(file);
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
  if (failure) { process.exitCode = signalExitCode ?? 1; throw failure; }
}

try {
  const o = options(process.argv.slice(2));
  if (o) await benchmark(o);
} catch (error) {
  console.error(`menu-bench: ${message(error)}`);
  process.exitCode ||= 1;
}
