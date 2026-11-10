import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'hills',
  name: 'Bliss Hills',
  subtitle: 'Rolling green hills, a river and wind turbines',
  post: {
    bloomStrength: 0.34,
    bloomRadius: 0.5,
    bloomThreshold: 2.0,
    exposure: 1.0,
    vignette: 0.16,
    saturation: 1.12,
    tint: [1.0, 1.0, 1.01],
  },
} satisfies BackdropMeta;

export default meta;
