import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'atrium',
  name: 'Atrium',
  subtitle: 'A sunlit glass atrium full of plants',
  post: {
    bloomStrength: 0.32,
    bloomRadius: 0.5,
    bloomThreshold: 1.6,
    exposure: 0.86,
    vignette: 0.22,
    saturation: 1.2,
    tint: [0.99, 1.0, 1.02],
  },
} satisfies BackdropMeta;

export default meta;
