import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, readdir, cp, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import type { Plugin } from 'vite';
import { ASSET_PATH, HAND_MODEL, MEDIAPIPE_VERSION, MODEL_ASSETS, MODELS } from '../packages/pose/browser/models.ts';
import { isObject } from '../packages/pose/choreography.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache', ASSET_PATH);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let preparation: Promise<void> | undefined;
/** A cached pose model that isn't a current one (the hand model's file doesn't start like theirs). */
export const isRetiredModel = (file: string) => /^pose_landmarker_.*\.task$/.test(file) && !MODELS.some(model => model.file === file);
/**
 * Prepares the MediaPipe files: the WASM, and the models, downloaded and checked once. A dev
 * server (`optionalHands`) carries on without the hand model if it can't be downloaded (offline,
 * say): only a minigame that asks for hand tracking uses it, and it goes without. Builds need it.
 * The first caller's choice holds for the process.
 */
export function preparePoseAssets({ optionalHands = false } = {}) {
  return preparation ??= (async () => {
    const packageRoot = path.join(root, 'node_modules/@mediapipe/tasks-vision');
    const pkg: unknown = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (!isObject(pkg) || pkg.version !== MEDIAPIPE_VERSION) throw Error('MediaPipe JS/WASM version mismatch');
    await mkdir(path.join(directory, 'wasm'), { recursive: true });
    // An existing checkout may have cached retired models. Never serve or copy them into builds.
    for (const file of await readdir(directory))
      if (isRetiredModel(file)) await rm(path.join(directory, file));
    for (const file of await readdir(path.join(packageRoot, 'wasm')))
      await copyFile(path.join(packageRoot, 'wasm', file), path.join(directory, 'wasm', file));
    await Promise.all(MODEL_ASSETS.map(async model => {
      const filename = path.join(directory, model.file);
      const download = async () => {
        const response = await fetch(model.url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw Error(`${model.label} model download HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      };
      let bytes = await readFile(filename).catch((error: unknown) => { if (!isObject(error) || error.code !== 'ENOENT') throw error; });
      if (bytes && (bytes.length !== model.bytes || hash(bytes) !== model.sha256)) throw Error(`Cached ${model.label} model checksum mismatch; remove ${filename} and retry`);
      if (!bytes) {
        console.log(`Preparing MediaPipe ${model.label} model…`);
        try {
          bytes = await download();
        } catch (error) {
          if (!optionalHands || model !== HAND_MODEL) throw error;
          console.warn(`${model.label} model not downloaded (${error instanceof Error ? error.message : String(error)}); hand tracking is unavailable until it can be.`);
          return;
        }
        if (bytes.length !== model.bytes || hash(bytes) !== model.sha256) throw Error(`${model.label} model checksum mismatch`);
        const temporary = `${filename}.${process.pid}.tmp`;
        await writeFile(temporary, bytes);
        await rename(temporary, filename);
      }
    }));
    await copyFile(path.join(root, 'packages/pose/browser/NOTICE.md'), path.join(directory, 'NOTICE.md'));
    await copyFile(path.join(root, 'packages/pose/browser/LICENSE.Apache-2.0.txt'), path.join(directory, 'LICENSE.Apache-2.0.txt'));
  })();
}
export function poseAssetsPlugin(): Plugin {
  let base = '/';
  return {
    name: 'browser-pose-assets',
    configResolved(config) { base = config.base; },
    async configureServer(server) {
      await preparePoseAssets({ optionalHands: true });
      // express.static is typed for Express's Response, but serve-static only uses Node's http
      // API, so it works as the Connect middleware Vite's dev server expects.
      // @ts-expect-error Express's static handler typing does not admit Connect's ServerResponse.
      server.middlewares.use(`${base}${ASSET_PATH}`, express.static(directory));
    },
    async buildStart() { await preparePoseAssets(); },
    async writeBundle(options) {
      if (!options.dir) throw Error('Pose assets need a build output directory');
      await cp(directory, path.join(options.dir, ASSET_PATH), { recursive: true });
    },
  };
}
