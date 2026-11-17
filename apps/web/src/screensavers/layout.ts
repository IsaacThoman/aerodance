// Controls occupy the lower edge so the selected scene is its own live preview.
export function screensaverLayout(width: number) {
  const x = width === 1200 ? 72 : 128;
  const cardWidth = (width - 2 * x - 24) / 2;
  return {
    SAVER_LIBRARY: { x: width - x - 240, y: 80, w: 240, h: 64 },
    saverScene: (i: number) => ({ x: x + (i % 2) * (cardWidth + 24), y: 210 + Math.floor(i / 2) * 134, w: cardWidth, h: 106 }),
    SAVER_BACK: { x: x + 30, y: 112, r: 30 },
    SAVER_PREV: { x: width - x - 125, y: 672, r: 32 },
    SAVER_NEXT: { x: width - x - 32, y: 672, r: 32 },
    SAVER_WATCH: { x, y: 750, w: 234, h: 82 },
    SAVER_VIEW: { x: x + 256, y: 750, w: 354, h: 82 },
    SAVER_CLOCK: { x: x + 632, y: 750, w: 294, h: 82 },
  };
}
