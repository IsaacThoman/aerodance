/** Wii-style display modes: a fixed 480-line buffer with standard or anamorphic output.
 * Widescreen changes the projection and layout, not the number of rendered pixels.
 */
export const RENDER_SIZE = { w: 640, h: 480 };
export const DISPLAY_MODES = {
  standard: { aspect: 4 / 3, w: 1200, h: 900 },
  widescreen: { aspect: 16 / 9, w: 1600, h: 900 },
} as const;
export type DisplayMode = keyof typeof DISPLAY_MODES;

// Maximise the area of the fitted frame. The two modes fill equal areas at the
// geometric mean of their aspect ratios (about 1.54), rather than at 16:9.
export function displayModeFor(width: number, height: number): DisplayMode {
  return width / Math.max(1, height) >= Math.sqrt(DISPLAY_MODES.standard.aspect * DISPLAY_MODES.widescreen.aspect)
    ? 'widescreen' : 'standard';
}

export function displayDesign(width: number, height: number) {
  return DISPLAY_MODES[displayModeFor(width, height)];
}
