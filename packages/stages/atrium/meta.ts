import type { StageMeta } from '../catalog.ts';

// Name cards, dancer placement and post settings, loaded before the stages themselves: the
// atrium at midday, at golden hour and at night (looks.ts).

// On the platform in the pool (PLATFORM in layout.ts). The column and the room stand behind it,
// so the Song Select preview swings the camera either way instead of circling.
const dancers = { position: [0, 0.62, 0], rotationY: 0, spacing: 4 } as const;
const previewOrbit = { swing: 0.8 };

export const atrium = {
  id: 'atrium',
  subtitle: 'A sunlit glass atrium',
  accent: ['#9dfcff', '#18a6c8'],
  dancers,
  previewOrbit,
  post: {
    bloomStrength: 0.2,
    bloomRadius: 0.4,
    bloomThreshold: 2.0,
    exposure: 0.86,
    vignette: 0.22,
    saturation: 1.18,
    tint: [0.99, 1.0, 1.02],
  },
} satisfies StageMeta;

export const atriumdusk = {
  id: 'atriumdusk',
  subtitle: 'The atrium at golden hour',
  accent: ['#ffd29a', '#e0662a'],
  dancers,
  previewOrbit,
  post: {
    bloomStrength: 0.28,
    bloomRadius: 0.45,
    bloomThreshold: 1.8,
    exposure: 0.9,
    vignette: 0.26,
    saturation: 1.15,
    tint: [1.02, 0.99, 0.97],
  },
} satisfies StageMeta;

export const atriumnight = {
  id: 'atriumnight',
  subtitle: 'The atrium after dark',
  accent: ['#9fb4ff', '#3a2fb8'],
  dancers,
  previewOrbit,
  post: {
    bloomStrength: 0.4,
    bloomRadius: 0.5,
    bloomThreshold: 1.5,
    exposure: 1.0,
    vignette: 0.3,
    saturation: 1.15,
    tint: [0.98, 0.99, 1.03],
  },
} satisfies StageMeta;
