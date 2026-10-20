# Assets

Promotional images for Aerodance.

| File | What |
| --- | --- |
| `falls-meadow.png` | The `falls` stage from the meadow, with the "aerodance." wordmark. 2160×1440 (3:2). |
| `falls-meadow-no-logo.png` | The same frame without the wordmark. |
| `beach-hero.png` | The `beach` stage at sunset, with the wordmark. 2160×1440 (3:2). |
| `beach-hero-no-logo.png` | The same frame without the wordmark. |

Each pair is the shot of the same name from the [thumbnail renderer](../tools/thumbnails), rendered in-engine. To render one again:

```sh
node tools/thumbnails/scripts/render.ts --only falls-meadow --out /tmp/thumbs
cp /tmp/thumbs/with-logo/falls-meadow.png assets/falls-meadow.png
cp /tmp/thumbs/no-logo/falls-meadow.png assets/falls-meadow-no-logo.png
```

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

`app-icon/` holds the iPhone and iPad app icons, rendered in-engine like the Apple TV one: `portrait-purple-sky-glass.png` (1024×1024, opaque), the purple dancer's head close up against the Apple TV icon's soft sky, with her see-through glass. Its layers, back to front, are in `portrait-purple-sky-glass/1024x1024/`: `1-sky` (opaque), `2-dancers` (her head, body and feet) and `3-hands` (her floating hands on their own), for a layered icon in Icon Composer.

`portrait-dark-sky-glass.png` is the same icon on a near-black sky: the same sky rendered in-engine with a fiftieth of the light, so it still darkens towards the top and the haze, from about `#02050f` to `#0d1113`. Its layers are in `portrait-dark-sky-glass/1024x1024/`. Her glass reflects that scene just as dark (captured in-engine from where she stands, instead of the stage's daytime environment map), so she has no bright rim: her own glow and the scene's lights' highlights carry her.

`portrait-transparent-bg.png` is the same dancer with no background: transparent, for putting on a background of your own, so it can't be the App Store icon as it is. Its layers are the same `1-dancers` and `2-hands`, in `portrait-transparent-bg/1024x1024/`, each keeping the glass's partial transparency (about 85% opaque). To render them again:

```sh
node tools/thumbnails/scripts/render.ts --app-icons
```
