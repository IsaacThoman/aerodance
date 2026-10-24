// Finding and starting a Chromium that renders WebGL on the GPU, for scripts that drive the
// game or tools headless (scripts/play.ts, tools/dance).
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Playwright's own build, else the newest one in its cache (another checkout may have installed
// a different Playwright version), unless CHROMIUM_PATH says otherwise.
export function chromiumPath(headed: boolean) {
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
export function gpuFlags() {
  const extra = process.env.PLAY_BROWSER_ARGS?.split(' ').filter(Boolean) ?? [];
  if (process.platform === 'darwin') return ['--use-angle=metal', ...extra];
  if (process.platform === 'win32') return ['--use-angle=d3d11', ...extra];
  return ['--ignore-gpu-blocklist', ...extra];
}
