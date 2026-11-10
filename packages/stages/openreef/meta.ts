import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'openreef',
  subtitle: 'On the sand of a sunlit reef',
  accent: ['#8fe4ff', '#1a7fd0'],
  // On the sand (SAND_Y in Reef.tsx).
  dancers: { position: [0, -0.45, 0], rotationY: 0, spacing: 4 },
  post: {
    bloomStrength: 0.26,
    bloomRadius: 0.35,
    bloomThreshold: 1.4,
    exposure: 0.92,
    vignette: 0.18,
    saturation: 1.15,
    tint: [0.98, 1.0, 1.02],
  },
} satisfies StageMeta;

export default meta;
