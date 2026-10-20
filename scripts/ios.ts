// Builds the production game into the iPhone/iPad app in client-ios/ and installs it on a paired
// iPhone or iPad, or on a simulator. See client-ios/README.md.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { checkSite, copyInter, DEFAULT_BUNDLE_ID, DEFAULT_TEAM_ID, INTER_WEIGHTS, root, SITE } from './apple.ts';

const appDir = path.join(root, 'client-ios');
const www = path.join(appDir, 'www');
const TEAM_ID = process.env.IOS_TEAM_ID || DEFAULT_TEAM_ID;
const BUNDLE_ID = process.env.IOS_BUNDLE_ID || DEFAULT_BUNDLE_ID;
const REPORT_PORT = 8766;

const USAGE = `Usage: node scripts/ios.ts <command> [options]

  devices                          list the iPhones and iPads paired with this Mac
  build [--sim] [--release] [--site <origin>] [--skip-web-build]
                                   build the game and the app (for the simulator with --sim)
  deploy [options] [--skip-web-build]
                                   build the game and the app, install it and launch it
  launch [options]                 relaunch the installed app
  sim [options] [--skip-web-build] the same in a simulator (--device <name or UDID>, else the
                                   booted one)

Build options:
  --release                        the configuration an App Store build will use: no Web
                                   Inspector, no local network exception (NSAllowsLocalNetworking),
                                   and the launch options below are ignored (no archive or
                                   upload yet)
  --site <origin>                  the deployed game the app pairs phones through (default
                                   ${SITE}; a PR preview is https://<number>.aerodance.party)

Options:
  --device <name>                  the iPhone or iPad (needed when more than one is paired)
  --path <path>                    the page to open (default /)
  --report                         print the app's frame rate, JavaScript time per frame and
                                   draw calls every two seconds, until Ctrl-C
  --report-to <url>                send those reports to another address instead
  --flow                           play one player → first song → Dance! → results with the
                                   remote's keys (use with --path '/?input=ghost')
  --drive <json>                   play these steps, as the Apple TV app's launch config takes
                                   them: [["wait", {"menuReady": "true"}], ["key", "Enter"],
                                   ["tap", 800, 450], ["sleep", 500], ...] (taps in the canvas
                                   UI's 1600×900 design units)
  --clear-website-data             clear the page's storage first, as if WebKit had, to check
                                   the app restores saved scores and settings
  --port <port>                    serve the game on this loopback port instead of 8417, so
                                   simulators can run side by side (saved scores and settings
                                   belong to the port)

Signing uses IOS_TEAM_ID (default ${TEAM_ID}) and IOS_BUNDLE_ID (default ${BUNDLE_ID}).`;

type Device = { name: string; udid: string; pairing: string; osVersion: string };
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

function devices(): Device[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aerodance-ios-'));
  const file = path.join(dir, 'devices.json');
  try {
    const result = spawnSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', file, '--quiet'], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(`devicectl list devices failed:\n${result.stderr}`);
    const list = JSON.parse(readFileSync(file, 'utf8')) as DeviceList;
    return list.result.devices
      .filter((d) => d.hardwareProperties.platform === 'iOS' && d.hardwareProperties.reality === 'physical' && d.hardwareProperties.udid)
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

function pickDevice(name: string | undefined): Device {
  const all = devices().filter((d) => d.pairing === 'paired');
  const named = name === undefined ? all : all.filter((d) => d.name === name || d.udid === name);
  if (named.length === 1) return named[0];
  const list = all.map((d) => `  ${d.name}`).join('\n') || '  (none; pair one in Xcode\'s Devices window first)';
  throw Error(name === undefined && all.length > 1
    ? `More than one iPhone or iPad is paired; choose one with --device:\n${list}`
    : `No paired iPhone or iPad${name === undefined ? '' : ` called "${name}"`}. Paired devices:\n${list}`);
}

// The booted simulator, or the one named.
function pickSimulator(name: string | undefined): string {
  const list = JSON.parse(spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }).stdout) as
    { devices: Record<string, { name: string; udid: string; state: string }[]> };
  const sims = Object.entries(list.devices).filter(([runtime]) => runtime.includes('.iOS-')).flatMap(([, d]) => d);
  const found = name === undefined ? sims.filter((s) => s.state === 'Booted') : sims.filter((s) => s.name === name || s.udid === name);
  if (found.length === 1) return found[0].udid;
  throw Error(name === undefined ? 'Boot one iOS simulator, or choose one with --device' : `No iOS simulator called "${name}"`);
}

// The Mac's address on the local network, which the phone sends --report diagnostics to.
function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  throw Error('This Mac has no local network address for the phone to report to');
}

