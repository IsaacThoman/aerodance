import type { BackdropMeta } from '../catalog.ts';

// Settings name and post settings, loaded before the backdrop itself.
const meta = {
  id: 'dew',
  name: 'Dewdrops',
  subtitle: 'Raindrops on glossy leaves, up close',
  // Bloom only well above white, for the drops' glints and the leaves' sparkle; the bright sky
  // and bokeh stay under it, or they would haze over the big leaf (worst in 4:3, with more sky).
  post: {
    bloomStrength: 0.5,
    bloomRadius: 0.5,
    bloomThreshold: 1.8,
    exposure: 1.0,
    vignette: 0.28,
    saturation: 1.1,
    tint: [1.0, 1.01, 0.97],
  },
} satisfies BackdropMeta;

export default meta;
