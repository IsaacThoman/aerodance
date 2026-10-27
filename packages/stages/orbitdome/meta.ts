import type { StageMeta } from '../catalog.ts';
import orbit from '../orbit/meta.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
// The orbit stage's deck closed under a glass dome.
const meta = {
  id: 'orbitdome',
  subtitle: 'Garden dome on an orbiting station',
  accent: ['#c6ff9a', '#1f9fd0'],
  dancers: orbit.dancers,
  post: orbit.post,
} satisfies StageMeta;

export default meta;
