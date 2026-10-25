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
  /** The dance revision the request was made against, and a stamp of dance.json's content (hand edits keep the revision); the renderer reloads when either differs. */
  revision: number;
  stamp?: string;
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
  /** The paths the head, wrists and ankles take over this many ms either side of each time. */
  trails?: number;
  /** An earlier revision's skeletons, drawn grey and dashed, to compare an edit with what it replaced. */
  before?: number | null;
  title: string;
}
