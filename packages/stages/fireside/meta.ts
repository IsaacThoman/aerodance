import type { StageMeta } from '../catalog.ts';
import { FLOOR } from './layout.ts';

// Name card, dancer placement and post settings, loaded before the stage itself.
const meta = {
  id: 'fireside',
  subtitle: 'Fireside in the glass cabin',
  accent: ['#ffc48a', '#d0602a'],
  // On the rug in the middle of the cabin floor, which stands above the frozen lake.
  dancers: { position: [0, FLOOR, 0], rotationY: 0, spacing: 4 },
  // The cabin's roof slopes in on both sides, so the preview swings the camera to and fro
  // in front of the window instead of circling.
  previewOrbit: { swing: 0.55 },
  post: {
    bloomStrength: 0.5,
    bloomRadius: 0.5,
    bloomThreshold: 1.3,
    exposure: 1.05,
    vignette: 0.26,
    saturation: 1.1,
    tint: [1.02, 1, 0.97],
  },
} satisfies StageMeta;

export default meta;
