// Builds the production game into the Apple TV app in client-tvos/ and installs it on a paired
// Apple TV. See client-tvos/README.md.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const appDir = path.join(root, 'client-tvos');
const TEAM_ID = process.env.TVOS_TEAM_ID || 'PX72AL9366';
const BUNDLE_ID = process.env.TVOS_BUNDLE_ID || 'com.isaacthoman.aerodance.tv';
const REPORT_PORT = 8765;

const USAGE = `Usage: node scripts/tvos.ts <command> [options]

  devices                          list the Apple TVs paired with this Mac
  deploy [options] [--skip-web-build]
                                   build the game and the app, install it and launch it
  launch [options]                 relaunch the installed app
  bench                            build the Aero world benchmark (client-tvos/bench/) into
                                   client-tvos/bench/dist/; deploy ships it at /bench/

Options:
  --device <name>                  the Apple TV to use (needed when more than one is paired)
  --path <path>                    the page to open (default /?input=ghost)
  --report                         print the app's frame rate, JavaScript time per frame and
                                   draw calls every two seconds, until Ctrl-C

Signing uses TVOS_TEAM_ID (default ${TEAM_ID}) and TVOS_BUNDLE_ID (default ${BUNDLE_ID}).`;

type AppleTV = { name: string; udid: string; pairing: string; osVersion: string };
type DeviceList = {
  result: {
    devices: {
      deviceProperties: { name?: string; osVersionNumber?: string };
      hardwareProperties: { platform?: string; reality?: string; udid?: string };
      connectionProperties: { pairingState?: string };
    }[];
  };
};

function run(command: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} ${args[0]} failed (exit ${result.status})`);
}

function appleTVs(): AppleTV[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aerodance-tvos-'));
  const file = path.join(dir, 'devices.json');
  try {
    const result = spawnSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', file, '--quiet'], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(`devicectl list devices failed:\n${result.stderr}`);
    const list = JSON.parse(readFileSync(file, 'utf8')) as DeviceList;
    return list.result.devices
      .filter((d) => d.hardwareProperties.platform === 'tvOS' && d.hardwareProperties.reality === 'physical' && d.hardwareProperties.udid)
      .map((d) => ({
        name: d.deviceProperties.name ?? '(unnamed)',
        udid: d.hardwareProperties.udid ?? '',
        pairing: d.connectionProperties.pairingState ?? 'unknown',
        osVersion: d.deviceProperties.osVersionNumber ?? '?',
      }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pickDevice(name: string | undefined): AppleTV {
  const tvs = appleTVs().filter((tv) => tv.pairing === 'paired');
  const named = name === undefined ? tvs : tvs.filter((tv) => tv.name === name || tv.udid === name);
  if (named.length === 1) return named[0];
  const list = tvs.map((tv) => `  ${tv.name}`).join('\n') || '  (none; pair one first, see client-tvos/README.md)';
  throw Error(name === undefined && tvs.length > 1
    ? `More than one Apple TV is paired; choose one with --device:\n${list}`
    : `No paired Apple TV${name === undefined ? '' : ` called "${name}"`}. Paired Apple TVs:\n${list}`);
}

// The Mac's address on the local network, which the Apple TV sends --report diagnostics to.
function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  throw Error('This Mac has no local network address for the Apple TV to report to');
}

function buildApp(tv: AppleTV, skipWebBuild: boolean) {
  if (!skipWebBuild) run('npm', ['run', 'build']);
  if (!existsSync(path.join(root, 'dist/index.html'))) throw Error('No production build in dist/; run without --skip-web-build');
  const www = path.join(appDir, 'www');
  rmSync(www, { recursive: true, force: true });
  // The Apple TV has no camera, so the pose-tracking models (most of dist/) stay behind.
  cpSync(path.join(root, 'dist'), www, { recursive: true, filter: (src) => !src.startsWith(path.join(root, 'dist/pose-assets')) });
  const bench = path.join(appDir, 'bench/dist');
  if (existsSync(bench)) cpSync(bench, path.join(www, 'bench'), { recursive: true });
  if (spawnSync('xcodegen', ['--version']).error) throw Error('XcodeGen is needed to generate the Xcode project: brew install xcodegen');
  const env = { ...process.env, TVOS_TEAM_ID: TEAM_ID, TVOS_BUNDLE_ID: BUNDLE_ID };
  run('xcodegen', ['generate', '--quiet'], appDir, env);
  run('xcodebuild', [
    '-project', 'AerodanceTV.xcodeproj', '-scheme', 'AerodanceTV', '-configuration', 'Release',
    '-destination', `id=${tv.udid}`, '-derivedDataPath', 'build',
    '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', '-quiet', 'build',
  ], appDir, env);
  return path.join(appDir, 'build/Build/Products/Release-appletvos/aerodance.app');
}

function buildBench() {
  const out = path.join(appDir, 'bench/dist');
  rmSync(out, { recursive: true, force: true });
  run('npx', ['rolldown', './client-tvos/bench/aeroBench.ts', '--format', 'iife', '--minify', '--file', 'client-tvos/bench/dist/aero-bench.js']);
  cpSync(path.join(appDir, 'bench/aero-bench.html'), path.join(out, 'aero-bench.html'));
  console.log(`Built ${path.relative(root, out)}/aero-bench.{html,js}`);
}

function launch(tv: AppleTV, page: string, report: boolean) {
  const args = ['devicectl', 'device', 'process', 'launch', '--device', tv.udid, '--terminate-existing', '--quiet', BUNDLE_ID, '--path', page];
  if (report) args.push('--report', `http://${lanAddress()}:${REPORT_PORT}/report`);
  run('xcrun', args);
  console.log(`Launched aerodance on ${tv.name} at ${page}`);
}

