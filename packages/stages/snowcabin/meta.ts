import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'snowcabin',
  subtitle: 'Snowy cabin under the aurora',
  accent: ['#8ff5d0', '#2a9a8a'],
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
