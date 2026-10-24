// Keep a little spare capacity for hover/press motion. Reclaim larger excess when a
// panel closes, so visiting Settings doesn't leave the main menu copying a panel-sized area.
const BLOCK = 16;
const MOTION_SLACK = 4;

function extent(needed: number, available: number, previous: number) {
  const retained = Math.min(previous, available);
  if (retained >= needed && retained - needed < BLOCK * 2) return retained;
  return Math.min(available, Math.ceil((needed + MOTION_SLACK) / BLOCK) * BLOCK);
}

/** Reusable framebuffer texture capacity, always contained by the drawing buffer. */
export function glassTextureSize(w: number, h: number, bufferW: number, bufferH: number, previousW = 0, previousH = 0) {
  return { w: extent(w, bufferW, previousW), h: extent(h, bufferH, previousH) };
}
