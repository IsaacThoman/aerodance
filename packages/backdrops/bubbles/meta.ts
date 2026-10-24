import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'bubbles',
  name: 'Bubbles',
  subtitle: 'Glossy bubbles rising through aqua light',
  post: {
    bloomStrength: 0.42,
    bloomRadius: 0.55,
    bloomThreshold: 1.6,
    exposure: 1,
    vignette: 0.24,
    saturation: 1.16,
    tint: [0.98, 1, 1.02],
  },
} satisfies BackdropMeta;

export default meta;
