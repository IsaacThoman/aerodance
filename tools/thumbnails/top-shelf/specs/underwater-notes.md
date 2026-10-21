# Underwater concepts

All four use the actual reef/openreef stages, existing two glass dancers, and the game's own wordmark. `format` is intentionally omitted so each composition can be rendered at 8:3 and 29:9. Camera choices expand the field horizontally without cropping an existing 3:2 image.

- **`reef-glass-duet` — Glass duet.** An intimate interior with the duo grouped on the right, a stacked wordmark on the left, and the dome ribs and caustics carrying the composition across the banner. The lower, closer camera gives the characters roughly half the image height. The pair remains within the real dome floor.
- **`reef-dome-panorama` — An underwater dance hall.** An elevated, gently oblique view places the complete dome just right of center. The real tunnel travels to the left while the reef arch and marine life balance the right. The wordmark occupies the water above the crown. The expanded duet spacing and modest scale increase help the characters read inside the architecture.
- **`openreef-coral-garden` — Coral garden.** A nearer and much lower alternative to the old garden shot. The wider duet sits between the near coral fans, colorful bommies flank the frame, and the reef arch makes the right-hand horizon recognizable. The sand and caustics provide a softer lower edge.
- **`openreef-turtle-procession` — Dance with the current.** A left-biased duet and upper-left wordmark leave the right half for the swimming turtle and reef arch. At 21.5 seconds the actual turtle path puts it around `[14, 5.6, -9]`, separate from the foreground dancers. The low camera emphasizes the bright moving surface and gives the wildlife a second visual anchor.

The root renderer should inspect the first previews for dome ribs or jellyfish crossing faces; changing `time` moves marine life without changing the held dance pose. No custom geometry, stage changes, or synthetic imagery is needed.
