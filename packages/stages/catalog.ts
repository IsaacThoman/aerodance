import type { PostOverrides } from './shared/post.tsx';
import sanctuary from './sanctuary/meta.ts';
import openreef from './openreef/meta.ts';
import falls from './falls/meta.ts';
import club from './club/meta.ts';
import beach from './beach/meta.ts';
import atrium from './atrium/meta.ts';

export type StageId = 'sanctuary' | 'openreef' | 'falls' | 'club' | 'beach' | 'atrium';

export type Vec2 = readonly [x: number, y: number];
export type Vec3 = readonly [x: number, y: number, z: number];

/** Where the dancers stand: props for shared/Dancers.tsx. */
export interface DancerPlacement {
  /** The floor surface between the two dancers. */
  position: Vec3;
  /** Turns the pair (they face +z by default). */
  rotationY: number;
  /** Distance between the two dancers. */
  spacing: number;
  /** Uniform scale (1 = ~2.6 units tall). */
  scale?: number;
}

/** For stages that can't be circled: the Song Select preview swings the camera either way instead. */
export interface PreviewOrbit {
  /** Radians either way. */
  swing: number;
}

/** A stage folder's `meta.ts`. */
export interface StageMeta {
  id: StageId;
  subtitle: string;
  /** [light, dark] orb colours for the name card. */
  accent: readonly [light: string, dark: string];
  dancers: DancerPlacement;
  post: PostOverrides;
  /** By default the preview circles the dancers. */
  previewOrbit?: PreviewOrbit;
}

export type StageListing = Pick<StageMeta, 'id' | 'subtitle' | 'accent'>;

// The dance stages as plain data, in browse order, with no rendering code: Dance Studio,
// song catalogs and node tests import this; index.ts pairs each with its stage component.
export const STAGE_METAS: readonly StageMeta[] = [sanctuary, openreef, falls, club, beach, atrium];

export const STAGE_LIST: readonly StageListing[] = STAGE_METAS.map(({ id, subtitle, accent }) => ({ id, subtitle, accent }));

// Songs without a stage (or with one this build doesn't have) play here.
export const DEFAULT_STAGE: StageId = 'openreef';

// Stages that have been removed, and the stage their songs play on now. Songs and projects
// saved before still name them.
const REPLACED_STAGES: Readonly<Record<string, StageId>> = { reef: 'openreef' };

export const isStageId = (id: unknown): id is StageId => STAGE_LIST.some((stage) => stage.id === id);

/** A removed stage's replacement; any other value as it is. */
export const replaceRemovedStage = (id: unknown): unknown =>
  typeof id === 'string' && Object.hasOwn(REPLACED_STAGES, id) ? REPLACED_STAGES[id] : id;

/** The stage a song plays on: its own, a removed stage's replacement, or the default. */
export const resolveStage = (id: string | null | undefined): StageId => {
  const stage = replaceRemovedStage(id);
  return isStageId(stage) ? stage : DEFAULT_STAGE;
};
