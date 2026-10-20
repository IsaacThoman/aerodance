// Drives a running copy of the game (or Dance Studio) for interactive testing. `start` keeps a
// Vite server and a GPU-rendered Chromium page alive in the background; the other commands
// click, press keys, wait on the canvas's data-* state and take screenshots in that page.
// See docs/interactive-testing.md.
import { spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, ConsoleMessage, Page } from 'playwright';
import * as menuLayout from '../client/src/menu/layout.ts';
import * as gameLayout from '../client/src/game/layout.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, '.cache/play');
const sessionFile = path.join(dir, 'session.json');
const logFile = path.join(dir, 'daemon.log');
// The canvas UI's design space (client/src/ui/useCanvasUI.ts).
const DESIGN = { w: 1600, h: 900 };

type Options = {
  app: 'game' | 'studio';
  dist: boolean;
  headed: boolean;
  url: string;
  width: number;
  height: number;
  camera: 'fixture' | 'deny' | 'none';
};
type Session = { pid: number; port: number; appUrl: string; renderer: string; options: Options };
type Command = { cmd: string; [key: string]: unknown };

const USAGE = `Usage: node scripts/play.ts <command> [args]

  start [--studio] [--dist] [--headed] [--url /?input=ghost] [--size 1280x800]
        [--camera fixture|deny|none]   start (or restart) the background session
  stop                                 close the browser and server
  status                               session details, renderer and frame rate
  state                                the canvas's data-* state as JSON
  click <target> | --locator <sel>     click a layout target, design point "x,y" or element
  hover <target>                       move the mouse to a target
  key <key>...                         press keys (Enter, Escape, ArrowDown, ...)
  type <text>                          type text into the focused element
  wait <cond>... [--timeout ms]        wait until every condition holds:
                                       key=value, key~regex, key>number, key<number
  shot [file.png] [--frame]            screenshot (the page, or just the game frame)
  goto <path or url>                   load a page and wait until it is ready
  reload                               reload and wait until ready
  eval <js>                            evaluate an expression in the page
  logs [--clear]                       console messages and page errors so far
  camera <0-4>                         dancers in the fixture camera's shot
  resize <width>x<height>              change the viewport
  targets                              list the layout targets click accepts

Targets name layout exports in client/src/{menu,game}/layout.ts, e.g. START,
menu.BACK, game.BACK, rowRect.0 or GAME_CALIBRATION_CAMERA.next.`;

// ---- Layout targets ----

type Shape = { x: number; y: number; w?: number; h?: number; r?: number };
const layouts: Record<string, Record<string, unknown>> = { menu: menuLayout, game: gameLayout };
const isShape = (v: unknown): v is Shape =>
  typeof v === 'object' && v !== null && typeof Reflect.get(v, 'x') === 'number' && typeof Reflect.get(v, 'y') === 'number';
const centre = (s: Shape) => ({ x: s.x + (s.w ?? 0) / 2, y: s.y + (s.h ?? 0) / 2 });

