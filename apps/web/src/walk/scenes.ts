import { BACKDROP_METAS, isBackdropId } from '../../../../packages/backdrops/catalog.ts';
import type { BackdropId } from '../../../../packages/backdrops/catalog.ts';
import { STAGE_METAS } from '../../../../packages/stages/catalog.ts';
import type { StageId } from '../../../../packages/stages/catalog.ts';

/** A scene walk mode can open: the Aero world, a menu backdrop or a dance stage. */
export type WalkScene = {
  /**
   * What walk mode knows it by (and `?walk=` names): its id, or `<id>-stage` for a stage that
   * shares its id with a backdrop, as the atrium does.
   */
  key: string;
  name: string;
  subtitle: string;
  /** Scene units to a metre: the walker's height, speed and jump scale with it. */
  scale: number;
  /** Starts flying (noclip) even with ground in sight. */
  fly?: boolean;
} & ({ kind: 'skyline'; id: 'skyline' } | { kind: 'backdrop'; id: BackdropId } | { kind: 'stage'; id: StageId });

// The stages have no display names of their own.
const STAGE_NAMES: Record<StageId, string> = {
  sanctuary: 'Sanctuary', openreef: 'Open Reef', falls: 'Falls', club: 'Club', beach: 'Beach', atrium: 'Atrium Stage',
};

// Each backdrop was built to its own scale, so it gets a walker to match: Aurora's cabin is 20
// units tall, and a koi over a unit long. A dancer on a stage is 2.6 units tall.
const BACKDROP_SCALES: Record<BackdropId, number> = {
  aurora: 2.5, bubbles: 1, ribbons: 1, cloudsea: 1, hills: 1, koi: 2, atrium: 1, dew: 1, orbit: 1, jellyfish: 1,
};
const STAGE_SCALE = 1.5;
// The atrium stage is the Atrium backdrop's room, built in metres like it.
const STAGE_SCALES: Partial<Record<StageId, number>> = { atrium: BACKDROP_SCALES.atrium };

// Menu backgrounds in the Settings order, then the stages in browse order.
export const WALK_SCENES: readonly WalkScene[] = [
  { key: 'skyline', id: 'skyline', kind: 'skyline', name: 'Skyline', subtitle: 'The Aero city, its lake and meadows', scale: 1 },
  // In orbit, the only ground is the Earth, curving away under a walker who'd only slide off it.
  ...BACKDROP_METAS.map(({ id, name, subtitle }): WalkScene => ({ key: id, id, kind: 'backdrop', name, subtitle, scale: BACKDROP_SCALES[id], fly: id === 'orbit' })),
  ...STAGE_METAS.map(({ id, subtitle }): WalkScene => ({
    key: isBackdropId(id) ? `${id}-stage` : id, id, kind: 'stage', name: STAGE_NAMES[id], subtitle, scale: STAGE_SCALES[id] ?? STAGE_SCALE,
  })),
];

/** The scene `?walk=<key>` asks for: Skyline when it names none, or one this build doesn't have. */
export function walkSceneFor(param: string | null): WalkScene {
  return WALK_SCENES.find(({ key }) => key === param) ?? WALK_SCENES[0];
}

/** The scene `step` places on from the one keyed `key` in WALK_SCENES, wrapping round. */
export function stepScene(key: string, step: number): WalkScene {
  const i = WALK_SCENES.findIndex((scene) => scene.key === key);
  const n = WALK_SCENES.length;
  return WALK_SCENES[(((i + step) % n) + n) % n];
}
