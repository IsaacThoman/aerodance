import type { StageMeta } from '../catalog.ts';
import orbit from '../orbit/meta.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
// The orbit stage over the night side of the planet.
const meta = {
  id: 'orbitnight',
  subtitle: 'Over the night side, under the aurora',
  accent: ['#9dffd8', '#4a3fd8'],
  dancers: orbit.dancers,
  post: { ...orbit.post, exposure: 1.05 },
} satisfies StageMeta;

export default meta;