/** The design-unit point a target names: "x,y", "[module.]EXPORT[.key...]" (functions take the key as an argument). */
function resolveTarget(target: string) {
  const point = /^(-?[\d.]+),(-?[\d.]+)$/.exec(target);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  let parts = target.split('.');
  let modules = Object.keys(layouts);
  if (parts[0] in layouts) { modules = [parts[0]]; parts = parts.slice(1); }
  const found = modules.filter((m) => parts[0] in layouts[m]);
  if (found.length > 1) throw Error(`${target} is in ${found.join(' and ')}; use ${found.map((m) => `${m}.${target}`).join(' or ')}`);
  if (!found.length) throw Error(`Unknown target ${target}; see \`node scripts/play.ts targets\``);
  let value: unknown = layouts[found[0]];
  for (const part of parts) {
    value = typeof value === 'function' ? value(Number(part)) : (value as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof value === 'function') value = value(0);
  const shape = isShape(value) ? value : (value as { rect?: unknown } | undefined)?.rect;
  if (!isShape(shape)) throw Error(`${target} is not a layout rect or circle`);
  return centre(shape);
}

function listTargets() {
  const lines: string[] = [];
  const walk = (name: string, value: unknown) => {
    if (typeof value === 'function') lines.push(`${name}.<n>`);
    else if (isShape(value)) lines.push(name);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(`${name}.${k}`, v);
  };
  for (const [module, exports] of Object.entries(layouts)) for (const [k, v] of Object.entries(exports)) walk(`${module}.${k}`, v);
  return lines.join('\n');
}

// ---- Browser ----

// Playwright's own build, else the newest one in its cache (another checkout may have installed
// a different Playwright version), unless CHROMIUM_PATH says otherwise.
function chromiumPath(headed: boolean) {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
    : process.platform === 'win32' ? path.join(os.homedir(), 'AppData/Local/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright'));
  const binaries: Record<string, string[]> = {
    'chromium_headless_shell-': [`chrome-headless-shell-${process.platform === 'darwin' ? `mac-${process.arch}` : 'linux64'}/chrome-headless-shell`],
    'chromium-': [
      `chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win/chrome.exe',
    ],
  };
  const builds = existsSync(cache) ? readdirSync(cache) : [];
  for (const prefix of headed ? ['chromium-'] : ['chromium-', 'chromium_headless_shell-']) {
    const candidates = builds.filter((d) => d.startsWith(prefix) && /^\d+$/.test(d.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
      .flatMap((d) => binaries[prefix].map((b) => path.join(cache, d, b)));
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
  }
  throw Error('No Chromium found: run `npx playwright install chromium` or set CHROMIUM_PATH');
}

// Headless Chromium falls back to SwiftShader (about 1 fps for the game) unless told to use the
// GPU. PLAY_BROWSER_ARGS adds flags, for machines where these defaults don't find it.
function gpuFlags() {
  const extra = process.env.PLAY_BROWSER_ARGS?.split(' ').filter(Boolean) ?? [];
  if (process.platform === 'darwin') return ['--use-angle=metal', ...extra];
  if (process.platform === 'win32') return ['--use-angle=d3d11', ...extra];
  return ['--ignore-gpu-blocklist', ...extra];
}

// A synthetic webcam like the webcam tests': the MediaPipe fixture photo, drawn once per dancer.
function fakeCamera({ image, mode }: { image: string; mode: Options['camera'] }) {
  const w = window as typeof window & { playDancers: number };
  w.playDancers = 2;
  if (mode === 'deny') {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera denied by play --camera deny', 'NotAllowedError'); };
    return;
  }
  Object.defineProperty(navigator, 'mediaDevices', { value: {
    enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'play-fixture', label: 'Fixture camera', groupId: '' }],
    getUserMedia: async () => {
      const photo = new Image(); photo.src = image; await photo.decode();
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const g = canvas.getContext('2d'); let count = 0;
      if (!g) throw Error('2D canvas unavailable');
      const draw = () => {
        g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480);
        const offset = Math.sin(count++ / 20) * 2;
        // One dancer in the middle, two side by side; three or four squeezed into narrower lanes
        // at full height (the photo's arms-out stance is too small for MediaPipe at lane width).
        // MediaPipe tracks three of these reliably but not four (docs/three-and-four-players.md).
        const n = w.playDancers, width = n > 2 ? 640 / n : 320;
        for (let i = 0; i < n; i++) g.drawImage(photo, 200, 0, 600, 667, (n === 1 ? 320 : (i + 0.5) * 640 / n) - width / 2 + offset, 40, width, 356);
      };
      draw(); const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
      }
      return stream;
    },
    addEventListener() {}, removeEventListener() {},
  } });
}

// ---- Daemon: owns the server, browser and page ----

async function daemon(options: Options) {
  const vite = await import('vite');
  const configFile = path.join(root, options.app === 'studio' ? 'tools/choreography/vite.config.ts' : 'vite.config.ts');
  let appUrl: string;
  let closeServer: () => Promise<void>;
  if (options.dist) {
    await vite.build({ configFile, logLevel: 'warn' });
    const server = await vite.preview({ configFile, preview: { host: '127.0.0.1', port: 4300, strictPort: false } });
    appUrl = server.resolvedUrls?.local[0] ?? '';
    closeServer = () => server.close();
  } else {
    const server = await vite.createServer({ configFile, server: { host: '127.0.0.1', port: 5300, strictPort: false } });
    await server.listen();
    appUrl = server.resolvedUrls?.local[0] ?? '';
    closeServer = () => server.close();
  }
  if (!appUrl) throw Error('Vite did not report a URL');

  const browser: Browser = await chromium.launch({
    headless: !options.headed,
    executablePath: chromiumPath(options.headed),
    args: ['--autoplay-policy=no-user-gesture-required', ...gpuFlags()],
  });
  const page: Page = await browser.newPage({ viewport: { width: options.width, height: options.height } });
  page.setDefaultTimeout(30000);
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); if (logs.length > 500) logs.shift(); };
  page.on('console', (m: ConsoleMessage) => log(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) log(`[http ${r.status()}] ${r.url()}`); });
  // A reload (Vite's included) puts the game back on the main menu, so say when one happens.
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log(`[navigated] ${frame.url()}`); });
  if (options.camera !== 'none') {
    const image = `data:image/jpeg;base64,${(await readFile(path.join(root, 'client/tests/fixtures/mediapipe-pose.jpg'))).toString('base64')}`;
    await page.addInitScript(fakeCamera, { image, mode: options.camera });
  }

  const ready = async () => {
    if (options.app === 'studio') return page.waitForLoadState('load');
    // The canvas fades in once the world is built, then the menu reports ready. The phone
    // camera page (/pair/) has no world and is ready once it draws.
    await page.waitForFunction(() => {
      const c = document.querySelector<HTMLCanvasElement>('.canvas-frame canvas');
      return (c?.style.opacity === '1' && c.dataset.menuReady === 'true') || c?.dataset.phoneReady === 'true';
    }, null, { timeout: 120000 });
  };
  const goto = async (target: string) => { await page.goto(new URL(target, appUrl).href); await ready(); };
  await goto(options.url);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no WebGL2';
  });

  // Page position of a design-unit point in the letterboxed game frame.
  const toPage = async (x: number, y: number) => {
    const frame = await page.locator('.canvas-frame').boundingBox();
    if (!frame) throw Error('No .canvas-frame on this page; use --locator');
    return { x: frame.x + (x / DESIGN.w) * frame.width, y: frame.y + (y / DESIGN.h) * frame.height };
  };
  const shutdown = async () => {
    await browser.close().catch(() => {});
    await closeServer().catch(() => {});
    await rm(sessionFile, { force: true });
    process.exit(0);
  };
  let shots = 0;
  const commands: Record<string, (c: Command) => Promise<unknown>> = {
    state: () => page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.canvas-frame canvas');
      return c ? { ...c.dataset } : { url: location.href, title: document.title };
    }),
    status: async () => ({
      appUrl, url: page.url(), renderer, options,
      fps: await page.evaluate(() => new Promise<number>((done) => {
        let frames = 0; const start = performance.now();
        const tick = () => { frames++; if (performance.now() - start < 2000) requestAnimationFrame(tick); else done(Math.round(frames / 2)); };
        requestAnimationFrame(tick);
      })),
    }),
    click: async (c) => {
      if (typeof c.locator === 'string') return page.locator(c.locator).click();
      const p = await toPage(Number(c.x), Number(c.y));
      await page.mouse.click(p.x, p.y);
    },
    hover: async (c) => { const p = await toPage(Number(c.x), Number(c.y)); await page.mouse.move(p.x, p.y); },
    key: async (c) => { for (const k of c.keys as string[]) await page.keyboard.press(k); },
    type: (c) => page.keyboard.type(String(c.text)),
    wait: async (c) => {
      await page.waitForFunction((conditions) => {
        const d = document.querySelector<HTMLCanvasElement>('.canvas-frame canvas')?.dataset ?? {};
        return conditions.every(([key, op, want]) => {
          const have = d[key] ?? '';
          if (op === '=') return have === want;
          if (op === '~') return new RegExp(want).test(have);
          return have !== '' && (op === '>' ? Number(have) > Number(want) : Number(have) < Number(want));
        });
      }, c.conditions as [string, string, string][], { timeout: Number(c.timeout) || 30000 });
      return commands.state(c);
    },
    shot: async (c) => {
      const file = typeof c.file === 'string' ? path.resolve(String(c.cwd), c.file)
        : path.join(dir, 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}-${++shots}.png`);
      await mkdir(path.dirname(file), { recursive: true });
      if (c.frame) await page.locator('.canvas-frame').screenshot({ path: file });
      else await page.screenshot({ path: file });
      return file;
    },
    goto: (c) => goto(String(c.target)),
    reload: async () => { await page.reload(); await ready(); },
    eval: (c) => page.evaluate(String(c.js)),
    logs: async (c) => { const out = [...logs]; if (c.clear) logs.length = 0; return out.join('\n'); },
    camera: (c) => page.evaluate((n) => { Reflect.set(window, 'playDancers', n); }, Number(c.dancers)),
    resize: (c) => page.setViewportSize({ width: Number(c.width), height: Number(c.height) }),
    stop: async () => { setTimeout(shutdown, 50); },
  };

  // One command at a time, in order.
  let queue = Promise.resolve();
  const control = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      queue = queue.then(async () => {
        try {
          const command = JSON.parse(body) as Command;
          const run = commands[command.cmd];
          if (!run) throw Error(`Unknown command ${command.cmd}`);
          const result = await run(command);
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      });
    });
  });
  control.listen(0, '127.0.0.1');
  await new Promise((resolve) => control.once('listening', resolve));
  const address = control.address();
  if (!address || typeof address === 'string') throw Error('Control server has no port');
  // Closing a headed window ends the session.
  browser.on('disconnected', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  const session: Session = { pid: process.pid, port: address.port, appUrl, renderer, options };
  await writeFile(sessionFile, JSON.stringify(session, null, 2));
}

