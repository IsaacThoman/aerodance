# Top Shelf concepts

Twelve fresh in-engine compositions across all six stages. Every concept includes both banner shapes, with and without the game's own wordmark, at 1× and 2×: **96 lossless RGB PNGs**.

Open [the interactive gallery](index.html) to switch the shape and wordmark, compare compositions, and open or download full-resolution images. The JSON camera specs and composition notes live in [specs/](specs/).

| Folder | 1× | 2× |
| --- | --- | --- |
| `renders/standard/{with-logo,no-logo}/` | `<id>.png` · 1920×720 | `<id>@2x.png` · 3840×1440 |
| `renders/wide/{with-logo,no-logo}/` | `<id>.png` · 2320×720 | `<id>@2x.png` · 4640×1440 |

These are new camera renders, with the horizontal field of view expanded for each shape. They use the real procedural stages, captured dance poses, glass characters, bloom, grading, ACES tone mapping, and title drawing code. No image generation or cropped 16:9 screenshots are involved. The 2× masters use 960×480 / 1160×480 buffers and exact 4×3 pixel blocks, matching the existing promotional renders. The 1× companions take every second master pixel with nearest sampling; vertical pixel rows alternate between one and two output pixels, preserving crisp edges.

## Re-render

From the repository root, after `npm ci` and `npm --prefix tools/thumbnails ci`:

```sh
node tools/thumbnails/scripts/render.ts --top-shelf
node tools/thumbnails/scripts/render.ts --top-shelf --only meadow-duet,reef-glass-duet
node tools/thumbnails/scripts/render.ts --top-shelf --spec tools/thumbnails/top-shelf/specs/nature.json
node tools/thumbnails/scripts/gallery.ts
```

Use `CHROMIUM_PATH` to select a GPU-capable Chromium if Google Chrome is unavailable. On macOS, the renderer selects Metal for that Chromium; the log should identify an Apple GPU rather than SwiftShader. `--jobs` controls concurrent captures (default 2).

These are options for choosing artwork. They do not change the tvOS asset catalog or select a production Top Shelf image.
