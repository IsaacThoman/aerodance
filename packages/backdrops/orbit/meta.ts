import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'orbit',
  name: 'Orbit',
  subtitle: 'A glossy Earth seen from orbit',
  // The sun, the sunrise along the limb, the ocean glint and the satellites run past the threshold.
  post: {
    bloomStrength: 0.4,
    bloomRadius: 0.42,
    bloomThreshold: 1.3,
    exposure: 1,
    vignette: 0.24,
    saturation: 1.12,
    tint: [0.98, 1, 1.03],
  },
} satisfies BackdropMeta;

export default meta;
