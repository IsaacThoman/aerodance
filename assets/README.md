# Assets

Promotional images for Aerodance.

| File | What |
| --- | --- |
| `falls-meadow.png` | The `falls` stage from the meadow, with the "aerodance." wordmark. 2160×1440 (3:2). |
| `falls-meadow-no-logo.png` | The same frame without the wordmark. |
| `beach-hero.png` | The `beach` stage at sunset, with the wordmark. 2160×1440 (3:2). |
| `beach-hero-no-logo.png` | The same frame without the wordmark. |
| `splash1.png` | A golden glass dancer in a top hat, slumped against the wall of a dark back room, seen from a grainy security camera. 2560×1440 (16:9), no wordmark. |
| `splash1-logo.png` | The same view slid left, with the wordmark in the dark at the top right. 2560×1440 (16:9). |

Each pair is the shot of the same name from the [thumbnail renderer](../tools/thumbnails), rendered in-engine. To render one again:

```sh
node tools/thumbnails/scripts/render.ts --only falls-meadow --out /tmp/thumbs
cp /tmp/thumbs/with-logo/falls-meadow.png assets/falls-meadow.png
cp /tmp/thumbs/no-logo/falls-meadow.png assets/falls-meadow-no-logo.png
```

`splash1.png` and `splash1-logo.png` are the renderer's `SPLASHES`, rendered in-engine too. To render them again, straight into this folder:

```sh
node tools/thumbnails/scripts/render.ts --splashes
```

## Top Shelf banners

`top-shelf/` contains two selected in-engine banners with the "aerodance." wordmark:

| Image | Composition |
| --- | --- |
| `meadow-duet.png` | The selected waterfall meadow duet, unchanged. |
| `horizon-party.png` | The sunset beach duet, with blue holding one hand near his face and the other lower in front of his body. Purple keeps the original pose. |

| Folder | 1× (`<name>.png`) | 2× (`<name>@2x.png`) |
| --- | --- | --- |
| `top-shelf/standard/` | 1920×720 (8:3) | 3840×1440 |
| `top-shelf/wide/` | 2320×720 (29:9) | 4640×1440 |

Both shapes are separate camera renders with a 480-pixel internal height. The 2× PNGs preserve exact 4×3 pixel blocks; the 1× PNGs use nearest sampling. Meadow holds the dance capture at 3.1 seconds. Horizon Party holds blue at 9 seconds and purple at 5 seconds, with the beach scenery at 4.25 seconds. These were captured with temporary wide-format and per-dancer playback controls; those controls are not part of the checked-in renderer.

## Apple TV app icon

`tv-icon/falls-sky-soft-glass/` is the Apple TV app's layered 5:3 icon for the parallax effect: the purple dancer, close up, against nothing but the soft falls sky, with the wordmark centered beside her. Its layers, back to front, are at the icon's three sizes, with the layers stacked back together for reference (`flat.png`):

| Folder | Size | Used for |
| --- | --- | --- |
| `1280x768/` | 1280×768 | App Store |
| `800x480/` | 800×480 | Home screen @2x |
| `400x240/` | 400×240 | Home screen @1x |

| Layer | |
| --- | --- |
| `1-sky` | Only the sky, far clouds and haze, out of focus. Opaque |
| `2-logo` | The wordmark on two lines |
| `3-dancers` | The dancer's head, body and feet |
| `4-hands` | Her floating hands on their own, in front for more depth |

The dancer is see-through: her layers keep the glass's real transparency, so the layers behind show through her as the icon tilts. She's tone-mapped on her own there, so she comes out a little deeper than in the game, and without the bloom of her glints. Each layer is rendered in-engine. Drop a size's layers into Apple's Parallax Previewer to see the effect or export an `.lsr`, or into an Xcode image stack. `scripts/tvos.ts` builds the app's image stacks from it. To render it again:

```sh
node tools/thumbnails/scripts/render.ts --tv-icons
```

## Phone app icons

`app-icon/aerodance.icon` is the iPhone and iPad app's icon, an Icon Composer document that `apps/ios/project.yml` builds into the app. Open it in Icon Composer to change it. It's made of the renders below: the light look is `portrait-purple-sky-glass`'s layers (its dancer layers carry `portrait-transparent-bg`'s names, as they're the same images), with `portrait-dark-sky-glass`'s behind them. The dark look hides the purple-sky layers to show the dark ones, and the tinted look hides only the purple sky. `1-sky.png`, `2-dancers.png` and `3-hands.png` beside it are copies of the dark layers.

`app-icon/` also holds those renders, made in-engine like the Apple TV icon: `portrait-purple-sky-glass.png` (1024×1024, opaque), the purple dancer's head close up against the Apple TV icon's soft sky, with her see-through glass. Its layers, back to front, are in `portrait-purple-sky-glass/1024x1024/`: `1-sky` (opaque), `2-dancers` (her head, body and feet) and `3-hands` (her floating hands on their own), for a layered icon in Icon Composer.

`portrait-dark-sky-glass.png` is the same icon on a near-black sky: the same sky rendered in-engine with a fiftieth of the light, so it still darkens towards the top and the haze, from about `#02050f` to `#0d1113`. Its layers are in `portrait-dark-sky-glass/1024x1024/`. Her glass reflects that dark scene (captured in-engine from where she stands, at twice the sky's brightness) instead of the stage's bright daytime environment map, plus four soft light panels like a studio's softboxes: a strip above and behind for a rim, a broad one overhead, a key light in front to her left, and a faint fill below. They only exist in her reflections. Her own purple glow from below stays the brightest part of her.

`portrait-transparent-bg.png` is the same dancer with no background: transparent, for putting on a background of your own, so it can't be the App Store icon as it is. Its layers are the same `1-dancers` and `2-hands`, in `portrait-transparent-bg/1024x1024/`, each keeping the glass's partial transparency (about 85% opaque). To render them again:

```sh
node tools/thumbnails/scripts/render.ts --app-icons
```
