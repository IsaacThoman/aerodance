// The six-axis arm's finishes as swatches in one texture atlas (decals.ts draws them beside the
// printed labels): each part's second UV set points at its swatch, so a whole link, whatever it's
// made of, draws as one mesh with one material (a painted one with orange peel, and a bare one
// for metal, rubber, plastic and labels). Plain data, so the geometry builds outside a browser.

export interface Swatch {
  color: string;
  roughness: number;
  metalness?: number;
  clearcoat?: number;
  /** Lit from inside: its colour, and how bright (1 = the material's emissive intensity). */
  emissive?: string;
  glow?: number;
  /** Painted: drawn with the painted material's orange-peel bump. */
  painted?: boolean;
}

const SWATCH_DATA = {
  orange: { color: '#dc5a1c', roughness: 0.36, clearcoat: 0.75, painted: true },
  graphite: { color: '#3a3d42', roughness: 0.5, clearcoat: 0.45, painted: true },
  black: { color: '#1c1d20', roughness: 0.52, clearcoat: 0.3, painted: true },
  yellow: { color: '#f0b400', roughness: 0.42, clearcoat: 0.5, painted: true },
  alu: { color: '#c9ccd0', roughness: 0.34, metalness: 1 },
  steel: { color: '#b4b7bb', roughness: 0.28, metalness: 1 },
  chrome: { color: '#f2f3f5', roughness: 0.07, metalness: 1 },
  oxide: { color: '#1f2022', roughness: 0.42, metalness: 1 },
  rubber: { color: '#141516', roughness: 0.8 },
  plastic: { color: '#222427', roughness: 0.55 },
  blue: { color: '#1f6fd1', roughness: 0.4, clearcoat: 0.3 },
  brass: { color: '#d3a74e', roughness: 0.3, metalness: 1 },
  sheath: { color: '#18191b', roughness: 0.5, clearcoat: 0.3 },
  conduit: { color: '#17181a', roughness: 0.46, clearcoat: 0.35 },
  grey: { color: '#5d6168', roughness: 0.5, clearcoat: 0.2 },
  white: { color: '#e6e6e1', roughness: 0.4, clearcoat: 0.4 },
  felt: { color: '#e4dcc0', roughness: 0.95 },
  red: { color: '#c4161c', roughness: 0.35, clearcoat: 0.6 },
  green: { color: '#0d2a14', roughness: 0.3, emissive: '#3dff6e', glow: 0.8 },
  greenLed: { color: '#0d2a14', roughness: 0.3, emissive: '#3dff6e', glow: 0.45 },
  amberLens: { color: '#6e4207', roughness: 0.2, clearcoat: 1 },
  redLens: { color: '#5a0a0a', roughness: 0.2, clearcoat: 1 },
  screen: { color: '#0b1218', roughness: 0.12, clearcoat: 1 },
} as const satisfies Record<string, Swatch>;

export type SwatchName = keyof typeof SWATCH_DATA;

export const SWATCHES: Record<SwatchName, Swatch> = SWATCH_DATA;

/** The atlas is ATLAS px square; swatches are SWATCH px blocks in rows from STRIP_Y down. */
export const ATLAS = 2048;
export const SWATCH = 32;
export const STRIP_Y = 1792;

const NAMES = Object.keys(SWATCHES) as SwatchName[];

/** A swatch's block in the atlas, in pixels. */
export function swatchBlock(name: SwatchName): { x: number; y: number } {
  const i = NAMES.indexOf(name);
  const perRow = ATLAS / SWATCH;
  return { x: (i % perRow) * SWATCH, y: STRIP_Y + Math.floor(i / perRow) * SWATCH };
}

/** The UV (flipY: v = 1 at the canvas top) of a swatch's centre. */
export function swatchUV(name: SwatchName): [number, number] {
  const { x, y } = swatchBlock(name);
  return [(x + SWATCH / 2) / ATLAS, 1 - (y + SWATCH / 2) / ATLAS];
}

export const SWATCH_NAMES = NAMES;
