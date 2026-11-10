import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'koi',
  name: 'Koi Pond',
  subtitle: 'Koi among lily pads and falling petals',
  post: {
    bloomStrength: 0.35,
    bloomRadius: 0.3,
    bloomThreshold: 1.2,
    exposure: 1.0,
    vignette: 0.22,
    saturation: 1.1,
    tint: [0.99, 1.0, 1.0],
  },
} satisfies BackdropMeta;

export default meta;
