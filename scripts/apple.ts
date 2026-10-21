// What the Apple TV app (scripts/tvos.ts) and the iPhone/iPad app (scripts/ios.ts) share: the
// signing team, the bundle ID (one App Store listing for both), the deployed site they pair
// phones through, the fonts they bundle, and archiving them for App Store Connect.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

export const ARCHIVE_USAGE = `Archive options:
  --version <x.y.z>                the version (CFBundleShortVersionString), required
  --build-number <n>               the build number (CFBundleVersion; default the Unix time,
                                   which keeps increasing)
  --upload                         upload the build to App Store Connect for TestFlight,
                                   instead of exporting it into build/export/

Archiving signs in to App Store Connect with an API key when APP_STORE_CONNECT_API_KEY_PATH
(the .p8 file), APP_STORE_CONNECT_API_KEY_ID and APP_STORE_CONNECT_API_ISSUER_ID are set, and
otherwise with the account signed in to Xcode.`;

export type ArchiveOptions = { version: string; buildNumber: string; upload: boolean };

/** The archive command's options, checked. */
export function archiveOptions(version: string | undefined, buildNumber: string | undefined, upload: boolean): ArchiveOptions {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw Error(`archive needs --version <major.minor.patch>${version ? `, not ${version}` : ''}`);
  buildNumber ??= String(Math.floor(Date.now() / 1000));
  if (!/^\d+$/.test(buildNumber)) throw Error(`--build-number takes a number, not ${buildNumber}`);
  return { version, buildNumber, upload };
}

// xcodebuild's flags for an App Store Connect API key, or none for the account signed in to Xcode.
function authFlags() {
  const { APP_STORE_CONNECT_API_KEY_PATH: key, APP_STORE_CONNECT_API_KEY_ID: id, APP_STORE_CONNECT_API_ISSUER_ID: issuer } = process.env;
  if (!key && !id && !issuer) return [];
  if (!key || !id || !issuer) throw Error('An API key needs all of APP_STORE_CONNECT_API_KEY_PATH, APP_STORE_CONNECT_API_KEY_ID and APP_STORE_CONNECT_API_ISSUER_ID');
  return ['-authenticationKeyPath', key, '-authenticationKeyID', id, '-authenticationKeyIssuerID', issuer];
}

function xcodebuild(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync('xcodebuild', args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`xcodebuild ${args.at(-1)} failed (exit ${result.status})`);
}

type Project = { appDir: string; project: string; scheme: string; platform: 'iOS' | 'tvOS'; teamId: string; env: NodeJS.ProcessEnv };

/**
 * Archives an app whose Xcode project is generated and ready, at the version and build number
 * given, then exports it for App Store Connect: uploaded with --upload, else signed into
 * build/export/. Xcode signs the export with the team's cloud-managed distribution certificate.
 */
export function archive({ appDir, project, scheme, platform, teamId, env }: Project, { version, buildNumber, upload }: ArchiveOptions) {
  const build = path.join(appDir, 'build');
  const archivePath = path.join(build, 'aerodance.xcarchive');
  const exportPath = path.join(build, 'export');
  rmSync(archivePath, { recursive: true, force: true });
  rmSync(exportPath, { recursive: true, force: true });
  const auth = authFlags();
  console.log(`Archiving ${platform} ${version} (${buildNumber})…`);
  xcodebuild([
    '-project', project, '-scheme', scheme, '-configuration', 'Release', '-destination', `generic/platform=${platform}`,
    '-derivedDataPath', 'build', '-archivePath', archivePath, '-allowProvisioningUpdates', ...auth,
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${buildNumber}`, '-quiet', 'archive',
  ], appDir, env);
  // The archive carries the version and build number; Xcode isn't to change them.
  const exportOptions = path.join(build, 'ExportOptions.plist');
  writeFileSync(exportOptions, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${upload ? 'upload' : 'export'}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${teamId}</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict>
</plist>
`);
  xcodebuild([
    '-archivePath', archivePath, '-exportOptionsPlist', exportOptions, '-exportPath', exportPath,
    '-allowProvisioningUpdates', ...auth, '-exportArchive',
  ], appDir, env);
  console.log(upload
    ? `Uploaded ${platform} ${version} (${buildNumber}) to App Store Connect; it appears in TestFlight once processed`
    : `Exported ${platform} ${version} (${buildNumber}) to ${exportPath}`);
}
