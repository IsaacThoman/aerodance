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

## Apple TV app icons

`tv-icon/` holds layered 5:3 app icons for Apple TV's parallax effect: `falls-meadow/` and `beach-hero/` (the shots above), `falls-closeup/`, `falls-closeup-soft/` (the same with the scenery in front of and behind the dancer out of focus), and `falls-sky-soft/` (the dancer against nothing but the soft sky, the wordmark centered beside her: `1-sky`, `2-logo`, `3-dancers`, `4-hands`, her floating hands on their own in front). Each has its layers, back to front, at the icon's three sizes, and the layers stacked back together for reference (`flat.png`):

| Folder | Size | Used for |
| --- | --- | --- |
| `1280x768/` | 1280×768 | App Store |
| `800x480/` | 800×480 | Home screen @2x |
| `400x240/` | 400×240 | Home screen @1x |

| Icon | Layers |
| --- | --- |
| `falls-meadow` | `1-sky` (the valley, falls and sky beyond the clifftop), `2-meadow`, `3-dancers`, `4-foreground` (the grass in front of the lens), `5-logo` |
| `beach-hero` | `1-sky` (the sun, clouds and horizon), `2-sea`, `3-beach` (the sand and the palm), `4-logo` (bigger, behind the dancers), `5-dancers` |
| `falls-closeup` | `1-sky`, `2-meadow`, `3-logo` (on two lines, much bigger, behind the dancer), `4-dancers` (the purple one, close up), `5-foreground` (the grass and planter in front of the lens) |

Each `-glass/` folder is the same icon with see-through dancers: their layer keeps the glass's real transparency, so the layers behind show through them as the icon tilts, instead of a copy of what was behind them in the shot. The dancers are tone-mapped on their own there, so they come out a little deeper than in the game, and without the bloom of their glints.

The back layer is opaque and the rest are transparent. Each layer is rendered in-engine with what's in front of it cut away, so the layers behind still hold the scene where the tilt uncovers it, and the dancers' shadows stay on the ground behind them. Drop a size's layers into Apple's Parallax Previewer to see the effect or export an `.lsr`, or into an Xcode image stack. Leave out the `logo` layer for an icon without the wordmark. The Apple TV app uses `falls-sky-soft-glass`.

To render them again:

```sh
node tools/thumbnails/scripts/render.ts --tv-icons
```
