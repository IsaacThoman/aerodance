// What the Apple TV app (scripts/tvos.ts) and the iPhone/iPad app (scripts/ios.ts) share: the
// signing team, the bundle ID (one App Store listing for both), the deployed site they pair
// phones through, and the fonts they bundle.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_TEAM_ID = 'PX72AL9366';
export const DEFAULT_BUNDLE_ID = 'com.isaacthoman.aerodance';

// Where the apps pair a phone: the deployed game and its pairing server.
export const SITE = 'https://aerodance.party';

export function checkSite(site: string) {
  if (!/^https?:\/\/[^/]+$/.test(site)) throw Error(`--site takes an origin like ${SITE}, not ${site}`);
  return site;
}

// Inter as the web build loads it from Google Fonts (weights 200 and 800). The apps bundle it,
// so the game looks the same offline.
const INTER = {
  200: 'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuDyfMZg.ttf',
  800: 'https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuDyYMZg.ttf',
};
export const INTER_WEIGHTS = Object.keys(INTER).map(Number);

/** Copies Inter into dir as Inter__<weight>.ttf, downloading it into .cache/fonts the first time. */
export async function copyInter(dir: string) {
  mkdirSync(dir, { recursive: true });
  const cache = path.join(root, '.cache/fonts');
  mkdirSync(cache, { recursive: true });
  for (const [weight, url] of Object.entries(INTER)) {
    const file = path.join(cache, `Inter__${weight}.ttf`);
    if (!existsSync(file)) {
      const res = await fetch(url);
      if (!res.ok) throw Error(`Inter ${weight}: ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    cpSync(file, path.join(dir, `Inter__${weight}.ttf`));
  }
}
