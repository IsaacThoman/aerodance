import type { PostOverrides } from '../stages/shared/post.tsx';
import aurora from './aurora/meta.ts';
import bubbles from './bubbles/meta.ts';
import ribbons from './ribbons/meta.ts';
import cloudsea from './cloudsea/meta.ts';
import hills from './hills/meta.ts';
import koi from './koi/meta.ts';
import atrium from './atrium/meta.ts';
import dew from './dew/meta.ts';
import orbit from './orbit/meta.ts';
import jellyfish from './jellyfish/meta.ts';

export type BackdropId = 'aurora' | 'bubbles' | 'ribbons' | 'cloudsea' | 'hills' | 'koi' | 'atrium' | 'dew' | 'orbit' | 'jellyfish';

/** A backdrop folder's `meta.ts`. */
export interface BackdropMeta {
  id: BackdropId;
  /** What Settings → Graphics → Background calls it. */
  name: string;
  /** What it shows, in a line. */
  subtitle: string;
  post: PostOverrides;
}

// The menu backdrops as plain data, in the order Settings steps through them, with no rendering
// code; index.ts pairs each with its component.
export const BACKDROP_METAS: readonly BackdropMeta[] = [aurora, bubbles, ribbons, cloudsea, hills, koi, atrium, dew, orbit, jellyfish];

export const isBackdropId = (id: unknown): id is BackdropId => BACKDROP_METAS.some((backdrop) => backdrop.id === id);
