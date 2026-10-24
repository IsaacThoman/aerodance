// What the CLI asks the headless renderer for (server.ts → render.tsx): one PNG with a row per
// time and a cell per view. A clip frame is a sheet of one time without labels.
export const VIEWS = ['source', 'overlay', 'skeleton', 'character', 'stage'] as const;
/**
 * source: the video frame; overlay: the frame with the dance's skeletons over it; skeleton: the
 * skeletons alone, with scoring limbs drawn heavier; character: the glass characters, unmirrored
 * (as filmed); stage: the game's stage and dancers, mirrored as the game shows them.
 */
export type View = typeof VIEWS[number];
export interface RenderSpec {
  /** The dance revision the request was made against; the renderer reloads the dance if it's behind. */
  revision: number;
  /** Song times, one row each. */
  times: number[];
  views: View[];
  /** Which dancers to draw (ids), or all. */
  dancers: string[] | null;
  /** A dancer to emphasise. */
  focus: string | null;
  /** The part of the frame to show, in frame coordinates; null for all of it. */
  zoom: { x: number; y: number; w: number; h: number } | null;
  /** Width of each frame cell in pixels. */
  cellWidth: number;
  /** Draw the tracked video poses (dashed) over the frame. */
  reference: boolean;
  /** Draw the poses at the neighbouring keys faintly (onion skin). */
  ghosts: boolean;
  /** Show the character view mirrored, as the game's coach. */
  mirror: boolean;
  /** Row labels and the header. */
  labels: boolean;
  /** Labelled frame-coordinate gridlines over the video cells, for reading positions off the picture. */
  grid?: boolean;
  title: string;
}
