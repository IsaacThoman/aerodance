import type { StageMeta } from '../catalog.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'fireside',
  subtitle: 'Fireside in the glass cabin',
  accent: ['#ffc48a', '#d0602a'],
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