type Report = {
  fps?: number; worstFrameMs?: number; jsMsPerFrame?: number; drawsPerFrame?: number; numericLoopMs?: number;
  dataset?: Record<string, string>;
};

// Prints what the app's injected script (client-tvos/src/inject.js) posts every two seconds.
function receiveReports() {
  let first = true;
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.end();
      let r: Report;
      try { r = JSON.parse(body) as Report; } catch { return; }
      if (first && r.numericLoopMs !== undefined) console.log(`JavaScript loop benchmark: ${r.numericLoopMs} ms (about 285 with a JIT, 565 without, on an M5 Pro)`);
      first = false;
      const d = r.dataset ?? {};
      const screen = d.gamePhase ? `game ${d.gamePhase}` : d.songScreen === 'preview' ? 'song preview' : `menu ${d.menuScreen ?? '?'}`;
      const time = new Date().toTimeString().slice(0, 8);
      console.log(`${time}  ${String(r.fps).padStart(5)} fps  worst ${String(r.worstFrameMs).padStart(5)} ms  JS ${String(r.jsMsPerFrame).padStart(6)} ms/frame  ${String(r.drawsPerFrame).padStart(4)} draws  ${screen}`);
    });
  }).on('error', (error) => {
    console.error(`Can't receive reports on port ${REPORT_PORT}: ${error.message}`);
    process.exit(1);
  }).listen(REPORT_PORT, '0.0.0.0', () => console.log(`Waiting for reports on port ${REPORT_PORT} (Ctrl-C to stop)…`));
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1] ?? ''; };
  const has = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'devices') {
    const tvs = appleTVs();
    return console.log(tvs.map((tv) => `${tv.name}  tvOS ${tv.osVersion}  ${tv.pairing}  ${tv.udid}`).join('\n') || 'No Apple TVs found.');
  }
  if (cmd === 'bench') return buildBench();
  if (cmd !== 'deploy' && cmd !== 'launch') throw Error(`Unknown command ${cmd}\n\n${USAGE}`);
  const device = flag('--device');
  const page = flag('--path') || '/?input=ghost';
  const report = has('--report');
  const skipWebBuild = has('--skip-web-build');
  if (args.length) throw Error(`Unknown option ${args[0]}\n\n${USAGE}`);
  const tv = pickDevice(device);
  if (report) receiveReports();
  if (cmd === 'deploy') {
    const app = buildApp(tv, skipWebBuild);
    run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', tv.udid, '--quiet', app]);
    console.log(`Installed on ${tv.name}`);
  }
  launch(tv, page, report);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
