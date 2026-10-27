import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself. The jellies' margins,
// beads and the sun's glints run above the bloom threshold and glow.
const meta = {
  id: 'jellyfish',
  name: 'Jellyfish',
  subtitle: 'Glowing jellyfish in deep blue water',
  post: {
    bloomStrength: 0.45,
    bloomRadius: 0.3,
    bloomThreshold: 1.1,
    exposure: 1.0,
    vignette: 0.26,
    saturation: 1.1,
    tint: [0.98, 1.0, 1.03],
  },
} satisfies BackdropMeta;

export default meta;
