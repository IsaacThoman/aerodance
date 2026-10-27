import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'cloudsea',
  name: 'Cloud Sea',
  subtitle: 'Sunrise above a sea of clouds',
  post: {
    bloomStrength: 0.35,
    bloomRadius: 0.55,
    bloomThreshold: 1.6,
    exposure: 0.85,
    vignette: 0.16,
    saturation: 1.14,
  },
} satisfies BackdropMeta;

export default meta;
