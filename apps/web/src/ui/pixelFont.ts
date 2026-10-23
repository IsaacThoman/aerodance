import '@fontsource/tiny5/latin.css';

/*
 * Tiny5, drawn one canvas pixel per font pixel. Tiny5 is a pixel font on an 8-unit grid (1024
 * units per em, 128 per pixel), so at 8px its pixels are canvas pixels, but fillText isn't exact:
 * CoreText (macOS, iOS, tvOS) smooths small glyphs, leaving faint pixels around and inside them.
 * So each glyph is drawn once at 8px and its alpha thresholded (as candiru's chat does), which
 * keeps the font's own pixels (fully covered) and drops the smoothing (well under half), and text
 * is drawn from those bitmaps as whole-pixel rects.
 *
 * await loadPixelFont();
 * const w = pixelTextWidth('FPS 60');               // px, advances included
 * drawPixelText(g, 'FPS 60', x, baseline, '#fff');  // x and baseline in whole canvas pixels
 */

const FAMILY = 'Tiny5';
/** Pixels above the baseline a glyph can reach (accents), and below it (descenders). */
export const PIXEL_ASCENT = 7;
export const PIXEL_DESCENT = 2;
/** Capital height in pixels. */
export const PIXEL_CAP = 5;
const FONT = `8px ${FAMILY}`;
// Coverage above this is the font's own pixel; below it, smoothing.
const THRESHOLD = 170;
// Wider than any Tiny5 glyph.
const MAX_ADVANCE = 16;

interface Glyph { advance: number; rows: number; bits: Uint8Array; }
const glyphs = new Map<string, Glyph>();
let sampler: CanvasRenderingContext2D | null = null;

/** Resolves once Tiny5 is loaded, so glyphs aren't sampled from a fallback font. */
export const loadPixelFont = () => document.fonts.load(FONT).then(() => document.fonts.check(FONT));

function glyph(ch: string): Glyph {
  const cached = glyphs.get(ch);
  if (cached) return cached;
  const rows = PIXEL_ASCENT + PIXEL_DESCENT;
  if (!sampler) {
    const canvas = document.createElement('canvas');
    canvas.width = MAX_ADVANCE;
    canvas.height = rows;
    sampler = canvas.getContext('2d', { willReadFrequently: true });
    if (!sampler) throw Error('2D canvas unavailable');
  }
  const g = sampler;
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  g.font = FONT;
  g.fontKerning = 'none';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  g.fillText(ch, 0, PIXEL_ASCENT);
  const advance = Math.min(MAX_ADVANCE, Math.round(g.measureText(ch).width));
  const data = g.getImageData(0, 0, MAX_ADVANCE, rows).data;
  const bits = new Uint8Array(advance * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < advance; x++) bits[y * advance + x] = data[(y * MAX_ADVANCE + x) * 4 + 3] > THRESHOLD ? 1 : 0;
  }
  const made = { advance, rows, bits };
  glyphs.set(ch, made);
  return made;
}

/** The text's width in pixels (the sum of its advances). */
export function pixelTextWidth(text: string) {
  let w = 0;
  for (const ch of text) w += glyph(ch).advance;
  return w;
}

/** Draws text with its baseline at y, starting at x (whole pixels: they are rounded). */
export function drawPixelText(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  let left = Math.round(x);
  const top = Math.round(y) - PIXEL_ASCENT;
  g.beginPath();
  for (const ch of text) {
    const { advance, rows, bits } = glyph(ch);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < advance; gx++) if (bits[gy * advance + gx]) g.rect(left + gx, top + gy, 1, 1);
    }
    left += advance;
  }
  g.fillStyle = color;
  g.fill();
}
