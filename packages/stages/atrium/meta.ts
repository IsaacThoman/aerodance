import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'atrium',
  subtitle: 'Sunlit garden atrium',
  accent: ['#9ef2ff', '#1aa7c9'],
  // On the round dance floor 10.2 m in front of the aquarium column (AXIS in layout.ts), its top
  // 0.14 m up. The atrium is built in metres, so the dancers are scaled to life size, 1.8 m.
  dancers: { position: [0, 0.14, 2.2], rotationY: 0, spacing: 4, scale: 0.7 },
  // The column stands behind the dancers, so the preview swings the camera either way instead
  // of circling them.
  previewOrbit: { swing: 0.6 },
  post: {
    bloomStrength: 0.16,
    bloomRadius: 0.35,
    bloomThreshold: 2.4,
    exposure: 0.86,
    vignette: 0.2,
    saturation: 1.2,
    tint: [0.99, 1.0, 1.02],
  },
} satisfies StageMeta;

export default meta;
