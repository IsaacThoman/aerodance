# Dance stages

Nine procedural stages inspired by Frutiger Aero, used for the song preview, gameplay and results screens, and by Dance Studio and the thumbnail renderer. Everything is generated (geometry, shaders, canvas textures); the only asset files are the character GLB and capture in `packages/character`.

| Id | Kind | Highlights |
| --- | --- | --- |
| `sanctuary` | city | Rooftop sky-garden terrace over a glass eco-city: infinity pool, solar canopy, wind flowers, ~150 towers, monorail loops, airship with a beat-synced screen, balloons, eco-pods, gulls, sailboats on the river |
| `reef` | water | Glass dome on a sunlit reef: caustics, light shafts, coral gardens, eight fish species in schools, dolphins, sea turtle, manta, jellyfish, bubble columns, glass tunnel |
| `openreef` | water | The `reef` stage without the dome: the dancers stand on open sand among the coral, fish, dolphins, turtle, manta, jellyfish and light shafts. The default stage. |
| `falls` | landscape | Clifftop meadow over a turquoise lake: eight waterfalls with mist and a rainbow, floating islands, wind-swept grass and wildflowers, solar-flower sculptures, turbines, observatory cable car, balloons, butterflies, birds |
| `club` | dance club | Beat-driven LED floor, aquarium walls, curved video wall, mirror ball, moving heads and lasers, DJ blob, speaker stacks, bar, a crowd of bobbing gel blobs, confetti |
| `beach` | beach | Golden-hour beach with open ocean to the horizon: sun path on the waves, a coconut palm, tiki torches, sailboats, cruise ship, leaping dolphins, gulls |
| `orbit` | space | Glossy white-and-glass deck on a station high over a ray-traced blue planet at sunrise: the sun cresting the limb with a lens flare, ocean glint and drifting clouds, beat-pulsing LED rings, glass floor windows, solar wings, a turning habitat ring, satellites trailing light, a shuttle, camera drones, the Moon |
| `orbitnight` | space | The `orbit` stage over the night side: city lights, aurora curtains along the limb, meteors, a bright Moon, the deck's LEDs as the main light |
| `orbitdome` | space | The `orbit` stage's deck under a ribbed iridescent glass dome: a ring of planters with round trees, ferns and flowers, grow lights, drifting seed-puffs |

## Layout

- `catalog.ts`: the stages as plain data (each folder's `meta.ts`: name card text, accent colors, dancer placement, post settings), with no rendering code, so Node, Dance Studio and song catalogs can import it.
- `index.ts`: pairs each meta with its lazily loaded `<Name>Stage.tsx`, so only the visible stage is fetched and one broken stage can't take down the others.
- `shared/`:
  - `hooks.ts`: `StageCamera` (16:9 projection with slow orbit, sway and pointer parallax), a steady 118 bpm beat clock for light pulses, and disposal helpers.
  - `Environment.tsx`: PMREM reflections; the glass dancers get most of their look from these.
  - `post.tsx`: stage → UnrealBloom → vignette/saturation grade → ACES. Bloom works on linear HDR, so each stage sets a threshold above its lit surfaces.
  - `Dancers.tsx`, `DancerEntrance.tsx`: the dancers on the stage floor.
  - `hud.tsx`: the in-engine name card and veil.
  - `Sky.tsx`: sky dome and cloud billboards.
  - `glsl.ts`, `random.ts`: GLSL noise and seeded randomness.

In development, `window.__aeroStats` reports draw calls and triangles. At the last measurement the stages used 69–134 draw calls and 0.19–0.83M triangles each, including the dancers.
