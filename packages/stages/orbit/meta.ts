import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'orbit',
  subtitle: 'Glass deck in orbit at sunrise',
  accent: ['#9fe8ff', '#2a6fe0'],
  // On the deck (DECK_Y in layout.ts).
  dancers: { position: [0, 0, 0], rotationY: 0, spacing: 4 },
  // The sun, the sunrise along the limb, the ocean glint and the deck's lights run past the threshold.
  post: {
    bloomStrength: 0.36,
    bloomRadius: 0.42,
    bloomThreshold: 1.4,
    exposure: 0.95,
    vignette: 0.22,
    saturation: 1.12,
    tint: [0.98, 1, 1.03],
  },
} satisfies StageMeta;

export default meta;
