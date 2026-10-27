import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'icelake',
  subtitle: 'Frozen lake under the aurora',
  accent: ['#b4f1ff', '#4c62dc'],
  // On the ice (y = 0) in the middle of the lake.
  dancers: { position: [0, 0, 0], rotationY: 0, spacing: 4 },
  post: {
    bloomStrength: 0.45,
    bloomRadius: 0.5,
    // Above the snow and the ice: the windows, lanterns, the curtains' brightest folds and the odd glint glow.
    bloomThreshold: 1.2,
    exposure: 1.1,
    vignette: 0.24,
    saturation: 1.1,
  },
} satisfies StageMeta;

export default meta;
