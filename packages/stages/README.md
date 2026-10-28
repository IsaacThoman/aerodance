# Dance stages

Seven procedural stages inspired by Frutiger Aero, used for the song preview, gameplay and results screens, and by Dance Studio and the thumbnail renderer. Everything is generated (geometry, shaders, canvas textures); the only asset files are the character GLB and capture in `packages/character`.

| Id | Kind | Highlights |
| --- | --- | --- |
| `sanctuary` | city | Rooftop sky-garden terrace over a glass eco-city: infinity pool, solar canopy, wind flowers, ~150 towers, monorail loops, airship with a beat-synced screen, balloons, eco-pods, gulls, sailboats on the river |
| `reef` | water | Glass dome on a sunlit reef: caustics, light shafts, coral gardens, eight fish species in schools, dolphins, sea turtle, manta, jellyfish, bubble columns, glass tunnel |
| `openreef` | water | The `reef` stage without the dome: the dancers stand on open sand among the coral, fish, dolphins, turtle, manta, jellyfish and light shafts. The default stage. |
| `falls` | landscape | Clifftop meadow over a turquoise lake: eight waterfalls with mist and a rainbow, floating islands, wind-swept grass and wildflowers, solar-flower sculptures, turbines, observatory cable car, balloons, butterflies, birds |
| `club` | dance club | Beat-driven LED floor, aquarium walls, curved video wall, mirror ball, moving heads and lasers, DJ blob, speaker stacks, bar, a crowd of bobbing gel blobs, confetti |
| `beach` | beach | Golden-hour beach with open ocean to the horizon: sun path on the waves, a coconut palm, tiki torches, sailboats, cruise ship, leaping dolphins, gulls |
| `atrium` | indoor garden | The Atrium menu backdrop's sunlit eco-tech atrium, seen from its entrance: the dancers on the stone floor in front of the reflecting pool, the aquarium column rising behind them under the ribbed dome, trees, balconies trailing vines, palms by the glass wall, a maglev outside. Built in metres, so its dancers are scaled to life size |

## Layout

- `catalog.ts`: the stages as plain data (each folder's `meta.ts`: name card text, accent colors, dancer placement, post settings), with no rendering code, so Node, Dance Studio and song catalogs can import it.
- `index.ts`: pairs each meta with its lazily loaded `<Name>Stage.tsx`, so only the visible stage is fetched and one broken stage can't take down the others.
- `atrium/`: the room is shared with the Atrium menu backdrop (`packages/backdrops/atrium`), which shows it from its own camera without the dancers. `Atrium.tsx` is the room for any scene that brings its own camera and clock; each scene makes its own uniforms (`makeAtriumUniforms`) and moves its `uTime` on, as the two can be mounted at once.
- `shared/`:
  - `hooks.ts`: `StageCamera` (16:9 projection with slow orbit, sway and pointer parallax), a steady 118 bpm beat clock for light pulses, and disposal helpers. `cameraPilot` lets [walk mode](../../docs/walk-mode.md) fly whichever stage or backdrop camera is live.
  - `Environment.tsx`: PMREM reflections; the glass dancers get most of their look from these.
  - `post.tsx`: stage → UnrealBloom → vignette/saturation grade → ACES. Bloom works on linear HDR, so each stage sets a threshold above its lit surfaces.
  - `Dancers.tsx`, `DancerEntrance.tsx`: the dancers on the stage floor.
  - `hud.tsx`: the in-engine name card and veil.
  - `Sky.tsx`: sky dome and cloud billboards.
  - `glsl.ts`, `random.ts`: GLSL noise and seeded randomness.

In development, `window.__aeroStats` reports draw calls and triangles. At the last measurement the stages used 69–134 draw calls and 0.19–0.83M triangles each, including the dancers. `atrium`, measured later in the song preview on an Apple M5 Pro, used 56–72 draw calls, 0.19–0.26M triangles and about 3 ms of GPU time, against 60, 0.47M and 2.7 ms for `openreef`.
