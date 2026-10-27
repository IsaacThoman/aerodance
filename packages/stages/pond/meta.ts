import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'pond',
  subtitle: 'A giant lily pad on a koi pond',
  accent: ['#ffc4de', '#e2457f'],
  // On the giant lily pad's top (STAGE_PAD.top in layout.ts).
  dancers: { position: [0, 0.07, 0], rotationY: 0, spacing: 4 },
  post: {
    bloomStrength: 0.3,
    bloomRadius: 0.4,
    bloomThreshold: 1.9,
    exposure: 1.0,
    vignette: 0.2,
    saturation: 1.1,
    tint: [1.0, 1.0, 0.99],
  },
} satisfies StageMeta;

export default meta;
