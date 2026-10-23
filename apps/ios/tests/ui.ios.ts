// The iPhone/iPad app's UI tests in a simulator (AerodanceUITests.swift): it launches, reaches
// the main menu, is landscape on an iPhone, taps through Let's dance for one player and a song to the song
// preview, turns both ways on an iPad, and shows the remote when a TV connects (the simulator's
// TV-out screen, through ../tools/simscreen.m).
//
//   node apps/ios/tests/ui.ios.ts --device <simulator UDID> [--port <port>] [--out <dir>] [--only <test>]
//
// Install the app first: node scripts/ios.ts sim --device <UDID> --port <port>. This generates
// the test project outside the repo (XcodeGen), runs it with xcodebuild, and serves the tests on
// a free loopback port: the app reports the game's state there (--report), and the tests' screenshots
// are saved to --out (default: aerodance-ios-ui in the system's temporary directory).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { menuLayout } from '../../web/src/menu/layout.ts';
import { gameLayout } from '../../web/src/game/layout.ts';
import { DISPLAY_MODES } from '../../web/src/display.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const device = option('--device');
if (!device) throw Error('Usage: node apps/ios/tests/ui.ios.ts --device <simulator UDID> [--port <port>] [--out <dir>] [--only <test>]');
const port = option('--port') ?? '8417';
const out = path.resolve(option('--out') ?? path.join(os.tmpdir(), 'aerodance-ios-ui'));
mkdirSync(out, { recursive: true });
const BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.isaacthoman.aerodance';
const here = fileURLToPath(new URL('.', import.meta.url));

if (spawnSync('xcrun', ['simctl', 'get_app_container', device, BUNDLE_ID]).status !== 0) {
  throw Error(`${BUNDLE_ID} isn't installed in ${device}; run node scripts/ios.ts sim --device ${device} --port ${port} first`);
}

// The simulator's TV-out screen, through ../tools/simscreen.m (built on first use), at 1920×1080.
let simscreen: string | undefined;
const tv = (on: boolean) => {
  if (!simscreen) {
    simscreen = path.join(mkdtempSync(path.join(os.tmpdir(), 'aerodance-simscreen-')), 'simscreen');
    const built = spawnSync('clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreGraphics', path.join(here, '../tools/simscreen.m'), '-o', simscreen], { stdio: 'inherit' });
    if (built.status !== 0) { simscreen = undefined; return console.error('Couldn\'t build tools/simscreen.m'); }
  }
  spawnSync(simscreen, on ? [device, 'on', '1920', '1080'] : [device, 'off'], { stdio: 'ignore' });
  console.log(`TV ${on ? 'on' : 'off'}`);
};

// The game's latest state, from the app's reports, and the tests' screenshots.
let state: Record<string, string> = {};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://runner');
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && url.pathname === '/report') {
      try {
        // The canvas's data-* state, plus where the game is showing and its frame rate as _display and _fps,
        // and which way up the device is held and its screens are (the host state's held and screens)
        // as _held and _screens ("game,phone").
        const r = JSON.parse(body.toString()) as { dataset?: Record<string, string>; display?: string; fps?: number;
          host?: { held?: number; screens?: { game?: number; phone?: number} } };
        if (r.dataset) {
          state = { ...r.dataset, _display: r.display ?? '', _fps: String(r.fps ?? ''), _held: String(r.host?.held ?? ''),
            _screens: r.host?.screens ? `${r.host.screens.game},${r.host.screens.phone}` : '' };
        }
      } catch { /* Not a report. */ }
    } else if (req.method === 'POST' && url.pathname === '/reset') {
      state = {};
    } else if (req.method === 'POST' && url.pathname === '/shot') {
      const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '_');
      writeFileSync(path.join(out, `${name}.png`), body);
      console.log(`screenshot ${name}.png`);
    } else if (req.method === 'POST' && url.pathname === '/tv') {
      tv(url.searchParams.get('on') === '1');
    } else if (req.method === 'POST' && url.pathname === '/shot-tv') {
      const name = (url.searchParams.get('name') ?? 'tv').replace(/[^\w-]/g, '_');
      spawnSync('xcrun', ['simctl', 'io', device, 'screenshot', '--display=external', path.join(out, `${name}.png`)], { stdio: 'ignore' });
      console.log(`screenshot ${name}.png (the TV)`);
    } else if (url.pathname === '/state') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(state));
    }
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const runner = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// The project, built next to a copy of its sources (XcodeGen's paths are the project's).
const work = mkdtempSync(path.join(os.tmpdir(), 'aerodance-ios-uitests-'));
for (const file of ['project.yml', 'AerodanceUITests.swift']) cpSync(path.join(here, file), path.join(work, file));
const generated = spawnSync('xcodegen', ['generate', '--quiet'], { cwd: work, stdio: 'inherit' });
if (generated.error || generated.status !== 0) throw Error('XcodeGen is needed to generate the test project: brew install xcodegen');

const layout = Object.fromEntries(Object.entries(DISPLAY_MODES).map(([mode, design]) => {
  const menu = menuLayout(design.w);
  const game = gameLayout(design.w);
  return [mode, { design: [design.w, design.h], start: menu.START, letsDance: menu.PLAYERS_GO, firstSong: game.rowRect(0), dance: game.DANCE }];
}));
const only = option('--only');
const env = { ...process.env, TEST_RUNNER_AERODANCE_BUNDLE_ID: BUNDLE_ID, TEST_RUNNER_AERODANCE_PORT: port, TEST_RUNNER_AERODANCE_PATH: '/?input=ghost',
  TEST_RUNNER_AERODANCE_RUNNER: runner, TEST_RUNNER_AERODANCE_LAYOUT: JSON.stringify(layout) };
const xcodebuild = spawn('xcodebuild', ['test', '-project', path.join(work, 'AerodanceUITests.xcodeproj'), '-scheme', 'AerodanceUITests',
  '-destination', `id=${device}`, '-derivedDataPath', path.join(work, 'build'), '-resultBundlePath', path.join(out, `results-${Date.now()}.xcresult`),
  ...(only ? [`-only-testing:AerodanceUITests/AerodanceUITests/${only}`] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const log: string[] = [];
const verdict = await new Promise<string>((resolve) => {
  const read = (data: Buffer) => {
    const text = data.toString();
    log.push(text);
    for (const line of text.split('\n')) if (/^Test (Case|Suite).*(passed|failed|skipped)|error:|XCTAssert|Skipped/.test(line)) console.log(line.trim());
    // xcodebuild can linger after its verdict; it's done with the tests by then.
    const done = /\*\* TEST (SUCCEEDED|FAILED) \*\*/.exec(text);
    if (done) resolve(done[1]);
  };
  xcodebuild.stdout.on('data', read);
  xcodebuild.stderr.on('data', read);
  xcodebuild.on('exit', () => resolve('FAILED'));
});
xcodebuild.kill();
server.close();
server.closeAllConnections();
writeFileSync(path.join(out, 'xcodebuild.log'), log.join(''));
console.log(`UI tests ${verdict === 'SUCCEEDED' ? 'passed' : 'failed'}; screenshots and the log are in ${out}`);
process.exitCode = verdict === 'SUCCEEDED' ? 0 : 1;
