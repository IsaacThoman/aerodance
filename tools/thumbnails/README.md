# Thumbnails

27 thumbnails of six of the dance stages (all but `atrium`, which came later), each **with** the "aerodance." wordmark (`with-logo/`) and **without** it (`no-logo/`). All are **2160×1440 (3:2)** lossless PNGs, rendered in-engine from the real stages, dancers and post-processing in [`packages/stages`](../../packages/stages).

## Pixel perfect

The game draws a 640×480 buffer and shows it at 16:9, so each of its pixels is 4:3 wide. These thumbnails use that same pixel grid cropped to 3:2: a 540×480 buffer with the same pixel size and shape, the same bloom, grade and ACES tone mapping, and the same 4× MSAA. Each buffer pixel is written as an exact 4×3 block of the PNG, with no filtering, resampling or compression loss. You can check it: downsampling any image to 540×480 and back with nearest-neighbour gives the identical file.

The wordmark is the title screen's own (`drawTitle` in `apps/web/src/ui/draw.ts`, Inter 800/200), drawn at the title menu's scale into a buffer-sized canvas and composited with nearest filtering, exactly as the game's canvas UI draws it. Each `with-logo` image is the matching `no-logo` frame with the wordmark added on top.

## Shots

| Stage | Shots |
| --- | --- |
| `sanctuary` | `sanctuary-skyline` (wide over the terrace and city), `sanctuary-hero`, `sanctuary-canopy` (¾ right), `sanctuary-towers` (worm's-eye), `sanctuary-closeup` (blue) |
| `reef` | `reef-dome` (the dome from outside), `reef-hero`, `reef-inside` (low ¾ under the glass), `reef-crown` (worm's-eye up to the crown) |
| `openreef` | `openreef-garden` (wide), `openreef-hero`, `openreef-surface` (worm's-eye up to the surface), `openreef-turtle` (¾ right) |
| `falls` | `falls-valley` (wide over the falls and islands), `falls-meadow`, `falls-rainbow` (¾ right), `falls-cliffs` (¾ left), `falls-closeup` (purple) |
| `club` | `club-floor` (wide over the club and crowd), `club-dj`, `club-aquarium` (¾ right), `club-stage` (low, under the mirror ball) |
| `beach` | `beach-sunset` (wide), `beach-hero`, `beach-ball` (¾ left), `beach-palm` (¾ right), `beach-closeup` (purple) |

The dancers hold four moments of the capture: 3.1 s (purple's lunge), 5 s (blue's hands up), 9 s (reach) and 12.9 s (blue's wide arms). Club shots land just after a beat, when the lights peak.

## Render

From the repository root, after `npm ci`:

```sh
npm --prefix tools/thumbnails ci
node tools/thumbnails/scripts/render.ts                         # all shots, into this folder
node tools/thumbnails/scripts/render.ts --only club-dj,beach-hero
node tools/thumbnails/scripts/render.ts --spec my-shots.tson --out /tmp/thumbs   # one-off shots
```

It needs Google Chrome (driven headless by `playwright-core`, with GPU WebGL) and network access for the Inter font. Without Chrome, set `CHROMIUM_PATH` to another Chromium build, such as Playwright's `Google Chrome for Testing`. A full run takes under 2 minutes on an M3 Pro. Renders are deterministic: re-rendering on the same machine gives byte-identical files. A different GPU or driver may differ slightly.

## Apple TV icon

`--tv-icons` renders `TV_ICONS` (in `client/src/shots.ts`), the Apple TV app's layered 5:3 icon, into [`assets/tv-icon`](../../assets):

```sh
node tools/thumbnails/scripts/render.ts --tv-icons
```

A 5:3 shot uses the same pixel grid at 600×480. Its `layers` list the layers back to front. Each layer is the shot rendered with the camera's near plane at `near`, which cuts away the scenery in front of it, and with the dancers shown or hidden; hidden dancers still cast their shadows. Each layer keeps only the pixels it adds over the layer behind it:

- A layer that reaches nearer than the one behind keeps the pixels where anything lies between the two near planes. That depth range is rendered on its own and compared with an empty render at the same near plane, so depth precision matches and nothing flickers between the two.
- A layer at the same depth (the dancers appearing) keeps the pixels that differ from the layer behind. Its bloom spilling onto the layer behind, like the glints on the dancers' heads, is kept as partial alpha.

- A `seeThrough` layer (the dancers in the `-glass` icon) is drawn on its own instead: the dancers alone into a transparent half-float buffer, the scenery still hiding them where it's in front but drawing nothing, so the glass leaves its real alpha. That layer then gets the pipeline's grade and ACES by itself. It isn't blended with the scene before tone mapping as in the game, so the dancers come out a little deeper, and it has no bloom.

Both comparisons use renders without bloom, so a glow doesn't drag the background into the layer. The colours come from the normal render. The wordmark is the top layer, unless a `wordmark` entry in `layers` puts it lower, as the Apple TV icon's sits behind the dancer. `flat.png` is the layers stacked back together. A layer's `blur` softens it like a shallow depth of field, after it's resized, so every size looks the same. The back layer's `exposure` scales the camera exposure it's rendered with, before the grade and tone mapping, as for the dark sky app icon. A shot's `reflections` has the dancers reflect the scene around them, captured in-engine at the camera's target with them hidden, at that brightness, instead of the stage's environment map. Its `panels` add soft light panels to that capture alone, like a studio's softboxes, each at its own brightness in the reflections: the dark icon is lit with four. A `hidden` layer is rendered, so the layer above is cut against it, but left out of the icon. `dancerParts` limits a dancers layer to their bodies or their floating hands; the other part draws nothing but still casts its shadow. Stacked back together, the layers match the flat render to within one level in about 99% of pixels; the rest is bloom at the depth cuts and the wordmark's edges.

Apple's icon sizes (1280×768, 800×480, 400×240) aren't whole multiples of the buffer, so each layer is area-averaged to size with premultiplied alpha.

## Phone app icons

`--app-icons` renders the shots in `APP_ICONS` (in `client/src/shots.ts`), square app icons for the iPhone and iPad, into [`assets/app-icon`](../../assets):

```sh
node tools/thumbnails/scripts/render.ts --app-icons
```

A square shot uses the same pixel grid at 360×480. Each icon is `<id>.png`, 1024×1024, area-averaged from the buffer. An icon with `layers` is split like the TV icons and its layers go in `<id>/1024x1024/`, for a layered icon (Icon Composer on iOS); `<id>.png` is them stacked back together. It's opaque as the App Store wants when its back layer is, and transparent otherwise: `portrait-transparent-bg` leaves out the background, rendering the scenery only as a `hidden` layer for the see-through dancer to be cut against.

## Splash screens

`--splashes` renders the shots in `SPLASHES` (in `client/src/shots.ts`), 16:9 splash screens, into [`assets`](../../assets):

```sh
node tools/thumbnails/scripts/render.ts --splashes
```

A splash is the game's whole frame: the 640×480 buffer shown at 16:9, written as 2560×1440 in the same 4×3 blocks. Each is `<id>.png`, with the wordmark if the shot has one. They can stage a scene the game doesn't have. A shot's `figures` hand-pose the dancers instead of the capture (or leave one out), `room` builds a dingy back room's corner with a checkered floor and hanging cables, `hideStage` leaves the stage's own scenery out, and `lights`, `fog`, `background`, `environment` and `post` light and grade it. `overlay` lays a security camera's grain and scanlines over the finished frame, and the camera's `shift` slides the picture sideways without turning the camera, to leave room for the wordmark.

## Code

- `client/src/shots.ts`: the shot list, `TV_ICONS`, `APP_ICONS` and `SPLASHES`. Each shot has a stage, how long the stage plays before the capture (`time`), the dance-capture moment the dancers hold (`pose`), a camera, optional dancer placement, and the wordmark's position and size. Add or tweak a shot here and re-render it with `--only`.
- `client/src/App.tsx`: the capture page. It mounts one stage with the dancers, swaps in the shot's 3:2 camera for the stage's orbiting 16:9 one, steps the clock by hand at 60 fps to the shot's time (`frameloop="never"`), and reads back the frame with and without the wordmark. `?shot=<id>` opens a shot in the browser (`npx vite --config tools/thumbnails/vite.config.ts`, port 5179).
- `scripts/render.ts`: builds the page, drives Chrome, upscales each frame into exact 4×3 blocks and writes the PNGs with its own encoder.

The stages needed two small, backward-compatible changes to render at 3:2: `RenderPipeline` takes an optional buffer size and display aspect (`stages/shared/post.tsx`), and the sanctuary and beach lens flares follow the camera's aspect. The game always renders at the old defaults, so it looks the same as before.
