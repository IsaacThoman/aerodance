import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'ribbons',
  name: 'Ribbons',
  subtitle: 'Flowing ribbons of light',
  post: {
    bloomStrength: 0.45,
    bloomRadius: 0.6,
    bloomThreshold: 1.5,
    exposure: 1,
    vignette: 0.12,
    saturation: 1.2,
    tint: [0.99, 1, 1.02],
  },
} satisfies BackdropMeta;

export default meta;
