// Which scenes are independent of which.
//
// Render clusters: a post-only variant (the sens-* scenes, base-genre-mh) and the setup scenes
// that reuse a multiplayer render (setup-trio, setup-quad, setup-return; mp3-same, mp4-same) are
// the same pixels as their base, so a bootstrap over scenes must resample them together.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sceneDir } from './common.ts';

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
