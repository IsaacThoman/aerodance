import sanctuary from './sanctuary/meta.ts';
import reef from './reef/meta.ts';
import openreef from './openreef/meta.ts';
import falls from './falls/meta.ts';
import club from './club/meta.ts';
import beach from './beach/meta.ts';

// The dance stages as plain data, in browse order, with no rendering code: Dance Studio,
// song catalogs and node tests import this; index.js pairs each with its stage component.
// Each `meta.js`: { id, name, subtitle, accent: [light, dark] orb colors for the name card,
//   dancers: props for shared/Dancers.tsx (floor position, rotationY, spacing, scale),
//   post: overrides for shared/post.tsx,
//   previewOrbit?: { swing } radians the Song Select preview camera swings either way, for
//   stages that can't be circled (by default it circles the dancers) }
export const STAGE_METAS = [sanctuary, reef, openreef, falls, club, beach];

export const STAGE_LIST = STAGE_METAS.map(({ id, name, subtitle, accent }) => ({ id, name, subtitle, accent }));

// Songs without a stage (or with one this build doesn't have) play here.
export const DEFAULT_STAGE = 'openreef';

export const resolveStage = (id) => (STAGE_LIST.some((stage) => stage.id === id) ? id : DEFAULT_STAGE);

export const stageName = (id) => STAGE_LIST.find((stage) => stage.id === resolveStage(id)).name;
