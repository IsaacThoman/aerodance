/** What covers a cutout's pixel. */
export const CUTOUT = { none: 0, body: 1, eye: 2 } as const;

/** A moment of the menu capture (packages/character/assets/dance.adpose): its dancer and time. */
export interface CutoutPose { take: number; seconds: number; }

/** A thresholded cutout of the dancer (ui/dancerCutouts.ts), cropped to it. */
export interface Cutout {
  /** Pixels. */
  w: number;
  h: number;
  /** The body's middle, in whole pixels from the left: where it stands on its spot. */
  cx: number;
  /** CUTOUT values, row by row from the top. */
  part: Uint8Array;
}
