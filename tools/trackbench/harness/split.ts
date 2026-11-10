// Which scenes are independent of which, and which ones tuning may look at.
//
// Render clusters: a post-only variant (the sens-* scenes, base-genre-mh) and the setup scenes
// that reuse a multiplayer render (setup-trio, setup-quad, setup-return; mp3-same, mp4-same) are
// the same pixels as their base, so a bootstrap over scenes must resample them together.
//
// The held-out split: 28 scenes (about a fifth), spread over every category and player count,
// that tuning a tracking change must not look at. Each takes its whole render cluster with it,
// so no held-out scene shares pixels with a tuning scene. Choose a change on the tuning set,
// then check it on this one; a change that helps tuning and not held-out is not a win.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sceneDir } from './common.ts';

export const HELD_OUT: readonly string[] = [
  // appearance
  'look-dress', 'look-skin-african-dim', 'look-hat',
  // background
  'bg-mirror', 'bg-wallpaper',
  // baseline
  'base-genre-ho', 'base-genre-wa', 'base-duo',
  // bystander
  'by-walk-behind', 'by-sofa-watcher',
  // camera
  'cam-yaw-30', 'cam-far-6.5', 'cam-portrait',
  // lighting, and the dim-evening render's two post-only sensor variants
  'light-party', 'light-dim_evening', 'sens-dim-gain', 'sens-dim-gain-jpeg',
  // motion
  'mot-side', 'mot-jumps',
  // multiplayer
  'mp2-close-far', 'mp2-cross-distinct', 'mp2-depth', 'mp2-offcentre-left', 'mp3-cross-middle', 'mp4-cross-edge', 'mp4-dim',
  // setup
  'setup-fidget', 'setup-late-joiner',
];
const heldOut = new Set(HELD_OUT);
export const isHeldOut = (scene: string) => heldOut.has(scene);
export type Split = 'tuning' | 'held-out';
export const splitOf = (scene: string): Split => heldOut.has(scene) ? 'held-out' : 'tuning';

const clusters = new Map<string, string>();
/**
 * The scene whose render this scene's pixels come from (itself unless it reuses another's): the
 * scene directory its `render/` resolves into. Scenes without a render directory are their own.
 */
export function renderCluster(scene: string): string {
  let cluster = clusters.get(scene);
  if (cluster) return cluster;
  const render = path.join(sceneDir(scene), 'render');
  cluster = existsSync(render) ? path.basename(path.dirname(realpathSync(render))) : scene;
  clusters.set(scene, cluster);
  return cluster;
}
