import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'icelake',
  subtitle: 'Frozen lake under the aurora',
  accent: ['#a8e4ff', '#3a6fd0'],
  dancers: { position: [0, 0, 0], rotationY: 0, spacing: 4 },
  post: {
    bloomStrength: 0.45,
    bloomRadius: 0.5,
    bloomThreshold: 1.2,
    exposure: 1.1,
    vignette: 0.24,
    saturation: 1.1,
  },
} satisfies StageMeta;

export default meta;
