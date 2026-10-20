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