// The bundled game loads Inter from Google Fonts; the app serves its own copy so it looks the same
// offline.
const GOOGLE_FONTS = /\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com" \/>\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin \/>\s*<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter[^"]*" rel="stylesheet" \/>/;
async function bundleFonts() {
  await copyInter(path.join(www, 'fonts'));
  writeFileSync(path.join(www, 'fonts/inter.css'), INTER_WEIGHTS.map((weight) =>
    `@font-face { font-family: 'Inter'; font-style: normal; font-weight: ${weight}; font-display: swap; src: url('/fonts/Inter__${weight}.ttf') format('truetype'); }\n`).join(''));
  const pages = readdirSync(www, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html') && !f.startsWith('bench'));
  for (const page of pages) {
    const file = path.join(www, page);
    const html = readFileSync(file, 'utf8');
    if (!GOOGLE_FONTS.test(html)) throw Error(`${page} no longer loads Inter from Google Fonts as scripts/ios.ts expects; update bundleFonts()`);
    writeFileSync(file, html.replace(GOOGLE_FONTS, '\n    <link rel="stylesheet" href="/fonts/inter.css" />'));
  }
}

function dropUnusedPoseModels() {
  const models = readdirSync(www, { recursive: true, encoding: 'utf8' }).filter((f) => /pose_landmarker_\w+\.task$/.test(f));
  if (!models.some((f) => f.endsWith('pose_landmarker_lite.task'))) throw Error('The web build has no pose_landmarker_lite.task; update dropUnusedPoseModels()');
  for (const f of models) if (!f.endsWith('pose_landmarker_lite.task')) rmSync(path.join(www, f));
}

type BuildOptions ={ release: boolean; site: string; skipWebBuild: boolean };

async function buildApp(destination: string, sdk: 'iphoneos' | 'iphonesimulator', { release, site, skipWebBuild }: BuildOptions) {
  checkSite(site);
  if (!skipWebBuild) run('npm', ['run', 'build']);
  if (!existsSync(path.join(root, 'dist/index.html'))) throw Error('No production build in dist/; run without --skip-web-build');
  rmSync(www, { recursive: true, force: true });
  // Unlike the Apple TV, phones have cameras: pose tracking comes along, with only the Lite model,
  // the one the game's camera uses (Full and Heavy, 9 and 29 MB, are only offered by the phone page,
  // which the app doesn't open; inject.js drops a saved choice of them).
  cpSync(path.join(root, 'dist'), www, { recursive: true });
  dropUnusedPoseModels();
  await bundleFonts();
  writeFileSync(path.join(www, 'app.json'), JSON.stringify({ site }));
  const bench = path.join(root, 'client-tvos/bench/dist');
  if (!release && existsSync(bench)) cpSync(bench, path.join(www, 'bench'), { recursive: true });
  if (spawnSync('xcodegen', ['--version']).error) throw Error('XcodeGen is needed to generate the Xcode project: brew install xcodegen');
  const env = { ...process.env, IOS_TEAM_ID: TEAM_ID, IOS_BUNDLE_ID: BUNDLE_ID };
  run('xcodegen', ['generate', '--quiet'], appDir, env);
  if (!release) {
    // Development builds report to the Mac over the local network (--report).
    const plist = path.join(appDir, 'Info.plist');
    run('plutil', ['-insert', 'NSAppTransportSecurity', '-json', '{"NSAllowsLocalNetworking":true}', plist]);
  }
  run('xcodebuild', [
    '-project', 'Aerodance.xcodeproj', '-scheme', 'Aerodance', '-configuration', 'Release', '-sdk', sdk,
    '-destination', destination, '-derivedDataPath', 'build',
    ...(sdk === 'iphoneos' ? ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration'] : ['CODE_SIGNING_ALLOWED=NO']),
    // Development builds take the launch options (main.m's AERODANCE_DEV) and are inspectable.
    ...(release ? [] : ['GCC_PREPROCESSOR_DEFINITIONS=$(inherited) AERODANCE_DEV=1']),
    '-quiet', 'build',
  ], appDir, env);
  return path.join(appDir, `build/Build/Products/Release-${sdk}/aerodance.app`);
}

type LaunchOptions = { page: string; reportUrl?: string; flow: boolean; drive?: string; clearWebsiteData: boolean; port?: string };

function appArgs({ page, reportUrl, flow, drive, clearWebsiteData, port }: LaunchOptions) {
  return ['--path', page, ...(reportUrl ? ['--report', reportUrl] : []), ...(flow ? ['--flow'] : []), ...(drive ? ['--drive', drive] : []),
    ...(clearWebsiteData ? ['--clear-website-data'] : []), ...(port ? ['--port', port] : [])];
}

type Report = {
  type?: string; step?: string | unknown[]; index?: number; waitedMs?: number; ms?: number; message?: string;
  fps?: number; frameMs?: { p95?: number }; jsMsPerFrame?: number; drawsPerFrame?: number; numericLoopMs?: number; display?: string;
  dataset?: Record<string, string>; thermal?: string; lowPower?: boolean; safeArea?: string; storage?: Record<string, string>;
  host?: { interrupted: boolean; tv: boolean };
};

// Prints what the app's injected script (client-ios/src/inject.js) posts every two seconds.
function receiveReports() {
  let first = true, safeArea: string | undefined, host = '';
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.end();
      let r: Report;
      try { r = JSON.parse(body) as Report; } catch { return; }
      const time = new Date().toTimeString().slice(0, 8);
      if (r.type === 'flow') return console.log(`${time}  flow: ${String(r.step)} after ${r.waitedMs} ms`);
      if (r.type === 'drive') return console.log(`${time}  drive ${r.index}: ${JSON.stringify(r.step)} after ${r.waitedMs} ms`);
      if (r.type === 'done') return console.log(`${time}  drive: done after ${r.ms} ms`);
      if (r.type === 'error') return console.log(`${time}  ${r.message}; canvas state ${JSON.stringify(r.dataset ?? {})}`);
      if (first && r.numericLoopMs !== undefined) console.log(`JavaScript loop benchmark: ${r.numericLoopMs} ms (about 285 with a JIT, 565 without, on an M5 Pro)`);
      if (r.storage) console.log(`Saved: ${Object.keys(r.storage).join(', ') || 'nothing'}`);
      first = false;
      // The page's env(safe-area-inset-*) and the app's host state, when they change.
      if (r.safeArea !== undefined && r.safeArea !== safeArea) { safeArea = r.safeArea; console.log(`Safe area: ${safeArea} px (top right bottom left)`); }
      if (r.host && JSON.stringify(r.host) !== host) { host = JSON.stringify(r.host); console.log(`Host: ${host}`); }
      const d = r.dataset ?? {};
      const screen = d.gamePhase ? `game ${d.gamePhase}` : d.songScreen === 'preview' ? 'song preview' : `menu ${d.menuScreen ?? '?'}`;
      const heat = `${r.thermal ?? '?'}${r.lowPower ? ', low power' : ''}`;
      console.log(`${time}  ${String(r.fps).padStart(5)} fps  p95 ${String(r.frameMs?.p95).padStart(5)} ms  JS ${String(r.jsMsPerFrame).padStart(6)} ms/frame  ${String(r.drawsPerFrame).padStart(4)} draws  ${heat}  ${screen}  on ${r.display}`);
    });
  }).on('error', (error) => {
    console.error(`Can't receive reports on port ${REPORT_PORT}: ${error.message}`);
    process.exit(1);
  }).listen(REPORT_PORT, '0.0.0.0', () => console.log(`Waiting for reports on port ${REPORT_PORT} (Ctrl-C to stop)…`));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1] ?? ''; };
  const has = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'devices') {
    return console.log(devices().map((d) => `${d.name}  iOS ${d.osVersion}  ${d.pairing}  ${d.udid}`).join('\n') || 'No iPhones or iPads found.');
  }
  const release = has('--release');
  const site = flag('--site') || SITE;
  if (cmd === 'build') {
    const sim = has('--sim');
    const skipWebBuild = has('--skip-web-build');
    if (args.length) throw Error(`Unknown option ${args[0]}\n\n${USAGE}`);
    const app = await buildApp(sim ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS', sim ? 'iphonesimulator' : 'iphoneos', { release, site, skipWebBuild });
    return console.log(`Built ${app}`);
  }
  if (cmd !== 'deploy' && cmd !== 'launch' && cmd !== 'sim') throw Error(`Unknown command ${cmd}\n\n${USAGE}`);
  if (release) throw Error('--release builds ignore launch options; use build --release');
  const device = flag('--device');
  const page = flag('--path') || '/';
  const report = has('--report');
  const reportTo = flag('--report-to');
  const flow = has('--flow');
  const drive = flag('--drive');
  if (drive !== undefined) {
    let steps: unknown;
    try { steps = JSON.parse(drive); } catch { /* reported below */ }
    if (!Array.isArray(steps)) throw Error(`--drive takes a JSON array of steps, not ${drive}`);
  }
  const clearWebsiteData = has('--clear-website-data');
  const port = flag('--port');
  if (port !== undefined && !/^\d+$/.test(port)) throw Error(`--port takes a number, not ${port}`);
  const skipWebBuild = has('--skip-web-build');
  if (args.length) throw Error(`Unknown option ${args[0]}\n\n${USAGE}`);
  if (report && !reportTo) receiveReports();
  const sim = cmd === 'sim';
  const reportUrl = reportTo || (report ? `http://${sim ? '127.0.0.1' : lanAddress()}:${REPORT_PORT}/report` : undefined);
  const launch = appArgs({ page, reportUrl, flow, drive, clearWebsiteData, port });

  if (sim) {
    const udid = pickSimulator(device);
    const app = await buildApp(`id=${udid}`, 'iphonesimulator', { release, site, skipWebBuild });
    run('xcrun', ['simctl', 'install', udid, app]);
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, BUNDLE_ID, ...launch]);
    return console.log(`Launched aerodance in simulator ${udid} at ${page}`);
  }
  const phone = pickDevice(device);
  if (cmd === 'deploy') {
    const app = await buildApp(`id=${phone.udid}`, 'iphoneos', { release, site, skipWebBuild });
    run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', phone.udid, '--quiet', app]);
    console.log(`Installed on ${phone.name}`);
  }
  run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', phone.udid, '--terminate-existing', '--quiet', BUNDLE_ID, ...launch]);
  console.log(`Launched aerodance on ${phone.name} at ${page}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
