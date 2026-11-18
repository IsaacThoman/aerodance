import { STAGE_METAS } from '../../../../../packages/stages/catalog.ts';
import type { StageId } from '../../../../../packages/stages/catalog.ts';
import { dancerIcon } from '../icons.ts';
import type { ScreensaverDefinition } from '../types.ts';

const NAMES: Record<StageId, string> = { openreef: 'Open Reef', sanctuary: 'Sanctuary', falls: 'Falls', club: 'Club', beach: 'Beach', atrium: 'Atrium' };

// Each stage keeps its own light (the beach's sunset, the club's night), so it suits any time of day.
const danceParty: ScreensaverDefinition = {
  id: 'dance-party',
  title: 'Dance Party',
  subtitle: 'The glass dancers dancing on the six stages',
  icon: dancerIcon,
  // shots.ts has them, stage by stage.
  views: [
    { value: 'stage', label: 'Stage' },
    { value: 'circle', label: 'Circling' },
    { value: 'close', label: 'Close-up' },
    { value: 'wide', label: 'Panorama' },
  ],
  scenarioLabel: 'Stage',
  scenarios: STAGE_METAS.map(({ id }) => ({ value: id, label: NAMES[id] })),
  scene: (scenario) => ({ stage: (STAGE_METAS.find((m) => m.id === scenario)?.id ?? 'openreef') }),
  sceneClock: true,
  order: 20,
  load: () => import('./Saver.tsx'),
};
export default danceParty;