// ---- Client ----

async function readSession(): Promise<Session | null> {
  const text = await readFile(sessionFile, 'utf8').catch(() => null);
  if (!text) return null;
  const session = JSON.parse(text) as Session;
  try { process.kill(session.pid, 0); return session; } catch { await rm(sessionFile, { force: true }); return null; }
}

function send(session: Session, command: Command, timeoutMs = 180000) {
  return new Promise<unknown>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: session.port, method: 'POST', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const reply = JSON.parse(body) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) resolve(reply.result); else reject(Error(reply.error));
      });
    });
    req.on('timeout', () => req.destroy(Error('No reply from the play session')));
    req.on('error', reject);
    req.end(JSON.stringify(command));
  });
}

async function stopSession() {
  const session = await readSession();
  if (!session) return false;
  await send(session, { cmd: 'stop' }).catch(() => {});
  for (let i = 0; i < 100 && await readSession(); i++) await new Promise((r) => setTimeout(r, 100));
  if (await readSession()) process.kill(session.pid, 'SIGKILL');
  await rm(sessionFile, { force: true });
  return true;
}

async function start(args: string[]) {
  const options: Options = { app: 'game', dist: false, headed: false, url: '/', width: 1280, height: 800, camera: 'fixture' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--studio') options.app = 'studio';
    else if (a === '--dist') options.dist = true;
    else if (a === '--headed') options.headed = true;
    else if (a === '--url') options.url = args[++i];
    else if (a === '--size') [options.width, options.height] = args[++i].split('x').map(Number);
    else if (a === '--camera' && ['fixture', 'deny', 'none'].includes(args[i + 1])) options.camera = args[++i] as Options['camera'];
    else throw Error(`Unknown start option ${a}\n\n${USAGE}`);
  }
  if (await stopSession()) console.log('Stopped the previous session.');
  await mkdir(dir, { recursive: true });
  const out = openSync(logFile, 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', JSON.stringify(options)], {
    cwd: root, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + 300000;
  while (!exited && Date.now() < deadline) {
    const session = await readSession();
    if (session) {
      console.log(`Session ready: ${session.appUrl}${options.url.replace(/^\//, '')} (${options.app}${options.dist ? ', production build' : ', Vite dev server'}${options.headed ? ', headed' : ''})`);
      console.log(`Renderer: ${session.renderer}`);
      if (/SwiftShader|llvmpipe|software/i.test(session.renderer)) console.log('Warning: software rendering; the game will run at a few frames per second.');
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!exited) process.kill(child.pid ?? 0);
  throw Error(`The session did not start; see ${path.relative(process.cwd(), logFile)}:\n${await readFile(logFile, 'utf8')}`);
}

const print = (value: unknown) => {
  if (value === undefined) return;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === '__daemon') return daemon(JSON.parse(args[0]) as Options);
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'start') return start(args);
  if (cmd === 'targets') return console.log(listTargets());
  if (cmd === 'stop') return console.log((await stopSession()) ? 'Stopped.' : 'No session running.');
  const session = await readSession();
  if (!session) throw Error('No session running; start one with `node scripts/play.ts start`');
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1] ?? ''; };
  switch (cmd) {
    case 'click': {
      const locator = flag('--locator');
      if (locator !== undefined) return print(await send(session, { cmd, locator }));
      if (!args[0]) throw Error('click needs a target');
      return print(await send(session, { cmd, ...resolveTarget(args[0]) }));
    }
    case 'hover':
      if (!args[0]) throw Error('hover needs a target');
      return print(await send(session, { cmd, ...resolveTarget(args[0]) }));
    case 'key': return print(await send(session, { cmd, keys: args }));
    case 'type': return print(await send(session, { cmd, text: args.join(' ') }));
    case 'wait': {
      const timeout = Number(flag('--timeout')) || 30000;
      const conditions = args.map((a) => {
        const m = /^([A-Za-z0-9]+)([=~<>])(.*)$/.exec(a);
        if (!m) throw Error(`Bad condition ${a}; use key=value, key~regex, key>number or key<number`);
        return [m[1], m[2], m[3]];
      });
      return print(await send(session, { cmd, conditions, timeout }, timeout + 10000));
    }
    case 'shot': {
      const frame = args.includes('--frame');
      return print(await send(session, { cmd, file: args.find((a) => a !== '--frame'), frame, cwd: process.cwd() }));
    }
    case 'goto': return print(await send(session, { cmd, target: args[0] ?? '/' }));
    case 'eval': return print(await send(session, { cmd, js: args.join(' ') }));
    case 'logs': return print(await send(session, { cmd, clear: args.includes('--clear') }));
    case 'camera': return print(await send(session, { cmd, dancers: Number(args[0]) }));
    case 'resize': {
      const [width, height] = (args[0] ?? '').split('x').map(Number);
      if (!width || !height) throw Error('resize needs <width>x<height>');
      return print(await send(session, { cmd, width, height }));
    }
    case 'status': return print(await send(session, { cmd }));
    case 'state': case 'reload': return print(await send(session, { cmd }));
    default: throw Error(`Unknown command ${cmd}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
