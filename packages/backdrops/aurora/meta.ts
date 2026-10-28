import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'aurora',
  name: 'Aurora',
  subtitle: 'Northern lights over a mirror lake',
  post: {
    bloomStrength: 0.55,
    bloomRadius: 0.55,
    bloomThreshold: 1.0,
    exposure: 1.15,
    vignette: 0.25,
    saturation: 1.1,
  },
} satisfies BackdropMeta;

export default meta;
